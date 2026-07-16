const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  cleanClipTags,
  cleanString,
  dimensionsFromImage,
  extensionForAsset,
  extractPageMetadata,
  normalizeClipUrl,
  normalizeOptionalHttpUrl,
  sourcePlatformForHost,
} = require("./lib/clip-metadata");
const { CatalogValidationError } = require("./lib/catalog/bootstrap");
const { loadCatalog } = require("./lib/catalog/loader");
const { SearchValidationError, searchCatalog } = require("./lib/search");
const { CatalogResolverError, resolveCatalogSelectors } = require("./lib/catalog/resolver");
const {
  BoardError,
  addBoardItem,
  createBoard,
  deleteBoard,
  exportBoard,
  getBoardDetail,
  listBoards,
  removeBoardItem,
  reorderBoardItems,
  updateBoard,
  updateCurationNote,
  validateBoardMutationRequest,
} = require("./lib/catalog/boards");
const {
  ReviewQueueError,
  listReviewEntries,
  manualNotesBrowserPayload,
  manualNotesPayload: readManualNotesPayload,
  mutateManualNote,
  reconcileReviewState,
  transition,
} = require("./lib/catalog/review-queue");

const PORT = Number(process.env.PORT || process.env.GRID_PORT || 3000);
const HOST = process.env.GRID_HOST || "127.0.0.1";
const MANUAL_NOTES_PATH = path.resolve(process.env.MANUAL_NOTES_PATH || path.join(__dirname, "manual-media-notes.json"));
const MANUAL_NOTES_BODY_LIMIT = 24 * 1024;
const SEARCH_BODY_LIMIT = 16 * 1024;
const REVIEW_BODY_LIMIT = 32 * 1024;
const CATALOG_RESOLVE_BODY_LIMIT = 32 * 1024;
const BOARDS_BODY_LIMIT = 64 * 1024;
const WEB_CLIPS_PATH = path.resolve(process.env.WEB_CLIPS_PATH || path.join(__dirname, "web-clips.json"));
const INSPIRATION_INDEX_PATH = path.resolve(
  process.env.INSPIRATION_INDEX_PATH || path.join(__dirname, "inspiration-index.json")
);
const METADATA_REVIEW_PATH = path.resolve(process.env.METADATA_REVIEW_PATH || path.join(__dirname, "metadata-review.json"));
const METADATA_REVIEW_LOCK_PATH = path.resolve(process.env.METADATA_REVIEW_LOCK_PATH || `${METADATA_REVIEW_PATH.replace(/\.json$/i, "")}.lock`);
const CLIP_ASSETS_DIR = path.resolve(process.env.CLIP_ASSETS_DIR || path.join(__dirname, "assets", "clips"));
const CLIP_ASSETS_PUBLIC_PATH = process.env.CLIP_ASSETS_PUBLIC_PATH || "/assets/clips";
const BOARDS_PATH = path.resolve(process.env.BOARDS_PATH || path.join(__dirname, "boards.json"));
const BOARDS_LOCK_PATH = path.resolve(process.env.BOARDS_LOCK_PATH || `${BOARDS_PATH.replace(/\.json$/i, "")}.lock`);
const CLIP_BODY_LIMIT = 32 * 1024;
const HTML_FETCH_LIMIT = 2 * 1024 * 1024;
const IMAGE_FETCH_LIMIT = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12000;
const GRID_FIXTURE_MODE = String(process.env.GRID_FIXTURE_MODE || "").trim();
const CATALOG_ROOT_DIR = path.resolve(process.env.GRID_CATALOG_ROOT || __dirname);
const FIXTURE_DATA_PATHS = {
  "bookmarks-data.json": process.env.BOOKMARKS_DATA_PATH ? path.resolve(process.env.BOOKMARKS_DATA_PATH) : "",
  "media-cards-clean.json": process.env.MEDIA_CARDS_PATH ? path.resolve(process.env.MEDIA_CARDS_PATH) : "",
};
const SAMPLE_FALLBACKS = new Map([
  ["bookmarks-data.json", "bookmarks-data.sample.json"],
  ["media-cards-clean.json", "media-cards.sample.json"],
]);

if (GRID_FIXTURE_MODE && GRID_FIXTURE_MODE !== "sample") {
  throw new Error("GRID_FIXTURE_MODE must be 'sample' when configured.");
}

if (GRID_FIXTURE_MODE === "sample" && Object.values(FIXTURE_DATA_PATHS).some((value) => !value)) {
  throw new Error("Sample fixture mode requires BOOKMARKS_DATA_PATH and MEDIA_CARDS_PATH.");
}
const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};
const API_CORS_BASE_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};
const ALLOWED_API_EXTENSION_ORIGINS = new Set([
  ...envList(process.env.ALLOWED_EXTENSION_ORIGINS)
    .map(normalizeChromeExtensionOrigin)
    .filter(Boolean),
  ...envList(process.env.ALLOWED_CHROME_EXTENSION_IDS)
    .map(chromeExtensionOriginFromId)
    .filter(Boolean),
]);
const ALLOWED_API_HTTP_ORIGINS = new Set(
  envList(process.env.ALLOWED_API_ORIGINS)
    .map(normalizeHttpOrigin)
    .filter(Boolean)
);

const ALLOWED_NODE_MODULE_FILES = new Set([
  path.normalize("node_modules/motion/dist/motion.js"),
  path.normalize("node_modules/@web-kits/audio/dist/index.js"),
]);

const ALLOWED_STATIC_FILES = new Set([
  "index.html",
  "style.css",
  "app.js",
  "audio-feedback.js",
  "url-contract.js",
  "browser-loader.js",
  "board-history.js",
  "board-repair.js",
  "bookmarks-data.json",
  "bookmarks-data.sample.json",
  "media-cards-clean.json",
  "media-cards.sample.json",
]);

const ALLOWED_CLIP_ASSET_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico"]);
const PRIVATE_GENERATED_FILES = [MANUAL_NOTES_PATH, WEB_CLIPS_PATH, INSPIRATION_INDEX_PATH, METADATA_REVIEW_PATH, BOARDS_PATH];

function decodePathname(pathname) {
  let decoded = pathname;
  for (let i = 0; i < 4; i++) {
    const next = decodeURIComponent(decoded);
    if (next === decoded) return decoded;
    decoded = next;
  }
  return decoded;
}

function decodeBoardPathname(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new BoardError("Board request is invalid.", "invalid_board_request");
  }
  if (
    decoded.includes("%") ||
    decoded.includes("\\") ||
    decoded.split("/").length !== pathname.split("/").length
  ) {
    throw new BoardError("Board request is invalid.", "invalid_board_request");
  }
  return decoded;
}

function boardRouteId(segment) {
  if (!segment || segment.includes("%")) throw new BoardError("Board request is invalid.", "invalid_board_request");
  return segment;
}

function hasDotPathSegment(normalizedPath) {
  return normalizedPath.split(path.sep).some((segment) => segment.startsWith("."));
}

function envList(value) {
  return String(value || "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeChromeExtensionOrigin(origin) {
  try {
    const parsed = new URL(String(origin || "").trim());
    if (
      parsed.protocol !== "chrome-extension:" ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      (parsed.pathname && parsed.pathname !== "/") ||
      parsed.search ||
      parsed.hash
    ) {
      return "";
    }
    return `chrome-extension://${parsed.hostname}`;
  } catch {
    return "";
  }
}

function chromeExtensionOriginFromId(id) {
  const cleanId = String(id || "").trim().replace(/^chrome-extension:\/\//i, "").replace(/\/.*$/, "");
  if (!cleanId) return "";
  return normalizeChromeExtensionOrigin(`chrome-extension://${cleanId}`);
}

function normalizeHttpOrigin(origin) {
  try {
    const parsed = new URL(String(origin || "").trim());
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      (parsed.pathname && parsed.pathname !== "/") ||
      parsed.search ||
      parsed.hash
    ) {
      return "";
    }
    return parsed.origin;
  } catch {
    return "";
  }
}

function isLoopbackHostname(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function isSameLocalServerOrigin(origin, req) {
  const normalizedOrigin = normalizeHttpOrigin(origin);
  if (!normalizedOrigin || !req.headers.host) return false;

  try {
    const parsedOrigin = new URL(normalizedOrigin);
    const requestOrigin = new URL(`http://${req.headers.host}`);
    const originPort = parsedOrigin.port || "80";
    const requestPort = requestOrigin.port || "80";
    return (
      parsedOrigin.protocol === "http:" &&
      isLoopbackHostname(parsedOrigin.hostname) &&
      isLoopbackHostname(requestOrigin.hostname) &&
      originPort === requestPort
    );
  } catch {
    return false;
  }
}

function isAllowedApiOrigin(origin, req) {
  if (!origin) return true;

  const extensionOrigin = normalizeChromeExtensionOrigin(origin);
  if (extensionOrigin) return ALLOWED_API_EXTENSION_ORIGINS.has(extensionOrigin);

  const httpOrigin = normalizeHttpOrigin(origin);
  return ALLOWED_API_HTTP_ORIGINS.has(httpOrigin) || isSameLocalServerOrigin(httpOrigin, req);
}

function apiCorsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return API_CORS_BASE_HEADERS;
  if (!isAllowedApiOrigin(origin, req)) return null;
  return {
    ...API_CORS_BASE_HEADERS,
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
  };
}

function isAllowedStaticPath(normalizedPath) {
  if (normalizedPath.includes("\0")) return false;
  if (hasDotPathSegment(normalizedPath)) return false;
  if (ALLOWED_STATIC_FILES.has(normalizedPath)) return true;
  if (normalizedPath.startsWith(`assets${path.sep}`)) {
    const segments = normalizedPath.split(path.sep);
    return segments.length === 2 && path.extname(normalizedPath) === ".svg";
  }
  if (normalizedPath === "node_modules" || normalizedPath.startsWith(`node_modules${path.sep}`)) {
    return ALLOWED_NODE_MODULE_FILES.has(normalizedPath);
  }
  return false;
}

function pathContains(ancestor, candidate) {
  const relative = path.relative(ancestor, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function privateGeneratedStatePath(filePath) {
  const candidate = path.resolve(filePath);
  if (PRIVATE_GENERATED_FILES.includes(candidate)) return true;
  if (
    candidate.startsWith(`${MANUAL_NOTES_PATH}.tmp-`) ||
    candidate.startsWith(`${INSPIRATION_INDEX_PATH}.tmp-`) ||
    candidate.startsWith(`${METADATA_REVIEW_PATH}.tmp-`) ||
    candidate.startsWith(`${BOARDS_PATH}.tmp-`)
  ) return true;

  if (candidate.startsWith(`${WEB_CLIPS_PATH}.tmp-`)) return true;

  return pathContains(METADATA_REVIEW_LOCK_PATH, candidate) ||
    candidate.startsWith(`${METADATA_REVIEW_LOCK_PATH}.tmp-`) ||
    candidate.startsWith(`${METADATA_REVIEW_LOCK_PATH}.stale-`) ||
    pathContains(BOARDS_LOCK_PATH, candidate) ||
    candidate.startsWith(`${BOARDS_LOCK_PATH}.tmp-`) ||
    candidate.startsWith(`${BOARDS_LOCK_PATH}.stale-`);
}

function addPrivateStateTree(candidate, paths, visited = new Set()) {
  if (visited.has(candidate)) return;
  visited.add(candidate);
  paths.add(candidate);
  let stat;
  try { stat = fs.lstatSync(candidate); } catch { return; }
  if (!stat.isDirectory()) return;
  try {
    for (const name of fs.readdirSync(candidate)) addPrivateStateTree(path.join(candidate, name), paths, visited);
  } catch {
    // A disappearing owner record remains protected through the enclosing private directory.
  }
}

function deniedStaticPaths() {
  const paths = new Set();
  for (const candidate of PRIVATE_GENERATED_FILES) addPrivateStateTree(candidate, paths);
  for (const directory of new Set([
    ...PRIVATE_GENERATED_FILES.map((candidate) => path.dirname(candidate)),
    path.dirname(METADATA_REVIEW_LOCK_PATH),
    path.dirname(BOARDS_LOCK_PATH),
  ])) {
    try {
      for (const name of fs.readdirSync(directory)) {
        const candidate = path.join(directory, name);
        if (privateGeneratedStatePath(candidate)) addPrivateStateTree(candidate, paths);
      }
    } catch {
      // Missing or unreadable private-state directories remain unavailable through their direct paths.
    }
  }
  return [...paths];
}

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function deniedStaticTarget(resolvedPath, targetStat) {
  if (privateGeneratedStatePath(resolvedPath)) return true;
  if (!targetStat) {
    try { targetStat = fs.statSync(resolvedPath); } catch { return true; }
  }
  return deniedStaticPaths().some((candidate) => {
    try { return sameInode(targetStat, fs.statSync(candidate)); } catch { return false; }
  });
}

function resolvedStaticTarget(targetPath, allowedRoot) {
  let resolvedTarget;
  let resolvedRoot;
  try {
    resolvedTarget = fs.realpathSync.native(targetPath);
    resolvedRoot = fs.realpathSync.native(allowedRoot);
  } catch {
    return null;
  }
  if (!pathContains(resolvedRoot, resolvedTarget) || deniedStaticTarget(resolvedTarget)) return false;
  return resolvedTarget;
}

function sendForbidden(res) {
  res.writeHead(403);
  res.end("Forbidden");
}

function sendStaticFile(res, targetPath, { allowedRoot, onMissing, headers = {} } = {}) {
  const resolvedTarget = resolvedStaticTarget(targetPath, allowedRoot || path.dirname(targetPath));
  if (resolvedTarget === null) {
    if (onMissing) {
      onMissing();
      return;
    }
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  if (!resolvedTarget) {
    sendForbidden(res);
    return;
  }
  fs.open(resolvedTarget, "r", (openError, descriptor) => {
    if (openError) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const close = (respond) => fs.close(descriptor, respond);
    fs.fstat(descriptor, (statError, stat) => {
      if (statError || deniedStaticTarget(resolvedTarget, stat)) {
        close(() => sendForbidden(res));
        return;
      }
      fs.readFile(descriptor, (readError, data) => {
        close(() => {
          if (readError) {
            res.writeHead(404);
            res.end("Not found");
            return;
          }
          res.writeHead(200, { ...headers, "Content-Type": MIME[path.extname(targetPath)] || "application/octet-stream" });
          return res.end(data);
        });
      });
    });
  });
}

function fixtureStaticTarget(normalizedPath) {
  if (GRID_FIXTURE_MODE !== "sample") return null;
  const fixturePath = FIXTURE_DATA_PATHS[normalizedPath];
  if (!fixturePath) return null;
  return {
    path: fixturePath,
    allowedRoot: path.dirname(fixturePath),
    headers: { "X-Visual-Grid-Fixture": "sample" },
  };
}

function tryServeClipAsset(pathname, res) {
  const publicPath = CLIP_ASSETS_PUBLIC_PATH.replace(/\/+$/, "") || "/assets/clips";
  if (pathname !== publicPath && !pathname.startsWith(`${publicPath}/`)) return false;

  const requestPath = pathname.slice(publicPath.length).replace(/^\/+/, "");
  const normalizedPath = path.normalize(requestPath);
  if (
    !normalizedPath ||
    normalizedPath.includes("\0") ||
    normalizedPath.startsWith("..") ||
    hasDotPathSegment(normalizedPath) ||
    !ALLOWED_CLIP_ASSET_EXTENSIONS.has(path.extname(normalizedPath))
  ) {
    sendForbidden(res);
    return true;
  }

  const rootDir = path.resolve(CLIP_ASSETS_DIR);
  const filePath = path.resolve(rootDir, normalizedPath);
  if (filePath === rootDir || !filePath.startsWith(`${rootDir}${path.sep}`)) {
    sendForbidden(res);
    return true;
  }

  sendStaticFile(res, filePath, { allowedRoot: rootDir });
  return true;
}

function sendJson(req, res, status, payload, extraHeaders = {}) {
  const corsHeaders = apiCorsHeaders(req);
  if (!corsHeaders) {
    res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: false, error: "Origin not allowed." }, null, 2));
    return;
  }

  res.writeHead(status, {
    ...corsHeaders,
    ...extraHeaders,
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function writeJsonFileAtomic(filePath, payload) {
  const dir = path.dirname(filePath);
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  fs.mkdirSync(dir, { recursive: true });
  let tempPath = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
    try {
      fs.writeFileSync(tempPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (error.code === "EEXIST" && attempt < 7) continue;
      throw error;
    }
  }
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw error;
  }
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function readRequestBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers["content-length"] || 0);
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
      req.resume();
      reject(new HttpError(413, "Request body too large."));
      return;
    }

    const chunks = [];
    let size = 0;
    let settled = false;

    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on("data", (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) {
        chunks.length = 0;
        rejectOnce(new HttpError(413, "Request body too large."));
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("aborted", () => rejectOnce(new HttpError(400, "Request was interrupted.")));
    req.on("error", (error) => rejectOnce(new HttpError(400, error.message || "Could not read request body.")));
  });
}

async function readJsonRequest(req, limit) {
  const body = await readRequestBody(req, limit);
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new HttpError(400, "Request body must contain valid JSON.");
  }
}

async function fetchBufferWithLimit(url, { limit, accept }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "VisualBookmarksGridClipper/1.0",
        "Accept": accept || "*/*",
      },
    });
    if (!response.ok) throw new Error(`Fetch failed with ${response.status}`);

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > limit) throw new Error("Response is too large.");

    const chunks = [];
    let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        size += chunk.length;
        if (size > limit) {
          await reader.cancel().catch(() => {});
          throw new Error("Response is too large.");
        }
        chunks.push(chunk);
      }
    }
    const buffer = Buffer.concat(chunks, size);

    return {
      buffer,
      contentType: response.headers.get("content-type") || "",
      finalUrl: response.url || url,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function clipAssetPublicUrl(clipId, filename) {
  return `${CLIP_ASSETS_PUBLIC_PATH.replace(/\/$/, "")}/${clipId}/${filename}`;
}

async function saveRemoteAsset(sourceUrl, clipId, label) {
  if (!sourceUrl) return null;
  const fetched = await fetchBufferWithLimit(sourceUrl, {
    limit: IMAGE_FETCH_LIMIT,
    accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml,image/*;q=0.8,*/*;q=0.5",
  });
  if (fetched.contentType && !fetched.contentType.toLowerCase().startsWith("image/")) {
    throw new Error("Fetched asset is not an image.");
  }

  const ext = extensionForAsset(fetched.contentType, fetched.finalUrl);
  const filename = `${label}${ext}`;
  const dir = path.join(CLIP_ASSETS_DIR, clipId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), fetched.buffer);
  const dimensions = dimensionsFromImage(fetched.buffer, fetched.contentType);

  return {
    url: clipAssetPublicUrl(clipId, filename),
    sourceUrl: fetched.finalUrl,
    width: dimensions.width,
    height: dimensions.height,
    contentType: fetched.contentType,
  };
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function writeFallbackClipImage(clipId, metadata) {
  const dir = path.join(CLIP_ASSETS_DIR, clipId);
  fs.mkdirSync(dir, { recursive: true });
  const filename = "image.svg";
  const title = escapeXml(metadata.title || metadata.siteName || metadata.host || "Saved inspiration");
  const site = escapeXml(metadata.siteName || metadata.host || "Web");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
  <rect width="1200" height="900" fill="#111111"/>
  <rect x="72" y="72" width="1056" height="756" rx="56" fill="#1d1d1d" stroke="rgba(255,255,255,.12)"/>
  <text x="112" y="156" fill="rgba(255,255,255,.52)" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="34" font-weight="600">${site}</text>
  <foreignObject x="112" y="230" width="976" height="420">
    <div xmlns="http://www.w3.org/1999/xhtml" style="font: 700 72px/1.08 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; color: white; word-wrap: break-word;">${title}</div>
  </foreignObject>
</svg>`;
  fs.writeFileSync(path.join(dir, filename), svg, "utf8");
  return {
    url: clipAssetPublicUrl(clipId, filename),
    sourceUrl: "",
    width: 1200,
    height: 900,
    contentType: "image/svg+xml",
    fallback: "generated",
  };
}

function webClipsPayload() {
  const payload = readJsonFile(WEB_CLIPS_PATH, {
    generatedAt: null,
    source: "visual-bookmarks-grid local web clips",
    clips: [],
  });

  if (!payload || typeof payload !== "object") return { generatedAt: null, source: "visual-bookmarks-grid local web clips", clips: [] };
  if (!Array.isArray(payload.clips)) payload.clips = [];
  payload.source ||= "visual-bookmarks-grid local web clips";
  return payload;
}

async function captureWebClip(rawClip) {
  if (!rawClip || typeof rawClip !== "object") throw new Error("Missing clip payload.");

  const inputUrl = normalizeClipUrl(rawClip.url);
  const fetched = await fetchBufferWithLimit(inputUrl, {
    limit: HTML_FETCH_LIMIT,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.8,*/*;q=0.5",
  });
  const html = fetched.buffer.toString("utf8");
  const metadata = extractPageMetadata(html, fetched.finalUrl);
  const requestedImageUrl = normalizeOptionalHttpUrl(rawClip.imageUrl || rawClip.mediaUrl, fetched.finalUrl);
  if (requestedImageUrl) metadata.imageSourceUrl = requestedImageUrl;
  const titleOverride = cleanString(rawClip.title, 240);
  if (titleOverride) metadata.title = titleOverride;
  const canonicalUrl = metadata.canonicalUrl || fetched.finalUrl;
  const clipIdSource = requestedImageUrl ? `${canonicalUrl}|${requestedImageUrl}` : canonicalUrl;
  const clipId = `web-${crypto.createHash("sha1").update(clipIdSource).digest("hex").slice(0, 14)}`;

  let imageAsset = null;
  try {
    imageAsset = await saveRemoteAsset(metadata.imageSourceUrl, clipId, "image");
  } catch {
    imageAsset = null;
  }
  if (!imageAsset) imageAsset = writeFallbackClipImage(clipId, metadata);

  let avatarAsset = null;
  try {
    avatarAsset = await saveRemoteAsset(metadata.avatarSourceUrl || metadata.faviconUrl, clipId, "avatar");
  } catch {
    avatarAsset = null;
  }

  const now = new Date().toISOString();
  const payload = webClipsPayload();
  const existing = payload.clips.find((clip) => clip.id === clipId);
  const clip = {
    id: clipId,
    captureMode: requestedImageUrl ? "image" : "page",
    sourcePlatform: sourcePlatformForHost(metadata.host, metadata.siteName),
    sourceUrl: inputUrl,
    canonicalUrl,
    host: metadata.host,
    siteName: metadata.siteName,
    title: metadata.title,
    description: metadata.description,
    creator: metadata.author,
    capturedAt: existing?.capturedAt || now,
    updatedAt: now,
    note: cleanString(rawClip.note, 2400),
    tags: cleanClipTags(rawClip.tags),
    media: {
      type: "photo",
      url: imageAsset.url,
      sourceUrl: imageAsset.sourceUrl || requestedImageUrl || metadata.imageSourceUrl,
      width: imageAsset.width,
      height: imageAsset.height,
      contentType: imageAsset.contentType,
      fallback: imageAsset.fallback || "",
    },
    avatar: avatarAsset ? {
      url: avatarAsset.url,
      sourceUrl: avatarAsset.sourceUrl,
      kind: metadata.avatarKind,
      contentType: avatarAsset.contentType,
    } : {
      url: "",
      sourceUrl: metadata.faviconUrl,
      kind: "favicon",
      contentType: "",
    },
    faviconUrl: metadata.faviconUrl,
    raw: {
      imageSourceUrl: metadata.imageSourceUrl,
      requestedImageUrl,
      avatarSourceUrl: metadata.avatarSourceUrl,
      fetchedUrl: fetched.finalUrl,
    },
  };

  payload.generatedAt = now;
  payload.clips = [clip, ...payload.clips.filter((entry) => entry.id !== clipId)];
  writeJsonFileAtomic(WEB_CLIPS_PATH, payload);
  return clip;
}

function sendMethodNotAllowed(req, res, allowedMethods = ["GET", "POST", "OPTIONS"]) {
  const corsHeaders = apiCorsHeaders(req);
  if (!corsHeaders) {
    sendJson(req, res, 403, { ok: false, error: "Origin not allowed." });
    return;
  }
  res.writeHead(405, { ...corsHeaders, Allow: allowedMethods.join(", ") });
  res.end("Method not allowed");
}

async function handleJsonResource(req, res, options) {
  const {
    read,
    write,
    selectInput,
    bodyLimit,
    fallbackError,
  } = options;

  if (req.method === "GET") {
    try {
      sendJson(req, res, 200, read());
    } catch (error) {
      sendJson(req, res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(req, res);
    return;
  }

  try {
    const parsed = await readJsonRequest(req, bodyLimit);
    const result = await write(selectInput(parsed));
    sendJson(req, res, 200, { ok: true, ...result });
  } catch (error) {
    const status = error instanceof HttpError ? error.statusCode : 400;
    sendJson(req, res, status, { ok: false, error: error.message || fallbackError });
  }
}

function handleClips(req, res) {
  return handleJsonResource(req, res, {
    read: webClipsPayload,
    write: async (rawClip) => ({ clip: await captureWebClip(rawClip) }),
    selectInput: (parsed) => parsed.clip || parsed,
    bodyLimit: CLIP_BODY_LIMIT,
    fallbackError: "Could not save clip.",
  });
}

function currentCatalog() {
  const fixtureCatalogPaths = fixtureCatalogOptions();
  return loadCatalog({
    rootDir: CATALOG_ROOT_DIR,
    indexPath: INSPIRATION_INDEX_PATH,
    webClipsPath: WEB_CLIPS_PATH,
    notesPath: MANUAL_NOTES_PATH,
    ...fixtureCatalogPaths,
  });
}

function fixtureCatalogOptions() {
  if (GRID_FIXTURE_MODE !== "sample") return {};
  const { "bookmarks-data.json": bookmarksPath, "media-cards-clean.json": cardsPath } = FIXTURE_DATA_PATHS;
  if (!bookmarksPath || !cardsPath) {
    throw new Error("Sample fixture mode requires explicit catalog fixture paths.");
  }
  // Reuse the explicit fixtures as fallbacks so this mode cannot read root exports.
  return { bookmarksPath, cardsPath, bookmarksSamplePath: bookmarksPath, cardsSamplePath: cardsPath };
}

function reviewOptions() {
  return {
    rootDir: __dirname,
    notesPath: MANUAL_NOTES_PATH,
    reviewPath: METADATA_REVIEW_PATH,
    lockPath: METADATA_REVIEW_LOCK_PATH,
    catalog: currentCatalog(),
  };
}

function boardOptions() {
  return {
    rootDir: __dirname,
    boardsPath: BOARDS_PATH,
    lockPath: BOARDS_LOCK_PATH,
    catalog: currentCatalog(),
  };
}

function reviewErrorStatus(error) {
  return error instanceof ReviewQueueError ? error.statusCode : 500;
}

function reviewErrorMessage(error, fallback) {
  if (error instanceof ReviewQueueError && error.statusCode < 500) return error.message;
  return fallback;
}

function sendReviewMethodNotAllowed(req, res, allowedMethods) {
  sendJson(req, res, 405, { ok: false, error: "Method not allowed." }, { Allow: allowedMethods.join(", ") });
}

function boardErrorStatus(error) {
  return error instanceof BoardError ? error.statusCode : 500;
}

function boardErrorMessage(error, fallback) {
  return error instanceof BoardError && error.statusCode < 500 ? error.message : fallback;
}

async function handleCatalogResolve(req, res) {
  if (req.method !== "POST") {
    sendReviewMethodNotAllowed(req, res, ["POST", "OPTIONS"]);
    return;
  }
  try {
    const request = await readJsonRequest(req, CATALOG_RESOLVE_BODY_LIMIT);
    sendJson(req, res, 200, resolveCatalogSelectors(currentCatalog(), request));
  } catch (error) {
    const status = error instanceof HttpError ? error.statusCode : error instanceof CatalogResolverError ? 400 : 500;
    const message = error instanceof HttpError || error instanceof CatalogResolverError
      ? error.message
      : "Catalog resolver is unavailable.";
    sendJson(req, res, status, { ok: false, error: message });
  }
}

async function handleBoards(req, res, pathname) {
  const base = "/api/boards";
  const query = new URL(req.url || base, "http://localhost").searchParams;
  if (pathname === base) {
    if (req.method === "GET") {
      try {
        sendJson(req, res, 200, listBoards({ limit: query.get("limit") || undefined, offset: query.get("offset") || undefined }, boardOptions()));
      } catch (error) {
        sendJson(req, res, boardErrorStatus(error), { ok: false, error: boardErrorMessage(error, "Boards are unavailable.") });
      }
      return;
    }
    if (req.method !== "POST") {
      sendReviewMethodNotAllowed(req, res, ["GET", "POST", "OPTIONS"]);
      return;
    }
    try {
      const body = await readJsonRequest(req, BOARDS_BODY_LIMIT);
      sendJson(req, res, 201, { ok: true, board: createBoard(body, boardOptions()) });
    } catch (error) {
      const status = error instanceof HttpError ? error.statusCode : boardErrorStatus(error);
      const message = error instanceof HttpError ? error.message : boardErrorMessage(error, "Boards are unavailable.");
      sendJson(req, res, status, { ok: false, error: message });
    }
    return;
  }

  const exportMatch = pathname.match(/^\/api\/boards\/([^/]+)\/export$/);
  if (exportMatch) {
    if (req.method !== "GET") {
      sendReviewMethodNotAllowed(req, res, ["GET", "OPTIONS"]);
      return;
    }
    try {
      const id = boardRouteId(exportMatch[1]);
      const format = query.get("format") || "markdown";
      sendJson(req, res, 200, { ok: true, ...exportBoard(id, format, boardOptions()) });
    } catch (error) {
      sendJson(req, res, boardErrorStatus(error), { ok: false, error: boardErrorMessage(error, "Board export is unavailable.") });
    }
    return;
  }

  const match = pathname.match(/^\/api\/boards\/([^/]+)$/);
  if (!match) {
    sendJson(req, res, 404, { ok: false, error: "Board route not found." });
    return;
  }
  let id;
  try {
    id = boardRouteId(match[1]);
  } catch (error) {
    sendJson(req, res, boardErrorStatus(error), { ok: false, error: boardErrorMessage(error, "Board is unavailable.") });
    return;
  }
  if (req.method === "GET") {
    try {
      sendJson(req, res, 200, getBoardDetail(id, boardOptions()));
    } catch (error) {
      sendJson(req, res, boardErrorStatus(error), { ok: false, error: boardErrorMessage(error, "Board is unavailable.") });
    }
    return;
  }
  if (req.method === "DELETE") {
    try {
      sendJson(req, res, 200, { ok: true, ...deleteBoard(id, boardOptions()) });
    } catch (error) {
      sendJson(req, res, boardErrorStatus(error), { ok: false, error: boardErrorMessage(error, "Board is unavailable.") });
    }
    return;
  }
  if (req.method !== "PATCH") {
    sendReviewMethodNotAllowed(req, res, ["GET", "PATCH", "DELETE", "OPTIONS"]);
    return;
  }
  try {
    const body = await readJsonRequest(req, BOARDS_BODY_LIMIT);
    const mutation = validateBoardMutationRequest(body);
    let board;
    if (mutation.action === "add") board = addBoardItem(id, mutation.item, boardOptions());
    else if (mutation.action === "remove") board = removeBoardItem(id, mutation.itemId, boardOptions());
    else if (mutation.action === "reorder") board = reorderBoardItems(id, mutation.itemIds, boardOptions());
    else if (mutation.action === "curation-note") board = updateCurationNote(id, mutation.itemId, mutation.curationNote, boardOptions());
    else board = updateBoard(id, mutation.patch, boardOptions());
    sendJson(req, res, 200, { ok: true, board });
  } catch (error) {
    const status = error instanceof HttpError ? error.statusCode : boardErrorStatus(error);
    const message = error instanceof HttpError ? error.message : boardErrorMessage(error, "Board is unavailable.");
    sendJson(req, res, status, { ok: false, error: message });
  }
}

async function handleManualNotes(req, res) {
  if (req.method === "GET") {
    try {
      reconcileReviewState(reviewOptions());
      sendJson(req, res, 200, manualNotesBrowserPayload(readManualNotesPayload(MANUAL_NOTES_PATH)));
    } catch (error) {
      sendJson(req, res, reviewErrorStatus(error), { ok: false, error: reviewErrorMessage(error, "Manual notes are unavailable.") });
    }
    return;
  }
  if (req.method !== "POST") {
    sendMethodNotAllowed(req, res);
    return;
  }
  try {
    const parsed = await readJsonRequest(req, MANUAL_NOTES_BODY_LIMIT);
    const result = mutateManualNote(parsed.note, reviewOptions());
    sendJson(req, res, 200, { ok: true, ...result });
  } catch (error) {
    const status = error instanceof HttpError ? error.statusCode : reviewErrorStatus(error);
    const payload = { ok: false, error: error instanceof HttpError ? error.message : reviewErrorMessage(error, "Could not save note.") };
    if (error?.noteSaved) Object.assign(payload, { noteSaved: true, reviewQueued: false, reason: "review_reconcile_pending" });
    sendJson(req, res, status, payload);
  }
}

async function handleReviewQueue(req, res, pathname) {
  const base = "/api/review-queue";
  if (pathname === base) {
    if (req.method !== "GET") {
      sendReviewMethodNotAllowed(req, res, ["GET", "OPTIONS"]);
      return;
    }
    try {
      const query = new URL(req.url || base, "http://localhost").searchParams;
      const result = listReviewEntries({ status: query.get("status") || undefined, limit: query.get("limit") || undefined, offset: query.get("offset") || undefined }, reviewOptions());
      sendJson(req, res, 200, result);
    } catch (error) {
      sendJson(req, res, reviewErrorStatus(error), { ok: false, error: reviewErrorMessage(error, "Review queue is unavailable.") });
    }
    return;
  }
  const match = pathname.match(/^\/api\/review-queue\/([^/]+)\/(resolve|dismiss|reopen)$/);
  if (!match) {
    sendJson(req, res, 404, { ok: false, error: "Review route not found." });
    return;
  }
  if (req.method !== "POST") {
    sendReviewMethodNotAllowed(req, res, ["POST", "OPTIONS"]);
    return;
  }
  try {
    const id = decodeURIComponent(match[1]);
    if (!/^review:v1:[0-9a-f]{64}$/.test(id)) throw new ReviewQueueError("Invalid review id.", "invalid_review_id");
    const body = await readJsonRequest(req, REVIEW_BODY_LIMIT);
    sendJson(req, res, 200, { ok: true, entry: transition(id, match[2], body, reviewOptions()) });
  } catch (error) {
    const status = error instanceof HttpError ? error.statusCode : reviewErrorStatus(error);
    sendJson(req, res, status, { ok: false, error: error instanceof HttpError ? error.message : reviewErrorMessage(error, "Review queue is unavailable.") });
  }
}

async function handleSearch(req, res) {
  if (req.method !== "POST") {
    sendMethodNotAllowed(req, res, ["POST", "OPTIONS"]);
    return;
  }
  try {
    const request = await readJsonRequest(req, SEARCH_BODY_LIMIT);
    sendJson(req, res, 200, searchCatalog(currentCatalog(), request));
  } catch (error) {
    const status = error instanceof HttpError
      ? error.statusCode
      : error instanceof SearchValidationError
        ? 400
        : 500;
    const message = error instanceof HttpError || error instanceof SearchValidationError
      ? error.message
      : error instanceof CatalogValidationError
        ? "Catalog is unavailable."
        : "Search failed.";
    sendJson(req, res, status, { ok: false, error: message });
  }
}

function handleItem(req, res, catalogId) {
  if (req.method !== "GET") {
    sendMethodNotAllowed(req, res, ["GET", "OPTIONS"]);
    return;
  }
  try {
    if (!catalogId || catalogId.length > 256) throw new HttpError(400, "Invalid catalog id.");
    const item = currentCatalog().items.find((candidate) => candidate.id === catalogId);
    if (!item) {
      sendJson(req, res, 404, { ok: false, error: "Item not found." });
      return;
    }
    sendJson(req, res, 200, { ok: true, item });
  } catch (error) {
    const status = error instanceof HttpError ? error.statusCode : 500;
    const message = error instanceof HttpError
      ? error.message
      : error instanceof CatalogValidationError
        ? "Catalog is unavailable."
        : "Could not load item.";
    sendJson(req, res, status, { ok: false, error: message });
  }
}

const server = http
  .createServer((req, res) => {
    let pathname;
    const rawUrl = req.url || "/";
    try {
      if (rawUrl.startsWith("//")) {
        res.writeHead(400);
        res.end("Bad request");
        return;
      }
      const rawPathname = new URL(rawUrl, "http://localhost").pathname;
      pathname = rawPathname.startsWith("/api/boards")
        ? decodeBoardPathname(rawPathname)
        : decodePathname(rawPathname);
    } catch {
      if (rawUrl.startsWith("/api/boards")) {
        sendJson(req, res, 400, { ok: false, error: "Board request is invalid." });
        return;
      }
      if (rawUrl.startsWith("/api/review-queue")) {
        sendJson(req, res, 400, { ok: false, error: "Invalid review route." });
        return;
      }
      res.writeHead(400);
      res.end("Bad request");
      return;
    }

    if (pathname.startsWith("/api/") && !apiCorsHeaders(req)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Origin not allowed");
      return;
    }

    if (pathname.startsWith("/api/") && req.method === "OPTIONS") {
      const corsHeaders = apiCorsHeaders(req);
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    if (pathname === "/api/manual-notes") {
      void handleManualNotes(req, res);
      return;
    }

    if (pathname === "/api/clips") {
      void handleClips(req, res);
      return;
    }

    if (pathname === "/api/search") {
      void handleSearch(req, res);
      return;
    }

    if (pathname === "/api/catalog/resolve") {
      void handleCatalogResolve(req, res);
      return;
    }

    if (pathname === "/api/boards" || pathname.startsWith("/api/boards/")) {
      void handleBoards(req, res, pathname);
      return;
    }

    if (pathname === "/api/review-queue" || pathname.startsWith("/api/review-queue/")) {
      void handleReviewQueue(req, res, pathname);
      return;
    }

    if (pathname.startsWith("/api/items/")) {
      handleItem(req, res, pathname.slice("/api/items/".length));
      return;
    }

    if (tryServeClipAsset(pathname, res)) {
      return;
    }

    const requestPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const normalizedPath = path.normalize(requestPath);
    const rootDir = path.resolve(__dirname);

    if (!isAllowedStaticPath(normalizedPath)) {
      sendForbidden(res);
      return;
    }

    const filePath = path.resolve(rootDir, normalizedPath);
    if (filePath !== rootDir && !filePath.startsWith(`${rootDir}${path.sep}`)) {
      sendForbidden(res);
      return;
    }

    const fixtureTarget = fixtureStaticTarget(normalizedPath);
    if (fixtureTarget) {
      // Fixture mode never consults the repository's ignored local exports.
      sendStaticFile(res, fixtureTarget.path, fixtureTarget);
      return;
    }

    const fallbackPath = SAMPLE_FALLBACKS.get(normalizedPath);
    const allowedRoot = normalizedPath.startsWith(`assets${path.sep}`)
      ? path.join(rootDir, "assets")
      : normalizedPath.startsWith(`node_modules${path.sep}`)
        ? path.join(rootDir, "node_modules")
        : rootDir;
    sendStaticFile(res, filePath, {
      allowedRoot,
      onMissing: fallbackPath ? () => sendStaticFile(res, path.join(rootDir, fallbackPath), { allowedRoot: rootDir }) : undefined,
    });
  });

server.on("error", (error) => {
  console.error(`Server failed to start: ${error.message}`);
  process.exitCode = 1;
});

try {
  reconcileReviewState({
    rootDir: __dirname,
    notesPath: MANUAL_NOTES_PATH,
    reviewPath: METADATA_REVIEW_PATH,
    lockPath: METADATA_REVIEW_LOCK_PATH,
    catalog: currentCatalog(),
  });
  server.listen(PORT, HOST, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : PORT;
    console.log(`Server running at http://${HOST}:${port}`);
  });
} catch (error) {
  // A catalog validation error remains request-scoped so search can report its normal bounded error.
  if (error instanceof CatalogValidationError) {
    server.listen(PORT, HOST, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : PORT;
      console.log(`Server running at http://${HOST}:${port}`);
    });
  } else {
    console.error("Server failed to recover review state.");
    process.exitCode = 1;
  }
}

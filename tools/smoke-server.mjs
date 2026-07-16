import { spawn } from "node:child_process";
import { link, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = new URL("..", import.meta.url);
const rootPath = fileURLToPath(rootDir);
const manualNotesPath = join(tmpdir(), `visual-bookmarks-grid-smoke-${Date.now()}.json`);
const reviewPath = join(tmpdir(), `visual-bookmarks-grid-review-smoke-${Date.now()}.json`);
const reviewLockPath = reviewPath.replace(/\.json$/, ".lock");
const webClipsPath = join(rootPath, "assets", "smoke-private-web-clips.json");
const clipAssetsDir = join(tmpdir(), `visual-bookmarks-grid-clip-assets-${Date.now()}`);
const unavailableCatalogPath = join(tmpdir(), `visual-bookmarks-grid-unavailable-${Date.now()}.json`);
const boundedCatalogPath = join(tmpdir(), `visual-bookmarks-grid-bounded-${Date.now()}.json`);
const boundedCardsPath = join(tmpdir(), `visual-bookmarks-grid-bounded-cards-${Date.now()}.json`);
const malformedNotesPath = join(tmpdir(), `visual-bookmarks-grid-malformed-notes-${Date.now()}.json`);
const unavailableReviewPath = `${unavailableCatalogPath}.review.json`;
const boundedReviewPath = `${boundedCatalogPath}.review.json`;
const malformedNotesReviewPath = `${malformedNotesPath}.review.json`;
const absentIndexPath = join(tmpdir(), `visual-bookmarks-grid-absent-index-${Date.now()}.json`);
const manualNotesTempPath = `${manualNotesPath}.tmp-static-alias`;
const webClipsTempPath = `${webClipsPath}.tmp-static-alias`;
const indexTempPath = `${absentIndexPath}.tmp-static-alias`;
const reviewTempPath = `${reviewPath}.tmp-static-alias`;
const reviewLockTempPath = `${reviewLockPath}.tmp-${process.pid}-static-alias`;
const reviewLockStalePath = `${reviewLockPath}.stale-${"a".repeat(64)}`;
const reviewLockOwnerPath = join(reviewLockPath, `owner-${"b".repeat(64)}.json`);
const reviewLockTempOwnerPath = join(reviewLockTempPath, `owner-${"c".repeat(64)}.json`);
const reviewLockStaleOwnerPath = join(reviewLockStalePath, `owner-${"d".repeat(64)}.json`);
const reviewNearMissPath = join(rootPath, "assets", "metadata-review.json.tmp");
const webClipsNearMissPath = `${webClipsPath}.near.tmp`;
const privateAssetAliases = [
  { source: manualNotesPath, target: join(rootPath, "assets", "smoke-private-manual-final.svg"), url: "/assets/smoke-private-manual-final.svg", link: true },
  { source: manualNotesTempPath, target: join(clipAssetsDir, "smoke-private-manual-temp.svg"), url: "/assets/clips-smoke/smoke-private-manual-temp.svg", link: false },
  { source: webClipsPath, target: join(rootPath, "assets", "smoke-private-clips-final.svg"), url: "/assets/smoke-private-clips-final.svg", link: false },
  { source: webClipsTempPath, target: join(clipAssetsDir, "smoke-private-clips-temp.svg"), url: "/assets/clips-smoke/smoke-private-clips-temp.svg", link: true },
  { source: absentIndexPath, target: join(rootPath, "assets", "smoke-private-index-final.svg"), url: "/assets/smoke-private-index-final.svg", link: true },
  { source: indexTempPath, target: join(clipAssetsDir, "smoke-private-index-temp.svg"), url: "/assets/clips-smoke/smoke-private-index-temp.svg", link: false },
  { source: reviewPath, target: join(rootPath, "assets", "smoke-private-review-final.svg"), url: "/assets/smoke-private-review-final.svg", link: false },
  { source: reviewTempPath, target: join(clipAssetsDir, "smoke-private-review-temp.svg"), url: "/assets/clips-smoke/smoke-private-review-temp.svg", link: true },
  { source: reviewLockOwnerPath, target: join(rootPath, "assets", "smoke-private-lock-owner.svg"), url: "/assets/smoke-private-lock-owner.svg", link: true },
  { source: reviewLockTempOwnerPath, target: join(clipAssetsDir, "smoke-private-lock-temp-owner.svg"), url: "/assets/clips-smoke/smoke-private-lock-temp-owner.svg", link: false },
  { source: reviewLockStaleOwnerPath, target: join(rootPath, "assets", "smoke-private-lock-stale-owner.svg"), url: "/assets/smoke-private-lock-stale-owner.svg", link: false },
];
const nearMissAliasPath = join(rootPath, "assets", "smoke-public-near-miss.svg");
const webClipsNearMissAliasPath = join(rootPath, "assets", "smoke-public-clips-near-miss.svg");
const normalClipAssetPath = join(clipAssetsDir, "smoke-normal-asset.svg");
const configuredExtensionOrigin = "chrome-extension://smoke";
const unknownExtensionOrigin = "chrome-extension://unknown-smoke";
const clipFixtureImage = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);
const clipFixtureIcon = Buffer.from(
  "00000100010001000000010020003000000016000000280000000100000002000000010020000000000004000000000000000000000000000000000000000ffffffff00000000",
  "hex"
);

await writeFile(manualNotesPath, `${JSON.stringify({
  generatedAt: "2026-07-12T10:00:00.000Z",
  source: "visual-bookmarks-grid manual lightbox notes",
  notes: {
    "sample-interface-001-01": {
      mediaId: "sample-interface-001-01", recordId: "", tweetId: "", tweetUrl: "", mediaUrl: "", titleAtEdit: "", creatorAtEdit: "",
      note: "Recovered before startup.", status: "needs_agent_review", createdAt: "2026-07-12T10:00:00.000Z", updatedAt: "2026-07-12T10:00:00.000Z",
    },
  },
})}\n`);

const server = spawn(process.execPath, ["server.js"], {
  cwd: rootDir,
  env: {
    ...process.env,
    GRID_HOST: "127.0.0.1",
    PORT: "0",
    GRID_PORT: "0",
    INSPIRATION_INDEX_PATH: absentIndexPath,
    MANUAL_NOTES_PATH: manualNotesPath,
    METADATA_REVIEW_PATH: reviewPath,
    METADATA_REVIEW_LOCK_PATH: reviewLockPath,
    WEB_CLIPS_PATH: webClipsPath,
    CLIP_ASSETS_DIR: clipAssetsDir,
    CLIP_ASSETS_PUBLIC_PATH: "/assets/clips-smoke",
    ALLOWED_CHROME_EXTENSION_IDS: "smoke",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
let port = null;
let fixtureServer = null;
let fixturePort = null;
let unavailableCatalogServer = null;
let boundedCatalogServer = null;
let malformedNotesServer = null;
server.stdout.on("data", (chunk) => {
  output += chunk;
  const match = output.match(/Server running at http:\/\/127\.0\.0\.1:(\d+)/);
  if (match) port = Number(match[1]);
});
server.stderr.on("data", (chunk) => {
  output += chunk;
});

const serverOutput = () => output.trim() || "(no server output)";
const responseDetails = (response) => {
  const body = response.body.trim();
  return body ? `\nResponse body:\n${body.slice(0, 1000)}` : "";
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const requestAtPort = (targetPort, { path, method = "GET", body = null, headers = {} }) =>
  new Promise((resolve, reject) => {
    if (!targetPort) {
      reject(new Error("Server port is not ready."));
      return;
    }
    const request = http.request(
      {
        host: "127.0.0.1",
        port: targetPort,
        path,
        method,
        headers,
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: responseBody }));
      }
    );

    request.on("error", (error) => {
      reject(new Error(`${method} ${path} request failed: ${error.message}\nServer output:\n${serverOutput()}`));
    });
    if (body) request.write(body);
    request.end();
  });

const request = (options) => requestAtPort(port, options);

const requestStatus = (path) => request({ path }).then((response) => response.status);
const expectStatus = async (path, status) => {
  const response = await request({ path });
  if (response.status !== status) {
    throw new Error(`${path} returned ${response.status}, expected ${status}.${responseDetails(response)}\nServer output:\n${serverOutput()}`);
  }
};

const requestJson = async (options) => {
  const response = await request(options);
  return {
    status: response.status,
    json: JSON.parse(response.body || "{}"),
  };
};

const waitForServer = async () => {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await requestStatus("/")) === 200) return;
    } catch {
      await wait(100);
    }
  }
  throw new Error(`Server did not start. Output:\n${output}`);
};

try {
  await waitForServer();

  const startupRecovery = await requestJson({ path: "/api/review-queue?status=needs_review" });
  if (startupRecovery.status !== 200 || startupRecovery.json.total !== 1 || !startupRecovery.json.entries?.[0]?.sourcePresent) {
    throw new Error("Server startup did not recover the persisted manual-note intake.");
  }

  const expected = [
    ["/", 200],
    ["/style.css", 200],
    ["/app.js", 200],
    ["/audio-feedback.js", 200],
    ["/url-contract.js", 200],
    ["/browser-loader.js", 200],
    ["/bookmarks-data.json?v=smoke", 200],
    ["/bookmarks-data.sample.json", 200],
    ["/media-cards-clean.json?v=smoke", 200],
    ["/media-cards.sample.json", 200],
    ["/node_modules/motion/dist/motion.js", 200],
    ["/node_modules/@web-kits/audio/dist/index.js", 200],
    ["/node_modules/%40web-kits/audio/dist/index.js", 200],
    ["/assets/play-icon.svg", 200],
    ["/assets/favicon.svg", 200],
    ["/assets/sample-branding.svg", 200],
    ["/api/manual-notes", 200],
    ["/api/clips", 200],
    ["/api/items", 403],
    ["/.env", 403],
    ["/.env.local", 403],
    ["/.env.example", 403],
    ["/.git/config", 403],
    ["/.gitignore", 403],
    ["/.nvmrc", 403],
    ["/AGENTS.md", 403],
    ["/README.md", 403],
    ["/package-lock.json", 403],
    ["/package.json", 403],
    ["/server.js", 403],
    ["/lib/clip-metadata.js", 403],
    ["/tools/smoke-server.mjs", 403],
    ["/scripts/example.mjs", 403],
    ["/docs/remix-guide.md", 403],
    ["/.github/workflows/ci.yml", 403],
    ["/chrome-extension/manifest.json", 403],
    ["/web-clips.json", 403],
    ["/manual-media-notes.json", 403],
    ["/inspiration-index.json", 403],
    ["/metadata-review.json", 403],
    ["/metadata-review.lock", 403],
    ["/boards.json", 403],
    ["/boards.json.tmp-static", 403],
    ["/boards.lock", 403],
    ["/boards.lock.tmp-static", 403],
    ["/boards.lock.stale-static", 403],
    ["/boards.lock/owner-static.json", 403],
    ["/lib/catalog/bootstrap.js", 403],
    ["/lib/search.js", 403],
    ["/test/fixtures/search/bookmarks.json", 403],
    ["/../package.json", 403],
    ["/%2e%2e/package.json", 403],
    ["/%252e%252e/package.json", 403],
    ["/%00package.json", 403],
    ["/node_modules/@web-kits/audio/dist/bin.js", 403],
    ["/assets/clips-smoke/.env", 403],
    ["/assets/clips-smoke/%2e%2e/package.json", 403],
    ["//package.json", 400],
  ];

  for (const [path, status] of expected) {
    await expectStatus(path, status);
  }

  const singleCompletionStaticResponse = await request({ path: "/style.css" });
  await wait(25);
  if (
    singleCompletionStaticResponse.status !== 200 ||
    !singleCompletionStaticResponse.body ||
    server.exitCode !== null ||
    /ERR_HTTP_HEADERS_SENT|ERR_STREAM_WRITE_AFTER_END|write after end/i.test(output)
  ) {
    throw new Error("A successful static response did not complete exactly once.");
  }

  await expectStatus("/%E0%A4%A", 400);

  await mkdir(clipAssetsDir, { recursive: true });
  await writeFile(manualNotesTempPath, "private manual-note temp\n");
  await writeFile(webClipsPath, "private clips state\n");
  await writeFile(webClipsTempPath, "private clips temp\n");
  await writeFile(absentIndexPath, "private index state\n");
  await writeFile(indexTempPath, "private index temp\n");
  await writeFile(reviewTempPath, "private review temp\n");
  await mkdir(reviewLockPath, { recursive: true });
  await mkdir(reviewLockTempPath, { recursive: true });
  await mkdir(reviewLockStalePath, { recursive: true });
  await Promise.all([
    writeFile(reviewLockOwnerPath, "private review lock owner\n"),
    writeFile(reviewLockTempOwnerPath, "private review lock temp owner\n"),
    writeFile(reviewLockStaleOwnerPath, "private review lock stale owner\n"),
    writeFile(reviewNearMissPath, "public review near miss\n"),
    writeFile(webClipsNearMissPath, "public clips near miss\n"),
  ]);
  await writeFile(normalClipAssetPath, "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n");
  for (const alias of privateAssetAliases) {
    if (alias.link) await link(alias.source, alias.target);
    else await symlink(alias.source, alias.target);
  }
  await symlink(reviewNearMissPath, nearMissAliasPath);
  await symlink(webClipsNearMissPath, webClipsNearMissAliasPath);
  for (const aliasPath of privateAssetAliases.map(({ url }) => url)) {
    const response = await request({ path: aliasPath });
    if (
      response.status !== 403 ||
      response.body !== "Forbidden" ||
      [
        manualNotesPath, manualNotesTempPath, webClipsPath, webClipsTempPath, absentIndexPath, indexTempPath,
        reviewPath, reviewTempPath, reviewLockPath, reviewLockTempPath, reviewLockStalePath,
        reviewLockOwnerPath, reviewLockTempOwnerPath, reviewLockStaleOwnerPath,
      ].some((privatePath) => response.body.includes(privatePath))
    ) {
      throw new Error(`Static alias ${aliasPath} did not return the bounded private-state denial.`);
    }
  }
  for (const [nearMissUrl, body] of [
    ["/assets/smoke-public-near-miss.svg", "public review near miss\n"],
    ["/assets/smoke-public-clips-near-miss.svg", "public clips near miss\n"],
  ]) {
    const nearMissResponse = await request({ path: nearMissUrl });
    if (nearMissResponse.status !== 200 || nearMissResponse.body !== body) {
      throw new Error(`A public near-miss asset was incorrectly denied: ${nearMissUrl}`);
    }
  }
  await expectStatus("/assets/clips-smoke/smoke-normal-asset.svg", 200);
  await Promise.all([
    ...privateAssetAliases.map(({ target }) => rm(target, { force: true })),
    rm(nearMissAliasPath, { force: true }),
    rm(webClipsNearMissAliasPath, { force: true }),
    rm(manualNotesTempPath, { force: true }),
    rm(webClipsTempPath, { force: true }),
    rm(indexTempPath, { force: true }),
    rm(reviewTempPath, { force: true }),
    rm(reviewLockPath, { recursive: true, force: true }),
    rm(reviewLockTempPath, { recursive: true, force: true }),
    rm(reviewLockStalePath, { recursive: true, force: true }),
    rm(reviewNearMissPath, { force: true }),
    rm(webClipsNearMissPath, { force: true }),
    rm(webClipsPath, { force: true }),
    rm(absentIndexPath, { force: true }),
  ]);

  const unknownReviewRoute = await requestJson({ path: "/api/review-queue/not-a-route" });
  if (unknownReviewRoute.status !== 404 || unknownReviewRoute.json.ok !== false || !unknownReviewRoute.json.error) {
    throw new Error("/api/review-queue unknown routes did not return a bounded JSON 404.");
  }
  const encodedUnknownReviewRoute = await requestJson({ path: "/api/review-queue/not-a-route%2Fextra" });
  if (encodedUnknownReviewRoute.status !== 404 || encodedUnknownReviewRoute.json.ok !== false) {
    throw new Error("/api/review-queue encoded unknown routes did not return JSON 404.");
  }
  const malformedReviewRoute = await requestJson({ path: "/api/review-queue/%E0%A4%A" });
  if (malformedReviewRoute.status !== 400 || malformedReviewRoute.json.ok !== false) {
    throw new Error("/api/review-queue malformed encoded routes did not return JSON 400.");
  }
  const invalidReviewMethod = await requestJson({ path: "/api/review-queue", method: "PUT" });
  if (invalidReviewMethod.status !== 405 || invalidReviewMethod.json.ok !== false) {
    throw new Error("/api/review-queue did not return JSON for unsupported methods.");
  }

  const indexPage = await request({ path: "/" });
  const lightboxOverlayMarkup = indexPage.body.match(/<div\s+id="lightbox-overlay"[^>]*>/)?.[0] || "";
  if (
    !/\shidden(?:\s|>)/.test(lightboxOverlayMarkup) ||
    !/\sinert(?:\s|>)/.test(lightboxOverlayMarkup) ||
    !lightboxOverlayMarkup.includes('aria-hidden="true"')
  ) {
    throw new Error("The lightbox overlay is not hidden from accessibility APIs in the initial markup.");
  }

  const clipPreflight = await request({
    path: "/api/clips",
    method: "OPTIONS",
    headers: {
      Origin: configuredExtensionOrigin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Content-Type",
    },
  });
  if (
    clipPreflight.status !== 204 ||
    clipPreflight.headers["access-control-allow-origin"] !== configuredExtensionOrigin ||
    clipPreflight.headers.vary !== "Origin"
  ) {
    throw new Error("/api/clips did not return the expected configured extension preflight response.");
  }

  const unknownExtensionPreflight = await request({
    path: "/api/clips",
    method: "OPTIONS",
    headers: {
      Origin: unknownExtensionOrigin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Content-Type",
    },
  });
  if (unknownExtensionPreflight.status !== 403 || unknownExtensionPreflight.headers["access-control-allow-origin"]) {
    throw new Error("/api/clips did not reject an unknown extension preflight response.");
  }

  const localPreflight = await request({
    path: "/api/manual-notes",
    method: "OPTIONS",
    headers: {
      Origin: `http://127.0.0.1:${port}`,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Content-Type",
    },
  });
  if (localPreflight.status !== 204 || localPreflight.headers["access-control-allow-origin"] !== `http://127.0.0.1:${port}`) {
    throw new Error("/api/manual-notes did not return the expected local preflight response.");
  }

  const localhostPreflight = await request({
    path: "/api/manual-notes",
    method: "OPTIONS",
    headers: {
      Origin: `http://localhost:${port}`,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Content-Type",
    },
  });
  if (localhostPreflight.status !== 204 || localhostPreflight.headers["access-control-allow-origin"] !== `http://localhost:${port}`) {
    throw new Error("/api/manual-notes did not allow a localhost origin.");
  }

  const ipv6LocalhostPreflight = await request({
    path: "/api/manual-notes",
    method: "OPTIONS",
    headers: {
      Origin: `http://[::1]:${port}`,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Content-Type",
    },
  });
  if (ipv6LocalhostPreflight.status !== 204 || ipv6LocalhostPreflight.headers["access-control-allow-origin"] !== `http://[::1]:${port}`) {
    throw new Error("/api/manual-notes did not allow an IPv6 localhost origin.");
  }

  const otherLocalPort = port === 65535 ? port - 1 : port + 1;
  const unrelatedLocalPreflight = await request({
    path: "/api/manual-notes",
    method: "OPTIONS",
    headers: {
      Origin: `http://127.0.0.1:${otherLocalPort}`,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Content-Type",
    },
  });
  if (unrelatedLocalPreflight.status !== 403 || unrelatedLocalPreflight.headers["access-control-allow-origin"]) {
    throw new Error("/api/manual-notes allowed an unrelated localhost origin on another port.");
  }

  const hostilePreflight = await request({
    path: "/api/clips",
    method: "OPTIONS",
    headers: {
      Origin: "https://evil.example",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Content-Type",
    },
  });
  if (hostilePreflight.status !== 403 || hostilePreflight.headers["access-control-allow-origin"]) {
    throw new Error("/api/clips did not reject the hostile preflight response.");
  }

  const hostileApi = await request({
    path: "/api/manual-notes",
    headers: { Origin: "https://evil.example" },
  });
  if (hostileApi.status !== 403 || hostileApi.headers["access-control-allow-origin"]) {
    throw new Error("/api/manual-notes did not reject a hostile API origin.");
  }

  const sameOriginApi = await request({ path: "/api/clips" });
  if (sameOriginApi.status !== 200 || sameOriginApi.headers["access-control-allow-origin"] === "*") {
    throw new Error("/api/clips returned an unexpected CORS header for same-origin requests.");
  }

  const extensionApi = await request({
    path: "/api/clips",
    headers: { Origin: configuredExtensionOrigin },
  });
  if (extensionApi.status !== 200 || extensionApi.headers["access-control-allow-origin"] !== configuredExtensionOrigin) {
    throw new Error("/api/clips did not allow the configured Chrome extension origin.");
  }

  const unknownExtensionApi = await request({
    path: "/api/clips",
    headers: { Origin: unknownExtensionOrigin },
  });
  if (unknownExtensionApi.status !== 403 || unknownExtensionApi.headers["access-control-allow-origin"]) {
    throw new Error("/api/clips did not reject an unknown Chrome extension origin.");
  }

  const unsupportedMethod = await request({ path: "/api/manual-notes", method: "PUT" });
  if (unsupportedMethod.status !== 405 || unsupportedMethod.headers.allow !== "GET, POST, OPTIONS") {
    throw new Error("/api/manual-notes did not return the expected method response.");
  }

  const malformedJson = await requestJson({
    path: "/api/manual-notes",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not-json",
  });
  if (malformedJson.status !== 400 || !/valid JSON/i.test(malformedJson.json.error || "")) {
    throw new Error("/api/manual-notes did not reject malformed JSON cleanly.");
  }

  const oversizedUtf8Body = JSON.stringify({
    note: {
      mediaId: "oversized-note",
      note: "€".repeat(9000),
    },
  });
  const oversizedRequest = await requestJson({
    path: "/api/manual-notes",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: oversizedUtf8Body,
  });
  if (oversizedRequest.status !== 413 || !/too large/i.test(oversizedRequest.json.error || "")) {
    throw new Error("/api/manual-notes did not enforce its request limit in UTF-8 bytes.");
  }

  const search = await requestJson({
    path: "/api/search",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "workspace", filters: { style: ["Minimal"] }, limit: 4 }),
  });
  if (
    search.status !== 200 ||
    !search.json.ok ||
    search.json.total !== 1 ||
    search.json.results?.[0]?.item?.sourceRecordId !== "sample-workspace-004" ||
    search.json.results?.[0]?.matchReasons?.length === 0 ||
    JSON.stringify(search.json).includes("resolverAliases")
  ) {
    throw new Error("/api/search did not return the bounded sample catalog result.");
  }

  const itemId = search.json.results[0].item.id;
  const item = await requestJson({ path: `/api/items/${encodeURIComponent(itemId)}` });
  if (item.status !== 200 || !item.json.ok || item.json.item?.id !== itemId || item.json.resolverAliases) {
    throw new Error("/api/items/:id did not return the requested normalized record.");
  }
  const missingItem = await requestJson({ path: "/api/items/visual%3Av1%3Amissing" });
  if (missingItem.status !== 404 || missingItem.json.ok !== false) {
    throw new Error("/api/items/:id did not return 404 for an unknown record.");
  }

  const searchMethod = await request({ path: "/api/search", method: "GET" });
  if (searchMethod.status !== 405 || searchMethod.headers.allow !== "POST, OPTIONS") {
    throw new Error("/api/search did not return its method allowlist.");
  }
  const itemMethod = await request({ path: `/api/items/${encodeURIComponent(itemId)}`, method: "POST" });
  if (itemMethod.status !== 405 || itemMethod.headers.allow !== "GET, OPTIONS") {
    throw new Error("/api/items/:id did not return its method allowlist.");
  }

  const invalidSearch = await requestJson({
    path: "/api/search",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filters: { unknown: ["private"] } }),
  });
  if (invalidSearch.status !== 400 || invalidSearch.json.ok !== false || invalidSearch.json.results) {
    throw new Error("/api/search returned records for an invalid filter.");
  }

  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    const inheritedNameSearch = await requestJson({
      path: "/api/search",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filters: Object.fromEntries([[name, ["x"]]]) }),
    });
    if (
      inheritedNameSearch.status !== 400 ||
      inheritedNameSearch.json.ok !== false ||
      inheritedNameSearch.json.error !== `Unknown filter: ${name}.` ||
      inheritedNameSearch.json.results
    ) {
      throw new Error(`/api/search accepted inherited object name ${name} as a facet.`);
    }
  }

  const nullQuery = await requestJson({
    path: "/api/search",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: null }),
  });
  if (nullQuery.status !== 400 || nullQuery.json.ok !== false || nullQuery.json.results) {
    throw new Error("/api/search accepted query: null.");
  }

  await writeFile(unavailableCatalogPath, "{invalid json");
  let unavailableOutput = "";
  let unavailablePort = null;
  unavailableCatalogServer = spawn(process.execPath, ["server.js"], {
    cwd: rootDir,
    env: {
      ...process.env,
      GRID_HOST: "127.0.0.1",
      PORT: "0",
      GRID_PORT: "0",
      INSPIRATION_INDEX_PATH: absentIndexPath,
      BOOKMARKS_PATH: unavailableCatalogPath,
      METADATA_REVIEW_PATH: unavailableReviewPath,
      METADATA_REVIEW_LOCK_PATH: unavailableReviewPath.replace(/\.json$/, ".lock"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const inspectUnavailableOutput = (chunk) => {
    unavailableOutput += chunk;
    const match = unavailableOutput.match(/Server running at http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) unavailablePort = Number(match[1]);
  };
  unavailableCatalogServer.stdout.on("data", inspectUnavailableOutput);
  unavailableCatalogServer.stderr.on("data", inspectUnavailableOutput);
  for (let attempt = 0; attempt < 40 && !unavailablePort; attempt++) await wait(100);
  if (!unavailablePort) throw new Error(`Unavailable-catalog server did not start: ${unavailableOutput}`);

  const unavailableSearch = await requestAtPort(unavailablePort, {
    path: "/api/search",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const unavailableJson = JSON.parse(unavailableSearch.body);
  if (
    unavailableSearch.status !== 500 ||
    unavailableJson.ok !== false ||
    unavailableJson.error !== "Catalog is unavailable." ||
    unavailableSearch.body.includes(unavailableCatalogPath)
  ) {
    throw new Error("/api/search disclosed catalog source details.");
  }

  await writeFile(boundedCatalogPath, JSON.stringify({
    bookmarks: [{
      id: "bounded-api-record",
      text: "M".repeat(10000),
      url: "https://example.com/bounded-api-record",
      images: [{ id: "bounded-api-media", type: "photo", url: "assets/sample-interface.svg" }],
    }],
  }));
  await writeFile(boundedCardsPath, JSON.stringify({ cards: [] }));
  let boundedOutput = "";
  let boundedPort = null;
  boundedCatalogServer = spawn(process.execPath, ["server.js"], {
    cwd: rootDir,
    env: {
      ...process.env,
      GRID_HOST: "127.0.0.1",
      PORT: "0",
      GRID_PORT: "0",
      INSPIRATION_INDEX_PATH: absentIndexPath,
      BOOKMARKS_PATH: boundedCatalogPath,
      MEDIA_CARDS_PATH: boundedCardsPath,
      WEB_CLIPS_PATH: `${boundedCatalogPath}.missing-clips`,
      MANUAL_NOTES_PATH: `${boundedCatalogPath}.missing-notes`,
      METADATA_REVIEW_PATH: boundedReviewPath,
      METADATA_REVIEW_LOCK_PATH: boundedReviewPath.replace(/\.json$/, ".lock"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const inspectBoundedOutput = (chunk) => {
    boundedOutput += chunk;
    const match = boundedOutput.match(/Server running at http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) boundedPort = Number(match[1]);
  };
  boundedCatalogServer.stdout.on("data", inspectBoundedOutput);
  boundedCatalogServer.stderr.on("data", inspectBoundedOutput);
  for (let attempt = 0; attempt < 40 && !boundedPort; attempt++) await wait(100);
  if (!boundedPort) throw new Error(`Bounded-catalog server did not start: ${boundedOutput}`);

  const boundedSearch = await requestAtPort(boundedPort, {
    path: "/api/search",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "mmmm" }),
  });
  const boundedJson = JSON.parse(boundedSearch.body);
  if (
    boundedSearch.status !== 200 ||
    boundedJson.total !== 1 ||
    boundedJson.results?.[0]?.item?.searchText?.length !== 10000
  ) {
    throw new Error("/api/search was unavailable for a catalog with maximum-length scalar fields.");
  }

  const privateNoteKey = "/private/workspace/SECRET_TOKEN/manual-note.json";
  await writeFile(malformedNotesPath, JSON.stringify({ notes: { [privateNoteKey]: null } }));
  let malformedNotesOutput = "";
  let malformedNotesPort = null;
  malformedNotesServer = spawn(process.execPath, ["server.js"], {
    cwd: rootDir,
    env: {
      ...process.env,
      GRID_HOST: "127.0.0.1",
      PORT: "0",
      GRID_PORT: "0",
      INSPIRATION_INDEX_PATH: absentIndexPath,
      BOOKMARKS_PATH: join(rootPath, "bookmarks-data.sample.json"),
      MEDIA_CARDS_PATH: join(rootPath, "media-cards.sample.json"),
      WEB_CLIPS_PATH: `${malformedNotesPath}.missing-clips`,
      MANUAL_NOTES_PATH: malformedNotesPath,
      METADATA_REVIEW_PATH: malformedNotesReviewPath,
      METADATA_REVIEW_LOCK_PATH: malformedNotesReviewPath.replace(/\.json$/, ".lock"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const inspectMalformedNotesOutput = (chunk) => {
    malformedNotesOutput += chunk;
    const match = malformedNotesOutput.match(/Server running at http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) malformedNotesPort = Number(match[1]);
  };
  malformedNotesServer.stdout.on("data", inspectMalformedNotesOutput);
  malformedNotesServer.stderr.on("data", inspectMalformedNotesOutput);
  for (let attempt = 0; attempt < 40 && !malformedNotesPort; attempt++) await wait(100);
  if (!malformedNotesPort) throw new Error(`Malformed-notes server did not start: ${malformedNotesOutput}`);

  const malformedNotesSearch = await requestAtPort(malformedNotesPort, {
    path: "/api/search",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const malformedNotesJson = JSON.parse(malformedNotesSearch.body);
  const disclosedManualNoteDetails = [
    malformedNotesSearch.body,
    malformedNotesOutput,
  ].some((value) =>
    value.includes(privateNoteKey) ||
    value.includes("/private/workspace") ||
    value.includes("SECRET_TOKEN") ||
    value.includes(malformedNotesPath) ||
    value.includes("MANUAL_NOTES_PATH")
  );
  if (
    malformedNotesSearch.status !== 500 ||
    malformedNotesJson.error !== "Catalog is unavailable." ||
    disclosedManualNoteDetails
  ) {
    throw new Error("/api/search disclosed malformed manual-note selector or configuration details.");
  }

  const malformedSearch = await requestJson({
    path: "/api/search",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not-json",
  });
  if (malformedSearch.status !== 400 || !/valid JSON/i.test(malformedSearch.json.error || "")) {
    throw new Error("/api/search did not reject malformed JSON.");
  }

  const oversizedSearch = await requestJson({
    path: "/api/search",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "x".repeat(17 * 1024) }),
  });
  if (oversizedSearch.status !== 413 || !/too large/i.test(oversizedSearch.json.error || "")) {
    throw new Error("/api/search did not enforce its 16 KiB request limit.");
  }

  fixtureServer = http.createServer((req, res) => {
    if (req.url === "/clip-smoke-image.png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(clipFixtureImage);
      return;
    }

    if (req.url === "/clip-smoke-icon.ico") {
      res.writeHead(200, { "Content-Type": "image/x-icon" });
      res.end(clipFixtureIcon);
      return;
    }

    if (req.url?.startsWith("/clip-smoke-fixture.html")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html>
<html>
  <head>
    <title>Smoke Clip Title</title>
    <meta property="og:title" content="Smoke Clip OG Title">
    <meta property="og:description" content="Smoke clip description">
    <meta property="og:site_name" content="Smoke Site">
    <meta name="author" content="Smoke Author">
    <meta property="og:image" content="http://127.0.0.1:${fixturePort}/clip-smoke-image.png">
    <link rel="icon" href="http://127.0.0.1:${fixturePort}/clip-smoke-icon.ico">
  </head>
  <body>Smoke clip body</body>
</html>`);
      return;
    }

    if (req.url === "/clip-smoke-oversized.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.write("x".repeat(1024 * 1024 + 1));
      res.end("x".repeat(1024 * 1024 + 1));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });
  await new Promise((resolve, reject) => {
    fixtureServer.once("error", reject);
    fixtureServer.listen(0, "127.0.0.1", () => {
      fixturePort = fixtureServer.address().port;
      fixtureServer.off("error", reject);
      resolve();
    });
  });

  const oversizedClip = await requestJson({
    path: "/api/clips",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clip: { url: `http://127.0.0.1:${fixturePort}/clip-smoke-oversized.html` },
    }),
  });
  if (oversizedClip.status !== 400 || !/too large/i.test(oversizedClip.json.error || "")) {
    throw new Error("/api/clips buffered a remote response beyond its configured limit.");
  }

  const clipSaved = await requestJson({
    path: "/api/clips",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clip: {
        url: `http://127.0.0.1:${fixturePort}/clip-smoke-fixture.html`,
        note: "Smoke clip note",
        tags: ["smoke", "clip"],
      },
    }),
  });
  if (clipSaved.status !== 200 || !clipSaved.json.ok || clipSaved.json.clip?.title !== "Smoke Clip OG Title") {
    throw new Error("/api/clips POST did not capture the clip metadata.");
  }
  if (!clipSaved.json.clip?.media?.url || !clipSaved.json.clip?.avatar) {
    throw new Error("/api/clips POST did not return saved media and avatar fields.");
  }
  const clipAssetPath = new URL(clipSaved.json.clip.media.url, "http://127.0.0.1").pathname;
  await expectStatus(clipAssetPath, 200);
  if (!clipSaved.json.clip.avatar?.url?.endsWith("/avatar.ico")) {
    throw new Error("/api/clips POST did not save the fixture favicon as an .ico avatar.");
  }
  const clipAvatarPath = new URL(clipSaved.json.clip.avatar.url, "http://127.0.0.1").pathname;
  await expectStatus(clipAvatarPath, 200);

  const imageClipSaved = await requestJson({
    path: "/api/clips",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clip: {
        url: `http://127.0.0.1:${fixturePort}/clip-smoke-fixture.html`,
        imageUrl: `http://127.0.0.1:${fixturePort}/clip-smoke-image.png`,
        title: "Smoke Exact Image",
      },
    }),
  });
  if (
    imageClipSaved.status !== 200 ||
    !imageClipSaved.json.ok ||
    imageClipSaved.json.clip?.captureMode !== "image" ||
    imageClipSaved.json.clip?.raw?.requestedImageUrl !== `http://127.0.0.1:${fixturePort}/clip-smoke-image.png`
  ) {
    throw new Error("/api/clips POST did not capture the requested image URL.");
  }

  const clips = await requestJson({ path: "/api/clips" });
  if (clips.status !== 200 || clips.json.clips?.[0]?.title !== "Smoke Exact Image") {
    throw new Error("/api/clips GET did not return the saved clip.");
  }

  const saveUniqueClip = (title) => requestJson({
    path: "/api/clips",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clip: {
      url: `http://127.0.0.1:${fixturePort}/clip-smoke-fixture.html?atomic=${encodeURIComponent(title)}`,
      title,
    } }),
  });
  const concurrentClips = await Promise.all(["Atomic concurrent A", "Atomic concurrent B", "Atomic concurrent C"].map(saveUniqueClip));
  const sequentialClips = [];
  for (const title of ["Atomic sequential A", "Atomic sequential B"]) sequentialClips.push(await saveUniqueClip(title));
  if ([...concurrentClips, ...sequentialClips].some((response) => response.status !== 200 || !response.json.ok)) {
    throw new Error("Concurrent or sequential clip writes collided instead of publishing their captures.");
  }
  const tempClipArtifacts = (await readdir(dirname(webClipsPath)))
    .filter((name) => name.startsWith(`${basename(webClipsPath)}.tmp-`));
  if (tempClipArtifacts.length !== 0) {
    throw new Error("Successful concurrent or sequential clip writes left temporary artifacts behind.");
  }

  const saved = await requestJson({
    path: "/api/manual-notes",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      note: {
        mediaId: "sample-interface-001-01",
        tweetId: "smoke-tweet-id",
        tweetUrl: "https://example.com/smoke/source",
        mediaUrl: "https://example.com/smoke/media.jpg",
        titleAtEdit: "Smoke test",
        creatorAtEdit: "Smoke",
        note: "Manual note smoke test with aperture cadence.",
      },
    }),
  });
  if (saved.status !== 200 || !saved.json.ok || saved.json.entry?.note !== "Manual note smoke test with aperture cadence.") {
    throw new Error("/api/manual-notes POST did not save the manual note.");
  }

  const notes = await requestJson({ path: "/api/manual-notes" });
  if (notes.status !== 200 || notes.json.notes?.["sample-interface-001-01"]?.note !== "Manual note smoke test with aperture cadence.") {
    throw new Error("/api/manual-notes GET did not return the saved manual note.");
  }

  const reviewQueue = await requestJson({ path: "/api/review-queue?status=needs_review&limit=20&offset=0" });
  const reviewEntry = reviewQueue.json.entries?.[0];
  if (
    reviewQueue.status !== 200 ||
    reviewQueue.json.total !== 1 ||
    !/^review:v1:[0-9a-f]{64}$/.test(reviewEntry?.id || "") ||
    !reviewEntry.sourcePresent ||
    reviewEntry.recordId !== notes.json.notes?.["sample-interface-001-01"]?.recordId
  ) {
    throw new Error("/api/review-queue did not return the reconciled manual-note intake entry.");
  }
  const resolvedReview = await requestJson({
    path: `/api/review-queue/${encodeURIComponent(reviewEntry.id)}/resolve`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patch: { title: "Smoke accepted title", tags: [] } }),
  });
  if (resolvedReview.status !== 200 || resolvedReview.json.entry?.status !== "resolved") {
    throw new Error("/api/review-queue/:id/resolve did not accept a bounded patch.");
  }
  const invalidReviewMutationMethod = await requestJson({
    path: `/api/review-queue/${encodeURIComponent(reviewEntry.id)}/resolve`,
    method: "GET",
  });
  if (invalidReviewMutationMethod.status !== 405 || invalidReviewMutationMethod.json.ok !== false) {
    throw new Error("/api/review-queue transitions did not return JSON for unsupported methods.");
  }
  const overLimitReviewList = await requestJson({ path: "/api/review-queue?limit=51" });
  if (overLimitReviewList.status !== 400 || overLimitReviewList.json.ok !== false) {
    throw new Error("/api/review-queue did not cap list requests.");
  }
  const reopenedReview = await requestJson({
    path: `/api/review-queue/${encodeURIComponent(reviewEntry.id)}/reopen`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "Smoke follow-up" }),
  });
  if (reopenedReview.status !== 200 || reopenedReview.json.entry?.status !== "needs_review") {
    throw new Error("/api/review-queue/:id/reopen did not validate its transition.");
  }
  const dismissedReview = await requestJson({
    path: `/api/review-queue/${encodeURIComponent(reviewEntry.id)}/dismiss`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "Smoke complete" }),
  });
  if (dismissedReview.status !== 200 || dismissedReview.json.entry?.status !== "dismissed") {
    throw new Error("/api/review-queue/:id/dismiss did not validate its transition.");
  }
  const deletedManualNote = await requestJson({
    path: "/api/manual-notes",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note: { mediaId: "sample-interface-001-01", note: "" } }),
  });
  if (deletedManualNote.status !== 200 || deletedManualNote.json.deleted !== true) {
    throw new Error("/api/manual-notes POST did not delete the source note.");
  }
  const sourceDeletedQueue = await requestJson({ path: "/api/review-queue?status=dismissed&limit=20&offset=0" });
  if (sourceDeletedQueue.status !== 200 || sourceDeletedQueue.json.entries?.[0]?.sourcePresent !== false) {
    throw new Error("/api/review-queue did not replay source deletion.");
  }
  const sourceDeletedReopen = await requestJson({
    path: `/api/review-queue/${encodeURIComponent(reviewEntry.id)}/reopen`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "Smoke source follow-up" }),
  });
  if (sourceDeletedReopen.status !== 200 || sourceDeletedReopen.json.entry?.status !== "needs_review" || sourceDeletedReopen.json.entry?.sourcePresent !== false) {
    throw new Error("/api/review-queue/:id/reopen fabricated source presence after deletion.");
  }
  const restoredManualNote = await requestJson({
    path: "/api/manual-notes",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note: {
      mediaId: "sample-interface-001-01",
      tweetId: "smoke-tweet-id",
      tweetUrl: "https://example.com/smoke/source",
      mediaUrl: "https://example.com/smoke/media.jpg",
      titleAtEdit: "Smoke test",
      creatorAtEdit: "Smoke",
      note: "Manual note smoke test with aperture cadence.",
    } }),
  });
  if (restoredManualNote.status !== 200 || restoredManualNote.json.review?.entries?.[0]?.sourcePresent !== true || restoredManualNote.json.review?.entries?.[0]?.events?.at(-1)?.reason !== "source_note_updated") {
    throw new Error("/api/manual-notes POST did not restore source presence through source_note_updated.");
  }
  const oversizedReview = await requestJson({
    path: `/api/review-queue/${encodeURIComponent(reviewEntry.id)}/reopen`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "x".repeat(33 * 1024) }),
  });
  if (oversizedReview.status !== 413 || !/too large/i.test(oversizedReview.json.error || "")) {
    throw new Error("/api/review-queue did not enforce its 32 KiB request limit.");
  }

  const noteSearch = await requestJson({
    path: "/api/search",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "aperture cadence" }),
  });
  if (
    noteSearch.status !== 200 ||
    noteSearch.json.total !== 1 ||
    noteSearch.json.results?.[0]?.item?.sourceRecordId !== "sample-interface-001" ||
    noteSearch.json.results?.[0]?.matchReasons?.some((reason) => reason.value.includes("smoke test"))
  ) {
    throw new Error("/api/search did not resolve the current manual-note alias safely.");
  }

  for (const length of [161, 1024]) {
    const boundedMediaId = "m".repeat(length);
    const boundedManualNote = await requestJson({
      path: "/api/manual-notes",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: { mediaId: boundedMediaId, note: `Bounded media id ${length}` } }),
    });
    if (boundedManualNote.status !== 200 || boundedManualNote.json.entry?.mediaId !== boundedMediaId) {
      throw new Error(`/api/manual-notes rejected a ${length}-character media id.`);
    }
  }
  const oversizedManualNote = await requestJson({
    path: "/api/manual-notes",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note: { mediaId: "m".repeat(1025), note: "Too long" } }),
  });
  if (oversizedManualNote.status !== 400 || oversizedManualNote.json.ok !== false) {
    throw new Error("/api/manual-notes accepted a 1025-character media id.");
  }

  console.log("Server smoke test passed.");
} finally {
  server.kill();
  unavailableCatalogServer?.kill();
  boundedCatalogServer?.kill();
  malformedNotesServer?.kill();
  if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
  await rm(manualNotesPath, { force: true });
  await rm(reviewPath, { force: true });
  await rm(reviewLockPath, { recursive: true, force: true });
  await Promise.all([unavailableReviewPath, boundedReviewPath, malformedNotesReviewPath].flatMap((filePath) => [
    rm(filePath, { force: true }),
    rm(filePath.replace(/\.json$/, ".lock"), { recursive: true, force: true }),
  ]));
  await rm(webClipsPath, { force: true });
  await rm(clipAssetsDir, { recursive: true, force: true });
  await rm(unavailableCatalogPath, { force: true });
  await rm(boundedCatalogPath, { force: true });
  await rm(boundedCardsPath, { force: true });
  await rm(malformedNotesPath, { force: true });
  await Promise.all([
    ...privateAssetAliases.map(({ target }) => rm(target, { force: true })),
    rm(nearMissAliasPath, { force: true }),
    rm(webClipsNearMissAliasPath, { force: true }),
    rm(manualNotesTempPath, { force: true }),
    rm(webClipsTempPath, { force: true }),
    rm(indexTempPath, { force: true }),
    rm(reviewTempPath, { force: true }),
    rm(reviewLockTempPath, { recursive: true, force: true }),
    rm(reviewLockStalePath, { recursive: true, force: true }),
    rm(reviewNearMissPath, { force: true }),
    rm(webClipsNearMissPath, { force: true }),
  ]);
}

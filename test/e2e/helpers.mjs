import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { copyFile, readFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+9d6U4QAAAABJRU5ErkJggg==", "base64");
export const SAMPLE_BOOKMARK_IDS = [
  "sample-interface-001", "sample-website-002", "sample-branding-003", "sample-workspace-004",
  "sample-packaging-005", "sample-motion-006", "sample-editorial-007", "sample-3d-008",
];
export const SAMPLE_CARD_IDS = SAMPLE_BOOKMARK_IDS.map((id) => `${id}-01`);

export const getFreePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});

const waitForServer = async (url, child) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Grid server stopped before becoming ready (${child.exitCode}).`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The child needs a short moment to bind the loopback port.
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error("Timed out waiting for the isolated grid server.");
};

export const startFixtureSite = async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://fixture.invalid");
    if (url.pathname === "/fixture-image.png" || url.pathname === "/favicon.ico") {
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
      res.end(tinyPng);
      return;
    }
    if (url.pathname === "/fixture-page.html") {
      const origin = `http://127.0.0.1:${server.address().port}`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(`<!doctype html><html><head><title>Local clip fixture</title><meta property="og:title" content="Local clip fixture"><meta property="og:description" content="A deterministic local page for browser quality checks."><meta property="og:image" content="${origin}/fixture-image.png"></head><body><main><h1>Local clip fixture</h1><img src="${origin}/fixture-image.png" alt="Fixture image"></main></body></html>`);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/fixture-page.html`,
    imageUrl: `http://127.0.0.1:${port}/fixture-image.png`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
};

const assertFixtureIdentities = (bookmarks, cards) => {
  const bookmarkIds = bookmarks.bookmarks?.map((bookmark) => bookmark.id);
  const cardIds = cards.cards?.map((card) => card.mediaId);
  if (JSON.stringify(bookmarkIds) !== JSON.stringify(SAMPLE_BOOKMARK_IDS)) {
    throw new Error(`Unexpected sample bookmark fixture identities: ${JSON.stringify(bookmarkIds)}`);
  }
  if (JSON.stringify(cardIds) !== JSON.stringify(SAMPLE_CARD_IDS)) {
    throw new Error(`Unexpected sample media-card fixture identities: ${JSON.stringify(cardIds)}`);
  }
};

export const startGridServer = async ({ extensionOrigin = "", catalogRoot = "" } = {}) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "visual-grid-e2e-"));
  const clipsDir = path.join(stateDir, "clips");
  const fixtureDir = path.join(stateDir, "committed-sample-fixture");
  await mkdir(clipsDir, { recursive: true });
  await mkdir(fixtureDir, { recursive: true });
  const bookmarksFixturePath = path.join(fixtureDir, "bookmarks-data.json");
  const cardsFixturePath = path.join(fixtureDir, "media-cards-clean.json");
  await Promise.all([
    copyFile(path.join(repoRoot, "bookmarks-data.sample.json"), bookmarksFixturePath),
    copyFile(path.join(repoRoot, "media-cards.sample.json"), cardsFixturePath),
  ]);
  const [committedBookmarks, committedCards] = await Promise.all([
    readFile(bookmarksFixturePath, "utf8").then(JSON.parse),
    readFile(cardsFixturePath, "utf8").then(JSON.parse),
  ]);
  assertFixtureIdentities(committedBookmarks, committedCards);
  const manualNotesPath = path.join(stateDir, "manual-media-notes.json");
  await writeFile(manualNotesPath, `${JSON.stringify({
    generatedAt: "2026-02-03T10:00:00.000Z",
    source: "browser-quality-fixture",
    notes: {
      "sample-interface-001-01": {
        mediaId: "sample-interface-001-01",
        note: "Kinetic kerning is a fixture-only manual observation.",
        status: "needs_agent_review",
        createdAt: "2026-02-03T10:00:00.000Z",
        updatedAt: "2026-02-03T10:00:00.000Z",
      },
    },
  })}\n`);
  const port = await getFreePort();
  const env = {
    ...process.env,
    PORT: String(port), GRID_HOST: "127.0.0.1", MANUAL_NOTES_PATH: manualNotesPath,
    WEB_CLIPS_PATH: path.join(stateDir, "web-clips.json"), CLIP_ASSETS_DIR: clipsDir,
    CLIP_ASSETS_PUBLIC_PATH: "/assets/e2e-clips", INSPIRATION_INDEX_PATH: path.join(stateDir, "inspiration-index.json"),
    METADATA_REVIEW_PATH: path.join(stateDir, "metadata-review.json"), METADATA_REVIEW_LOCK_PATH: path.join(stateDir, "metadata-review.lock"),
    BOARDS_PATH: path.join(stateDir, "boards.json"), BOARDS_LOCK_PATH: path.join(stateDir, "boards.lock"),
    ALLOWED_EXTENSION_ORIGINS: extensionOrigin,
    GRID_FIXTURE_MODE: "sample", BOOKMARKS_DATA_PATH: bookmarksFixturePath, MEDIA_CARDS_PATH: cardsFixturePath,
    ...(catalogRoot ? { GRID_CATALOG_ROOT: catalogRoot } : {}),
  };
  const child = spawn(process.execPath, ["server.js"], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const baseURL = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(baseURL, child);
    const [bookmarkResponse, cardResponse] = await Promise.all([
      fetch(`${baseURL}/bookmarks-data.json`),
      fetch(`${baseURL}/media-cards-clean.json`),
    ]);
    if (bookmarkResponse.headers.get("x-visual-grid-fixture") !== "sample" || cardResponse.headers.get("x-visual-grid-fixture") !== "sample") {
      throw new Error("E2E server did not confirm its explicit sample fixture mode.");
    }
    assertFixtureIdentities(await bookmarkResponse.json(), await cardResponse.json());
  } catch (error) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    throw new Error(`${error.message}\n${output}`);
  }
  return {
    baseURL, stateDir,
    paths: { clips: env.WEB_CLIPS_PATH, boards: env.BOARDS_PATH, manualNotes: manualNotesPath, bookmarks: bookmarksFixturePath, cards: cardsFixturePath },
    async readJson(filePath) { return JSON.parse(await readFile(filePath, "utf8")); },
    async close() {
      if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
      await rm(stateDir, { recursive: true, force: true });
    },
  };
};

const allowedError = (message, allowlist) => allowlist.some((allowed) =>
  typeof allowed === "string" ? allowed === message : allowed.test(message)
);

export const collectBrowserErrors = (page, scenario, { allowlist = [] } = {}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(`${scenario}: page error: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`${scenario}: console error: ${message.text()}`); });
  const assertNoUnexpectedErrors = () => {
    const unexpected = errors.filter((message) => !allowedError(message, allowlist));
    if (unexpected.length) throw new Error(unexpected.join("\n"));
  };
  assertNoUnexpectedErrors.errors = errors;
  assertNoUnexpectedErrors.assertSeen = (pattern) => {
    if (!errors.some((message) => typeof pattern === "string" ? message === pattern : pattern.test(message))) {
      throw new Error(`${scenario}: expected startup error was not captured.`);
    }
  };
  return assertNoUnexpectedErrors;
};

const boundedErrorMessage = (value) => String(value || "unknown error").replace(/\s+/g, " ").slice(0, 800);

export const collectExtensionWorkerErrors = async (context, scenario, { allowlist = [] } = {}) => {
  const errors = [];
  const attachedTargets = new Set();
  const attachedSessions = new Set();
  const attachWorker = (worker) => {
    worker.on("console", (message) => {
      if (message.type() === "error") errors.push(`${scenario}: worker console error: ${message.text()}`);
    });
    worker.on("close", () => errors.push(`${scenario}: worker closed: ${worker.url()}`));
  };
  context.serviceWorkers().forEach(attachWorker);
  context.on("serviceworker", attachWorker);
  context.on("weberror", (webError) => {
    errors.push(`${scenario}: runtime error: ${webError.error().message}`);
  });

  let cdp;
  const attachTarget = async (target) => {
    if (!cdp || target.type !== "service_worker" || !target.url.startsWith("chrome-extension://") || attachedTargets.has(target.targetId)) return;
    attachedTargets.add(target.targetId);
    try {
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: false });
      attachedSessions.add(sessionId);
      await cdp.send("Target.sendMessageToTarget", {
        sessionId,
        message: JSON.stringify({ id: 1, method: "Runtime.enable" }),
      });
    } catch (error) {
      errors.push(`${scenario}: worker CDP attachment failed: ${boundedErrorMessage(error.message)}`);
    }
  };

  try {
    const browser = context.browser();
    if (!browser) throw new Error("Persistent extension context has no browser connection.");
    cdp = await browser.newBrowserCDPSession();
    cdp.on("Target.targetCreated", ({ targetInfo }) => { void attachTarget(targetInfo); });
    cdp.on("Target.receivedMessageFromTarget", ({ sessionId, message }) => {
      if (!attachedSessions.has(sessionId)) return;
      try {
        const payload = JSON.parse(message);
        if (payload.method !== "Runtime.exceptionThrown") return;
        const details = payload.params?.exceptionDetails;
        const exception = details?.exception || {};
        const detail = exception.description || exception.value || details?.text;
        errors.push(`${scenario}: worker runtime exception: ${boundedErrorMessage(detail)}`);
      } catch (error) {
        errors.push(`${scenario}: worker CDP message failed: ${boundedErrorMessage(error.message)}`);
      }
    });
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    const { targetInfos } = await cdp.send("Target.getTargets");
    await Promise.all(targetInfos.map(attachTarget));
  } catch (error) {
    errors.push(`${scenario}: worker CDP collector failed: ${boundedErrorMessage(error.message)}`);
  }

  const assertNoUnexpectedErrors = () => {
    const unexpected = errors.filter((message) => !allowedError(message, allowlist));
    if (unexpected.length) throw new Error(unexpected.join("\n"));
  };
  assertNoUnexpectedErrors.errors = errors;
  assertNoUnexpectedErrors.dispose = async () => {
    if (!cdp) return;
    await Promise.allSettled([...attachedSessions].map((sessionId) => cdp.send("Target.detachFromTarget", { sessionId })));
    await cdp.detach().catch(() => {});
  };
  return assertNoUnexpectedErrors;
};

export const liveContextPages = (context, limit = 3) => context.pages()
  .filter((page) => !page.isClosed() && page.url() !== "about:blank")
  .slice(0, limit);

const isLoopbackRequest = (url) => {
  try {
    const parsed = new URL(url);
    return !["http:", "https:"].includes(parsed.protocol) || ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
};

export const auditLoopbackRequests = (target, scenario) => {
  const unexpected = [];
  target.on("request", (request) => {
    if (!isLoopbackRequest(request.url())) unexpected.push(`${scenario}: unexpected network request ${request.url()}`);
  });
  return () => { if (unexpected.length) throw new Error(unexpected.join("\n")); };
};

export const assertIgnored = async (relativePath) => {
  const { execFileSync } = await import("node:child_process");
  try { execFileSync("git", ["check-ignore", "-q", "--", relativePath], { cwd: repoRoot, stdio: "ignore" }); }
  catch { throw new Error(`Expected ${relativePath} to be ignored by the repository privacy boundary.`); }
};

export const waitForGrid = async (page) => {
  await page.waitForSelector(".grid-item[role='button']:visible");
};

export const visibleGridItems = (page) => page.locator(".grid-item[role='button']:visible");

export const rect = async (locator) => locator.evaluate((element) => {
  const box = element.getBoundingClientRect();
  return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
});
export const assertInsideViewport = async (locator, viewport) => {
  const box = await rect(locator);
  if (box.left < 0 || box.top < 0 || box.right > viewport.width || box.bottom > viewport.height) throw new Error(`Expected element inside ${viewport.width}x${viewport.height}, got ${JSON.stringify(box)}.`);
};
export const assertNotIntersecting = async (first, second) => {
  const [a, b] = await Promise.all([rect(first), rect(second)]);
  if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) throw new Error(`Unexpected intersection: ${JSON.stringify(a)} vs ${JSON.stringify(b)}.`);
};
export const assertTextFits = async (locator) => {
  const overflow = await locator.evaluate((element) => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1);
  if (overflow) throw new Error("Expected visible text to fit its control bounds.");
};
export const assertDocumentFitsViewport = async (page) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (overflow) throw new Error("Document has horizontal overflow.");
};
export const assertVisibleMedia = async (locator) => {
  const media = locator.locator("img").first();
  const visible = await media.evaluate((image) => image.getBoundingClientRect().width > 0 && image.getBoundingClientRect().height > 0 && image.complete && image.naturalWidth > 0);
  if (!visible) throw new Error("Expected nonblank visible media.");
};
export const fileExists = (filePath) => existsSync(filePath);

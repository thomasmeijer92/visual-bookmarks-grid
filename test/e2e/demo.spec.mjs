import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertDocumentFitsViewport,
  assertInsideViewport,
  collectBrowserErrors,
  getFreePort,
  repoRoot,
  visibleGridItems,
  waitForGrid,
} from "./helpers.mjs";

const SITE_PREFIX = "/visual-bookmarks-grid";
const MIME = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

const startPublicDemo = async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "visual-grid-pages-demo-"));
  execFileSync(process.execPath, ["tools/build-public-demo.mjs", "--output", outputDir], {
    cwd: repoRoot,
    stdio: "pipe",
  });

  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url || "/", "http://demo.invalid").pathname);
      if (pathname !== SITE_PREFIX && !pathname.startsWith(`${SITE_PREFIX}/`)) {
        res.writeHead(404).end("Not found");
        return;
      }
      const relative = pathname === SITE_PREFIX || pathname === `${SITE_PREFIX}/`
        ? "index.html"
        : pathname.slice(SITE_PREFIX.length + 1);
      const target = path.resolve(outputDir, relative);
      if (target !== outputDir && !target.startsWith(`${outputDir}${path.sep}`)) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      const content = await readFile(target);
      res.writeHead(200, {
        "Content-Type": MIME.get(path.extname(target)) || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(content);
    } catch {
      res.writeHead(404).end("Not found");
    }
  });
  const port = await getFreePort();
  server.listen(port, "127.0.0.1");
  await once(server, "listening");

  return {
    baseURL: `http://127.0.0.1:${port}${SITE_PREFIX}/`,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(outputDir, { recursive: true, force: true });
    },
  };
};

let site;
let browserErrors;
let apiRequests;

test.beforeAll(async () => { site = await startPublicDemo(); });
test.afterAll(async () => { await site?.close(); });
test.beforeEach(async ({ page }, testInfo) => {
  apiRequests = [];
  browserErrors = collectBrowserErrors(page, testInfo.title);
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes("/api/")) apiRequests.push(`${request.method()} ${url.pathname}`);
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(site.baseURL);
  await waitForGrid(page);
});

test("Pages demo is sample-only, read-only, and free of API failures", async ({ page }) => {
  await expect(page.locator("html")).toHaveAttribute("data-public-demo", "true");
  await expect(page.locator("#clip-add-button")).toBeHidden();
  await expect(page.locator("#board-create-button")).toBeHidden();

  const search = page.locator("#search-input");
  await search.fill("operations dashboard");
  await expect(page.locator("#search-live")).toHaveText("1 bookmark found");
  await search.fill("");

  const first = visibleGridItems(page).first();
  await first.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#lightbox-overlay")).toBeVisible();
  await expect(page.locator("#manual-note-section")).toBeHidden();
  await expect(page.locator("#lightbox-link")).toHaveAttribute("href", /^https:\/\/example\.com\//);
  await page.keyboard.press("Escape");

  expect(apiRequests).toEqual([]);
  browserErrors();
});

test("Pages demo fits compact screens without exposing write controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await waitForGrid(page);
  await assertDocumentFitsViewport(page);
  await assertInsideViewport(page.locator("#search-bar"), { width: 390, height: 844 });
  await expect(page.locator("#clip-add-button")).toBeHidden();
  await expect(page.locator("#board-create-button")).toBeHidden();
  await expect(visibleGridItems(page).first()).toBeVisible();

  expect(apiRequests).toEqual([]);
  browserErrors();
});

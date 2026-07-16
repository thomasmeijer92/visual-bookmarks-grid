import { expect, test, chromium } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  auditLoopbackRequests,
  collectBrowserErrors,
  collectExtensionWorkerErrors,
  liveContextPages,
  repoRoot,
  startFixtureSite,
  startGridServer,
} from "./helpers.mjs";
import { saveLastResult } from "../../chrome-extension/clipper-client.mjs";
import { createImageContextMenuHandler } from "../../chrome-extension/image-context-menu.mjs";
import { saveImageClip } from "../../chrome-extension/image-save.mjs";

const extensionDir = path.join(repoRoot, "chrome-extension");

const createStorage = (initial = {}) => {
  const values = { ...initial };
  return {
    values,
    async get(keys) {
      return Object.fromEntries(keys.filter((key) => key in values).map((key) => [key, values[key]]));
    },
    async set(payload) {
      Object.assign(values, payload);
    },
  };
};

test("loads the unpacked MV3 extension, saves loopback previews, and exercises the production image path", async ({}, testInfo) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "visual-grid-extension-profile-"));
  const fixture = await startFixtureSite();
  let context;
  let grid;
  let traceStarted = false;
  let assertWorkerErrors;
  const failurePages = new Map();
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
      ],
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    traceStarted = true;
    const assertLoopbackRequests = auditLoopbackRequests(context, "extension-context");
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    assertWorkerErrors = await collectExtensionWorkerErrors(context, "extension-worker");
    const workerUrl = new URL(worker.url());
    const extensionOrigin = `${workerUrl.protocol}//${workerUrl.host}`;
    grid = await startGridServer({ extensionOrigin });
    const manifest = JSON.parse(await readFile(path.join(extensionDir, "manifest.json"), "utf8"));
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background.service_worker).toBe("background.js");
    expect(manifest.action.default_popup).toBe("popup.html");
    await expect(worker.url()).toContain("background.js");

    const source = await context.newPage();
    failurePages.set("source", source);
    const assertSourceErrors = collectBrowserErrors(source, "extension-fixture-page");
    const assertSourceRequests = auditLoopbackRequests(source, "extension-fixture-page");
    await source.goto(fixture.url);

    const popup = await context.newPage();
    failurePages.set("popup", popup);
    const assertPopupErrors = collectBrowserErrors(popup, "extension-popup");
    const assertPopupRequests = auditLoopbackRequests(popup, "extension-popup");
    await popup.addInitScript((tab) => {
      Object.defineProperty(chrome.tabs, "query", {
        configurable: true,
        value: async () => [tab],
      });
    }, { url: fixture.url, title: "Local clip fixture", favIconUrl: "" });
    await popup.goto(`${extensionOrigin}/popup.html`);
    await expect(popup.locator("#clip-form")).toBeVisible();
    await popup.locator(".server-details summary").click();
    await popup.locator("#server-url").fill(grid.baseURL);
    await popup.locator("#tags-input").fill("extension, fixture");
    await popup.locator("#clip-form").evaluate((form) => form.requestSubmit());
    await expect(popup.locator("#success-panel")).toBeVisible();
    await expect(popup.locator("#success-title")).toHaveText("Local clip fixture");
    const saved = await grid.readJson(grid.paths.clips);
    expect(saved.clips).toHaveLength(1);
    const successPreview = await popup.locator("#success-image").evaluate((image) => image.src);
    expect(successPreview).toBe(`${grid.baseURL}${saved.clips[0].media.url}`);
    expect((await fetch(successPreview)).ok).toBe(true);
    const successImage = await popup.locator("#success-image").evaluate((image) => ({ complete: image.complete, naturalWidth: image.naturalWidth }));
    expect(successImage.complete).toBe(true);
    expect(successImage.naturalWidth).toBeGreaterThan(0);

    const storage = createStorage({ settings: { serverUrl: grid.baseURL } });
    const imageInfo = { menuItemId: "save-image-to-bookmarks-grid", pageUrl: fixture.url, srcUrl: fixture.imageUrl };
    const savedImage = await saveImageClip(imageInfo, { title: "Fixture image" }, { storageArea: storage });
    expect(savedImage.captureMode).toBe("image");
    expect(savedImage.sourceUrl).toBe(fixture.url);
    expect(savedImage.media.sourceUrl).toBe(fixture.imageUrl);
    expect(savedImage.media.url).toMatch(/^\/assets\/e2e-clips\/web-/);
    const handler = createImageContextMenuHandler({
      storageArea: storage,
      saveImage: (info, tab) => saveImageClip(info, tab, { storageArea: storage }),
      saveResult: saveLastResult,
      openResult: () => {},
    });
    await expect(handler(imageInfo, { title: "Fixture image" })).resolves.toBe(true);
    expect(storage.values.lastSave).toMatchObject({ ok: true, source: "context-menu", clip: { captureMode: "image", sourceUrl: fixture.url } });
    expect(storage.values.lastSave.clip.media.sourceUrl).toBe(fixture.imageUrl);
    await expect(handler({ menuItemId: "save-image-to-bookmarks-grid", pageUrl: fixture.url }, { title: "Fixture image" })).resolves.toBe(true);
    expect(storage.values.lastSave).toMatchObject({ ok: false, source: "context-menu", error: "Could not read the image URL from this page." });
    const imageRecords = (await grid.readJson(grid.paths.clips)).clips.filter((clip) => clip.captureMode === "image");
    expect(imageRecords).toHaveLength(1);
    expect(imageRecords[0].media.sourceUrl).toBe(fixture.imageUrl);
    expect(grid.paths.clips.startsWith(grid.stateDir)).toBe(true);

    await popup.evaluate(async () => chrome.storage.local.set({
      settings: { serverUrl: "https://example.invalid" },
      lastSave: { ok: true, source: "popup", clip: { title: "Unsafe preview", media: { url: "/preview.png" } } },
    }));
    const resultPopup = await context.newPage();
    failurePages.set("result", resultPopup);
    const assertResultErrors = collectBrowserErrors(resultPopup, "extension-result-popup");
    const assertResultRequests = auditLoopbackRequests(resultPopup, "extension-result-popup");
    await resultPopup.goto(`${extensionOrigin}/popup.html?result=1`);
    await expect(resultPopup.locator("#success-title")).toHaveText("Unsafe preview");
    expect(await resultPopup.locator("#success-image").evaluate((image) => image.src)).toBe(`${extensionOrigin}/icon.svg`);

    assertSourceErrors();
    assertPopupErrors();
    assertResultErrors();
    assertSourceRequests();
    assertPopupRequests();
    assertResultRequests();
    assertWorkerErrors();
    assertLoopbackRequests();
  } catch (error) {
    for (const [index, page] of liveContextPages(context || { pages: () => [] }).entries()) {
      if (![...failurePages.values()].includes(page)) failurePages.set(`page-${index + 1}`, page);
    }
    await Promise.all([...failurePages]
      .filter(([, page]) => !page.isClosed() && page.url() !== "about:blank")
      .map(([name, page]) => page.screenshot({ path: testInfo.outputPath(`persistent-context-failure-${name}.png`), fullPage: true }).catch(() => {})));
    if (traceStarted) await context?.tracing.stop({ path: testInfo.outputPath("persistent-context-trace.zip") }).catch(() => {});
    traceStarted = false;
    throw error;
  } finally {
    if (traceStarted) await context?.tracing.stop().catch(() => {});
    await assertWorkerErrors?.dispose();
    await context?.close();
    await grid?.close();
    await fixture.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("a delayed exception from a real unpacked service worker fails the worker error gate", async () => {
  const extension = await mkdtemp(path.join(os.tmpdir(), "visual-grid-delayed-worker-extension-"));
  const profile = await mkdtemp(path.join(os.tmpdir(), "visual-grid-delayed-worker-profile-"));
  let context;
  let assertWorkerErrors;
  try {
    await writeFile(path.join(extension, "manifest.json"), JSON.stringify({
      manifest_version: 3,
      name: "Delayed worker test",
      version: "0.0.1",
      background: { service_worker: "background.js", type: "module" },
    }));
    await writeFile(path.join(extension, "background.js"), 'setTimeout(() => { throw new Error("delayed service worker failure"); }, 300);\n');
    context = await chromium.launchPersistentContext(profile, {
      headless: false,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    await (context.serviceWorkers()[0] ? Promise.resolve() : context.waitForEvent("serviceworker"));
    assertWorkerErrors = await collectExtensionWorkerErrors(context, "delayed-worker");
    await expect.poll(() => assertWorkerErrors.errors.some((message) => message.includes("delayed service worker failure"))).toBe(true);
    expect(() => assertWorkerErrors()).toThrow(/delayed service worker failure/);
  } finally {
    await assertWorkerErrors?.dispose();
    await context?.close();
    await Promise.all([rm(extension, { recursive: true, force: true }), rm(profile, { recursive: true, force: true })]);
  }
});

test("a broken shared worker import is a hard extension loading failure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "visual-grid-broken-import-"));
  const brokenWorker = path.join(directory, "background.mjs");
  await writeFile(brokenWorker, 'import "./missing-shared-module.mjs";\n');
  try {
    await expect(import(`${pathToFileURL(brokenWorker).href}?broken=${Date.now()}`)).rejects.toThrow(/missing-shared-module/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

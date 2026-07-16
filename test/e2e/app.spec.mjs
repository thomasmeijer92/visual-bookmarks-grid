import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  assertDocumentFitsViewport,
  assertIgnored,
  assertInsideViewport,
  assertNotIntersecting,
  assertTextFits,
  assertVisibleMedia,
  auditLoopbackRequests,
  collectBrowserErrors,
  fileExists,
  startFixtureSite,
  startGridServer,
  visibleGridItems,
  waitForGrid,
} from "./helpers.mjs";

let grid;
let fixture;
let assertAppErrors;
let assertLoopbackRequests;
const STARTUP_PROBE = "visual-grid-quality-gate-startup-probe";

const assertHealthy = () => {
  assertAppErrors();
  assertLoopbackRequests();
};

const visibleLabels = (page) => visibleGridItems(page).evaluateAll((items) => [...new Set(items.map((item) => item.getAttribute("aria-label")))]);

test.beforeAll(async () => {
  await Promise.all([assertIgnored("test-results/"), assertIgnored("playwright-report/"), assertIgnored("test-artifacts/")]);
  const started = await Promise.allSettled([startGridServer(), startFixtureSite()]);
  if (started.some((result) => result.status === "rejected")) {
    await Promise.allSettled(started.filter((result) => result.status === "fulfilled").map((result) => result.value.close()));
    throw started.find((result) => result.status === "rejected").reason;
  }
  [grid, fixture] = started.map((result) => result.value);
});
test.afterAll(async () => { await Promise.all([grid?.close(), fixture?.close()]); });
test.beforeEach(async ({ page }, testInfo) => {
  const probe = testInfo.title.includes("captures startup errors");
  assertAppErrors = collectBrowserErrors(page, testInfo.title, {
    allowlist: probe ? [`${testInfo.title}: console error: ${STARTUP_PROBE}`] : [],
  });
  assertLoopbackRequests = auditLoopbackRequests(page, testInfo.title);
  if (probe) await page.addInitScript((message) => console.error(message), STARTUP_PROBE);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(grid.baseURL);
  await waitForGrid(page);
});

test("captures startup errors before app navigation", async () => {
  assertAppErrors.assertSeen(new RegExp(STARTUP_PROBE));
  assertHealthy();
});

test("loads only committed sample content and settles rapid filters on Branding", async ({ page }) => {
  expect(await visibleLabels(page)).toContain("Open Three metric cards sit below a wide header control, with one primary action at the lower right.");
  await assertVisibleMedia(visibleGridItems(page).first());
  await expect(page.locator("#search-input")).toBeVisible();
  await page.locator("#filter-chips").evaluate(() => {
    [...document.querySelectorAll(".filter-chip")].find((button) => button.getAttribute("aria-label")?.startsWith("Filter by Interface"))?.click();
    [...document.querySelectorAll(".filter-chip")].find((button) => button.getAttribute("aria-label")?.startsWith("Filter by Branding"))?.click();
  });
  await expect(page.getByRole("button", { name: /Filter by Branding/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#search-live")).toHaveText("1 bookmark matching Branding");
  expect(await visibleLabels(page)).toEqual(["Open Brand identity poster with a tight wordmark, warm neutrals, and bold color accents."]);
  assertHealthy();
});

test("searches metadata and fixture manual notes", async ({ page }) => {
  const search = page.locator("#search-input");
  await search.fill("operations dashboard");
  await expect(page.locator("#search-live")).toHaveText("1 bookmark found");
  await search.fill("kinetic kerning");
  await expect(page.locator("#search-live")).toHaveText("1 bookmark found");
  assertHealthy();
});

test("reduced motion filters commit synchronously without the fade delay", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await waitForGrid(page);
  const immediate = await page.getByRole("button", { name: /Filter by Branding/ }).evaluate((button) => {
    button.click();
    return {
      live: document.querySelector("#search-live")?.textContent,
      opacity: document.querySelector("#grid")?.style.opacity,
      transition: document.querySelector("#grid")?.style.transition,
      visible: [...new Set([...document.querySelectorAll(".grid-item[role='button']")].filter((item) => item.style.display !== "none").map((item) => item.getAttribute("aria-label")))],
    };
  });
  expect(immediate).toEqual({
    live: "1 bookmark matching Branding",
    opacity: "1",
    transition: "",
    visible: ["Open Brand identity poster with a tight wordmark, warm neutrals, and bold color accents."],
  });
  assertHealthy();
});

test("compact Add URL dialog traps focus, restores it, and saves a local fixture", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const trigger = page.getByRole("button", { name: "Save URL" });
  await trigger.focus();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Save URL" });
  await expect(dialog).toBeVisible();
  await assertInsideViewport(dialog, { width: 390, height: 844 });
  await page.locator("#clip-save").focus();
  await page.keyboard.press("Tab");
  await expect(page.locator("#clip-close")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.locator("#clip-url-input").fill(fixture.url);
  await page.locator("#clip-tags-input").fill("fixture, local");
  await page.locator("#clip-form").evaluate((form) => form.requestSubmit());
  await expect(page.locator("#clip-status")).toHaveText("Saved to your inspiration grid.");
  await expect.poll(() => fileExists(grid.paths.clips)).toBe(true);
  const clips = await grid.readJson(grid.paths.clips);
  expect(clips.clips).toHaveLength(1);
  expect(clips.clips[0].title).toBe("Local clip fixture");
  assertHealthy();
});

test("keyboard lightbox navigates metadata and restores focus and inert state", async ({ page }) => {
  const first = visibleGridItems(page).first();
  await first.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#lightbox-overlay")).toBeVisible();
  await expect(page.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  const initial = await page.locator("#lightbox-info").evaluate(() => ({
    title: document.querySelector("#lightbox-title")?.textContent,
    source: document.querySelector("#lightbox-source")?.textContent,
    href: document.querySelector("#lightbox-link")?.getAttribute("href"),
  }));
  expect(initial).toEqual({
    title: "Interaction Storyboard",
    source: "Sample",
    href: "https://example.com/samples/motion-storyboard",
  });
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#lightbox-title")).not.toHaveText(initial.title || "");
  await expect.poll(() => page.locator(".grid-item.lightbox-active").evaluate((element) => element.style.willChange)).toBe("auto");
  const next = await page.locator("#lightbox-info").evaluate(() => ({
    title: document.querySelector("#lightbox-title")?.textContent,
    source: document.querySelector("#lightbox-source")?.textContent,
    href: document.querySelector("#lightbox-link")?.getAttribute("href"),
  }));
  expect(next).toEqual({
    title: "Field Notes Layout",
    source: "Sample",
    href: "https://example.com/samples/editorial-layout",
  });
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => page.locator(".grid-item.lightbox-active").evaluate((element) => element.style.willChange)).toBe("auto");
  await expect(page.locator("#lightbox-title")).toHaveText(initial.title || "");
  await expect(page.locator("#lightbox-source")).toHaveText(initial.source || "");
  await expect(page.locator("#lightbox-link")).toHaveAttribute("href", initial.href || "");
  await page.getByRole("button", { name: "Close", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Previous bookmark" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#lightbox-overlay")).toHaveAttribute("inert", "");
  await expect(first).toBeFocused();
  assertHealthy();
});

test("board reorder persists through reload and exports the reordered Markdown", async ({ page }) => {
  await page.getByRole("button", { name: /Filter by Interface/ }).click();
  await expect(page.locator("#search-live")).toHaveText("2 bookmarks matching Interface");
  await page.getByRole("button", { name: "Create board from filtered results" }).click();
  await page.locator("#board-name-input").fill("Fixture board");
  await page.locator("#board-selection-list input").first().check();
  await page.locator("#board-selection-list input").nth(1).check();
  await page.locator("#board-form").evaluate((form) => form.requestSubmit());
  await expect(page.locator("#board-header-name")).toHaveText("Fixture board");
  const before = await grid.readJson(grid.paths.boards);
  const originalOrder = before.boards[0].items.map((item) => item.itemId);
  expect(originalOrder).toHaveLength(2);
  const item = page.getByRole("button", { name: /Compact Operations Dashboard/ }).first();
  await item.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#board-move-later")).toBeEnabled();
  await page.locator("#board-move-later").click();
  await expect.poll(async () => (await grid.readJson(grid.paths.boards)).boards[0].items.map((entry) => entry.itemId)).toEqual([...originalOrder].reverse());
  await page.reload();
  await waitForGrid(page);
  await expect(page.locator("#board-header-name")).toHaveText("Fixture board");
  await page.getByRole("button", { name: /Interaction Storyboard/ }).first().focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await expect(page.locator("#board-move-earlier")).toBeDisabled();
  await expect(page.locator("#board-move-later")).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.locator("#lightbox-overlay")).toHaveAttribute("inert", "");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export" }).click();
  const markdown = await readFile(await (await download).path(), "utf8");
  expect(markdown).toContain("# Fixture board");
  const expectedEntries = [
    "1. Interaction Storyboard",
    "   [Source](<https://example.com/samples/motion-storyboard>)",
    "2. Compact Operations Dashboard",
    "   [Source](<https://example.com/samples/interface-dashboard>)",
  ];
  for (const entry of expectedEntries) expect(markdown).toContain(entry);
  const interactionIndex = markdown.indexOf("Interaction Storyboard");
  const compactIndex = markdown.indexOf("Compact Operations Dashboard");
  expect(interactionIndex).toBeGreaterThanOrEqual(0);
  expect(compactIndex).toBeGreaterThanOrEqual(0);
  expect(interactionIndex).toBeLessThan(compactIndex);
  await page.getByRole("button", { name: "Close board" }).click();
  await expect(page.locator("#board-header")).toBeHidden();
  assertHealthy();
});

test("desktop and compact layout surfaces fit without collisions", async ({ page }) => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.reload();
    await waitForGrid(page);
    await assertDocumentFitsViewport(page);
    await assertVisibleMedia(visibleGridItems(page).first());
    for (const locator of [page.locator("#search-bar"), page.getByRole("button", { name: /Filter by Interface/ }), page.getByRole("button", { name: "Save URL" }), page.getByRole("button", { name: "Create board from filtered results" })]) {
      await assertInsideViewport(locator, viewport);
      await assertTextFits(locator);
    }
    await assertNotIntersecting(page.locator("#search-bar"), page.getByRole("button", { name: /Filter by Interface/ }));
    await assertNotIntersecting(page.locator("#search-bar"), page.getByRole("button", { name: "Save URL" }));
    await page.getByRole("button", { name: "Save URL" }).click();
    await assertInsideViewport(page.getByRole("dialog", { name: "Save URL" }), viewport);
    await assertNotIntersecting(page.locator("#clip-cancel"), page.locator("#clip-save"));
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /Filter by Interface/ }).click();
    await expect(page.locator("#search-live")).toHaveText("2 bookmarks matching Interface");
    await page.getByRole("button", { name: "Create board from filtered results" }).click();
    await page.locator("#board-name-input").fill(`Layout ${viewport.width}`);
    await page.locator("#board-selection-list input").first().check();
    await page.locator("#board-form").evaluate((form) => form.requestSubmit());
    await assertInsideViewport(page.locator("#board-header"), viewport);
    await assertNotIntersecting(page.getByRole("button", { name: "Export" }), page.getByRole("button", { name: "Close board" }));
    await visibleGridItems(page).first().press("Enter");
    await expect(page.locator("#lightbox-overlay")).toBeVisible();
    await expect(page.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    for (const locator of [page.locator("#lightbox-info"), page.getByRole("button", { name: "Close", exact: true }), page.getByRole("button", { name: "Previous bookmark" }), page.getByRole("button", { name: "Next bookmark" })]) {
      await assertInsideViewport(locator, viewport);
    }
    await assertNotIntersecting(page.getByRole("button", { name: "Close", exact: true }), page.getByRole("button", { name: "Previous bookmark" }));
    await assertNotIntersecting(page.getByRole("button", { name: "Previous bookmark" }), page.getByRole("button", { name: "Next bookmark" }));
    await page.keyboard.press("Escape");
    await expect(page.locator("#lightbox-overlay")).toHaveAttribute("inert", "");
    await page.getByRole("button", { name: "Close board" }).click();
  }
  assertHealthy();
});

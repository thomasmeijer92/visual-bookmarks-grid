import assert from "node:assert/strict";
import test from "node:test";
import { createImageContextMenuHandler } from "../chrome-extension/image-context-menu.mjs";

test("the context-menu handler loads through Node's explicit .mjs module boundary", async () => {
  const outcomes = [];
  const handler = createImageContextMenuHandler({
    storageArea: {},
    saveImage: async () => ({ title: "Fixture image" }),
    saveResult: async (_storage, result) => outcomes.push(result),
    openResult: () => outcomes.push({ opened: true }),
  });

  assert.equal(await handler({ menuItemId: "other-menu" }), false);
  assert.equal(await handler({ menuItemId: "save-image-to-bookmarks-grid" }), true);
  assert.deepEqual(outcomes, [
    { ok: true, clip: { title: "Fixture image" }, source: "context-menu" },
    { opened: true },
  ]);
});

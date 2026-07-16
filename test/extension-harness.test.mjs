import assert from "node:assert/strict";
import test from "node:test";
import { liveContextPages } from "./e2e/helpers.mjs";

test("failure screenshots exclude blank and closed extension pages", () => {
  const pages = [
    { url: () => "about:blank", isClosed: () => false },
    { url: () => "chrome-extension://test/popup.html", isClosed: () => false },
    { url: () => "chrome-extension://test/result.html", isClosed: () => true },
    { url: () => "chrome-extension://test/source.html", isClosed: () => false },
    { url: () => "chrome-extension://test/extra.html", isClosed: () => false },
    { url: () => "chrome-extension://test/overflow.html", isClosed: () => false },
  ];
  assert.deepEqual(liveContextPages({ pages: () => pages }), [pages[1], pages[3], pages[4]]);
});

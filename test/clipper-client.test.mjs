import test from "node:test";
import assert from "node:assert/strict";

import {
  LAST_SAVE_KEY,
  SETTINGS_KEY,
  getSettings,
  normalizeServerUrl,
  requestClip,
  resolvePreviewAssetUrl,
  saveLastResult,
  saveSettings,
} from "../chrome-extension/clipper-client.mjs";

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

test("server URL normalization is shared by popup and context-menu saves", () => {
  assert.equal(normalizeServerUrl(" http://localhost:4444/// "), "http://localhost:4444");
  assert.equal(normalizeServerUrl(""), "http://127.0.0.1:3000");
});

test("preview assets stay on the configured local server origin", () => {
  assert.equal(
    resolvePreviewAssetUrl("/assets/e2e-clips/fixture/image.png", "http://127.0.0.1:4312"),
    "http://127.0.0.1:4312/assets/e2e-clips/fixture/image.png"
  );
  assert.equal(resolvePreviewAssetUrl("https://example.invalid/preview.png", "http://127.0.0.1:4312"), "");
  assert.equal(resolvePreviewAssetUrl("http://127.0.0.1:9999/preview.png", "http://127.0.0.1:4312"), "");
  assert.equal(resolvePreviewAssetUrl("/preview.png", "https://example.invalid"), "");
  assert.equal(resolvePreviewAssetUrl("/preview.png", "https://loopback.example.invalid:4312"), "");
  assert.equal(resolvePreviewAssetUrl("/preview.png", "http://[::1]:4312"), "http://[::1]:4312/preview.png");
  assert.equal(resolvePreviewAssetUrl("/preview.png", "https://localhost:4312"), "https://localhost:4312/preview.png");
});

test("extension settings and save results use one storage shape", async () => {
  const storage = createStorage();
  await saveSettings(storage, { serverUrl: "http://localhost:4444/" });
  assert.deepEqual(await getSettings(storage), { serverUrl: "http://localhost:4444" });

  const now = () => new Date("2026-07-10T08:00:00.000Z");
  await saveLastResult(storage, { ok: true, clip: { id: "clip-1" } }, now);
  assert.deepEqual(storage.values[LAST_SAVE_KEY], {
    ok: true,
    clip: { id: "clip-1" },
    savedAt: "2026-07-10T08:00:00.000Z",
  });
  assert.equal(storage.values[SETTINGS_KEY].serverUrl, "http://localhost:4444");
});

test("clip requests share response validation and preserve the API payload", async () => {
  let capturedRequest;
  const clip = await requestClip({
    serverUrl: "http://localhost:4444/",
    clip: { url: "https://example.com", tags: "branding" },
    fetchImpl: async (url, options) => {
      capturedRequest = { url, options };
      return {
        ok: true,
        async json() {
          return { ok: true, clip: { id: "clip-1", title: "Example" } };
        },
      };
    },
  });

  assert.deepEqual(clip, { id: "clip-1", title: "Example" });
  assert.equal(capturedRequest.url, "http://localhost:4444/api/clips");
  assert.equal(capturedRequest.options.method, "POST");
  assert.deepEqual(JSON.parse(capturedRequest.options.body), {
    clip: { url: "https://example.com", tags: "branding" },
  });
});

test("clip requests surface server errors and stable fallback copy", async () => {
  await assert.rejects(
    requestClip({
      serverUrl: "http://localhost:4444",
      clip: { url: "https://example.com" },
      fetchImpl: async () => ({
        ok: false,
        async json() {
          return { error: "Metadata fetch failed." };
        },
      }),
    }),
    /Metadata fetch failed/
  );

  await assert.rejects(
    requestClip({
      serverUrl: "http://localhost:4444",
      clip: { url: "https://example.com" },
      fallbackError: "Could not save page.",
      fetchImpl: async () => ({
        ok: false,
        async json() {
          throw new Error("Invalid response");
        },
      }),
    }),
    /Could not save page/
  );
});

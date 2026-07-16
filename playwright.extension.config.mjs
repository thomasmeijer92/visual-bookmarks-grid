import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: "extension.spec.mjs",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [["line"]] : [["list"]],
  use: {
    // The persistent extension context owns failure-only capture explicitly.
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  outputDir: "test-results/extension",
});

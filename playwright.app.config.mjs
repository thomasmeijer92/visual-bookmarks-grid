import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: "app.spec.mjs",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [["line"]] : [["list"]],
  use: {
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  outputDir: "test-results/app",
});

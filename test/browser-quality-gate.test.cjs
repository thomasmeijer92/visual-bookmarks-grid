const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const rootDir = path.resolve(__dirname, "..");
const browserOutputPaths = ["test-results/", "playwright-report/", "test-artifacts/"];

test("browser quality gate output paths are exact ignored repository artifacts", () => {
  for (const outputPath of browserOutputPaths) {
    const result = execFileSync("git", ["check-ignore", "-q", "--", outputPath], {
      cwd: rootDir,
      stdio: "pipe",
    });
    assert.equal(result.length, 0);
  }
});

test("browser quality gate requires explicit sample fixture paths", () => {
  const serverSource = fs.readFileSync(path.join(rootDir, "server.js"), "utf8");
  const helperSource = fs.readFileSync(path.join(rootDir, "test", "e2e", "helpers.mjs"), "utf8");
  assert.match(serverSource, /GRID_FIXTURE_MODE/);
  assert.match(serverSource, /BOOKMARKS_DATA_PATH and MEDIA_CARDS_PATH/);
  assert.match(serverSource, /Fixture mode never consults the repository's ignored local exports/);
  assert.match(serverSource, /X-Visual-Grid-Fixture/);
  assert.match(helperSource, /GRID_FIXTURE_MODE: "sample"/);
  assert.match(helperSource, /x-visual-grid-fixture/);
});

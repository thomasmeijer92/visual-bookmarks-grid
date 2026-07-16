const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const rootDir = path.resolve(__dirname, "..");

const listFiles = (directory, prefix = "") => fs.readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const relative = path.join(prefix, entry.name);
    return entry.isDirectory() ? listFiles(path.join(directory, entry.name), relative) : [relative];
  })
  .sort();

test("public demo build is self-contained, sample-only, and explicitly read-only", () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "visual-grid-public-demo-"));
  try {
    execFileSync(process.execPath, ["tools/build-public-demo.mjs", "--output", outputDir], {
      cwd: rootDir,
      stdio: "pipe",
    });

    const files = listFiles(outputDir);
    const expectedFiles = [
      "app.js",
      "audio-feedback.js",
      path.join("assets", "favicon.svg"),
      path.join("assets", "play-icon.svg"),
      path.join("assets", "sample-branding.svg"),
      path.join("assets", "sample-editorial.svg"),
      path.join("assets", "sample-interface.svg"),
      path.join("assets", "sample-motion.svg"),
      path.join("assets", "sample-packaging.svg"),
      path.join("assets", "sample-workspace.svg"),
      "board-history.js",
      "board-repair.js",
      "index.html",
      "bookmarks-data.json",
      "browser-loader.js",
      "media-cards-clean.json",
      path.join("node_modules", "@web-kits", "audio", "dist", "index.js"),
      path.join("node_modules", "motion", "dist", "motion.js"),
      "public-demo.js",
      "style.css",
      "url-contract.js",
    ].sort();
    assert.deepEqual(files, expectedFiles);

    const index = fs.readFileSync(path.join(outputDir, "index.html"), "utf8");
    assert.ok(index.indexOf("public-demo.js") < index.indexOf("style.css"));
    assert.match(fs.readFileSync(path.join(outputDir, "public-demo.js"), "utf8"), /__VISUAL_GRID_PUBLIC_DEMO__ = true/);
    assert.match(fs.readFileSync(path.join(outputDir, "app.js"), "utf8"), /if \(PUBLIC_DEMO\) return/);

    const builtBookmarks = JSON.parse(fs.readFileSync(path.join(outputDir, "bookmarks-data.json"), "utf8"));
    const sourceBookmarks = JSON.parse(fs.readFileSync(path.join(rootDir, "bookmarks-data.sample.json"), "utf8"));
    const builtCards = JSON.parse(fs.readFileSync(path.join(outputDir, "media-cards-clean.json"), "utf8"));
    const sourceCards = JSON.parse(fs.readFileSync(path.join(rootDir, "media-cards.sample.json"), "utf8"));
    assert.deepEqual(builtBookmarks, sourceBookmarks);
    assert.deepEqual(builtCards, sourceCards);

    const text = files
      .filter((file) => /\.(?:html|js|css|json|svg)$/i.test(file))
      .map((file) => fs.readFileSync(path.join(outputDir, file), "utf8"))
      .join("\n");
    assert.doesNotMatch(text, /\/Users\/|\/home\/|linku|hallo@thomas|auth_token|oauth-token|github_pat_|ghp_/i);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

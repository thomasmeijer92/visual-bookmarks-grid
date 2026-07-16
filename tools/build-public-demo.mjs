import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputFlagIndex = process.argv.indexOf("--output");
const outputValue = outputFlagIndex >= 0 ? process.argv[outputFlagIndex + 1] : "dist";

if (!outputValue || outputValue.startsWith("--")) {
  throw new Error("--output requires a directory path.");
}

const outputDir = path.resolve(process.cwd(), outputValue);
const defaultOutputDir = path.join(rootDir, "dist");
const temporaryRoot = path.resolve(os.tmpdir());
const isTemporaryOutput = outputDir.startsWith(`${temporaryRoot}${path.sep}`);
if (outputDir !== defaultOutputDir && !isTemporaryOutput) {
  throw new Error("Public demo output must be the repository dist directory or an operating-system temporary directory.");
}

const copyIntoDemo = async (source, destination = source) => {
  const target = path.join(outputDir, destination);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(rootDir, source), target);
};

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const publicDemoFiles = [
  "style.css",
  "app.js",
  "audio-feedback.js",
  "url-contract.js",
  "browser-loader.js",
  "board-history.js",
  "board-repair.js",
  "public-demo.js",
  "assets/favicon.svg",
  "assets/play-icon.svg",
  "assets/sample-branding.svg",
  "assets/sample-editorial.svg",
  "assets/sample-interface.svg",
  "assets/sample-motion.svg",
  "assets/sample-packaging.svg",
  "assets/sample-workspace.svg",
];

for (const file of publicDemoFiles) {
  await copyIntoDemo(file);
}

await copyIntoDemo("bookmarks-data.sample.json", "bookmarks-data.json");
await copyIntoDemo("media-cards.sample.json", "media-cards-clean.json");
await copyIntoDemo("node_modules/motion/dist/motion.js");
await copyIntoDemo("node_modules/@web-kits/audio/dist/index.js");

const sourceIndex = await readFile(path.join(rootDir, "index.html"), "utf8");
const stylesheetMarker = "  <link rel=\"stylesheet\" href=\"style.css\">";
if (!sourceIndex.includes(stylesheetMarker)) {
  throw new Error("Could not find the stylesheet marker in index.html.");
}
const demoIndex = sourceIndex.replace(
  stylesheetMarker,
  `  <script src="public-demo.js"></script>\n${stylesheetMarker}`
);
await writeFile(path.join(outputDir, "index.html"), demoIndex);

console.log(`Built read-only public demo at ${outputDir}`);

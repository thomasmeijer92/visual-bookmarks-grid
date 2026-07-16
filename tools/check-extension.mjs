import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const extensionDir = path.join(root, "chrome-extension");
const requiredFiles = [
  "manifest.json",
  "background.js",
  "clipper-client.mjs",
  "image-context-menu.mjs",
  "image-save.mjs",
  "popup.html",
  "popup.css",
  "popup.js",
  "icon.svg",
];

for (const file of requiredFiles) {
  const filePath = path.join(extensionDir, file);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing Chrome extension file: ${file}`);
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) {
  throw new Error("Chrome extension manifest must use Manifest V3.");
}
if (!manifest.action?.default_popup) {
  throw new Error("Chrome extension manifest needs an action default popup.");
}
if (!manifest.background?.service_worker) {
  throw new Error("Chrome extension manifest needs a background service worker.");
}
if (manifest.background.type !== "module") {
  throw new Error("Chrome extension background service worker must load shared ES modules.");
}

const backgroundSource = fs.readFileSync(path.join(extensionDir, "background.js"), "utf8");
if (!backgroundSource.includes('from "./image-context-menu.mjs"')) {
  throw new Error("Chrome extension background service worker must use the shared context-menu module.");
}
if (!backgroundSource.includes('from "./image-save.mjs"')) {
  throw new Error("Chrome extension background service worker must use the shared image-save module.");
}
if (!manifest.permissions?.includes("contextMenus")) {
  throw new Error("Chrome extension needs contextMenus permission for right-click image saves.");
}
if (!manifest.host_permissions?.some((entry) => entry.includes("127.0.0.1"))) {
  throw new Error("Chrome extension needs host permission for the local grid server.");
}

const popupHtml = fs.readFileSync(path.join(extensionDir, "popup.html"), "utf8");
if (!/<script\s+type=["']module["']\s+src=["']popup\.js["']><\/script>/.test(popupHtml)) {
  throw new Error("Chrome extension popup must load as a module so it can share the clipper client.");
}

console.log(`Chrome extension check passed (${requiredFiles.length} files).`);

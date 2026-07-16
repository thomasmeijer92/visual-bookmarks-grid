import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { readAndValidateIndex } = require("../lib/catalog/index-pipeline");
const UNSAFE_TERMINAL_CONTROL = /[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f]/g;
const terminalSafe = (value) => String(value).replace(UNSAFE_TERMINAL_CONTROL, (character) =>
  `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
);

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = path.resolve(process.env.INSPIRATION_INDEX_PATH || path.join(rootDir, "inspiration-index.json"));
const args = process.argv.slice(2);
const json = args.includes("--json");
const invalid = args.filter((arg) => arg !== "--json" && arg !== "--help" && arg !== "-h");

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write("Usage: npm run index:check -- [--json]\n");
} else if (invalid.length > 0) {
  process.stderr.write(`Index check failed: Unknown argument: ${terminalSafe(invalid[0])}.\n`);
  process.exitCode = 1;
} else {
  try {
    const { index, validation } = readAndValidateIndex(indexPath);
    const result = { ok: true, generatedAt: index.generatedAt, ...validation };
    if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      process.stdout.write(
        `Index valid: ${validation.items} items, ${validation.resolverAliases} resolver rows, schema ${validation.schemaVersion}.\n` +
        `Ambiguities: native=${validation.ambiguities.nativeSourceIds}, media=${validation.ambiguities.mediaAliases}, legacy=${validation.ambiguities.legacyNoteAliases}.\n`
      );
    }
  } catch (error) {
    process.stderr.write(`Index check failed: ${terminalSafe(error instanceof Error ? error.message : "Unexpected failure.")}\n`);
    process.exitCode = 1;
  }
}

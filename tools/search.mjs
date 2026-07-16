import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadCatalog } = require("../lib/catalog/loader");
const { searchCatalog } = require("../lib/search");
const UNSAFE_TERMINAL_CONTROL = /[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f]/g;

const FLAG_TO_FACET = new Map([
  ["--category", "category"],
  ["--style", "style"],
  ["--color", "color"],
  ["--interaction", "interaction"],
  ["--source", "source"],
  ["--media-type", "mediaType"],
  ["--mediaType", "mediaType"],
]);

const usage = `Usage: npm run search -- [options]

Options:
  --query <text>
  --category <value>       Repeatable
  --style <value>          Repeatable
  --color <value>          Repeatable
  --interaction <value>    Repeatable
  --source <value>         Repeatable
  --media-type <value>     Repeatable
  --limit <0-50>
  --offset <number>
  --json
`;

function terminalSafe(value) {
  return String(value).replace(UNSAFE_TERMINAL_CONTROL, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

function valueAfter(args, index, flag) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function parseInteger(value, flag) {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`${flag} requires a non-negative integer.`);
  return Number(value);
}

function parseArguments(args) {
  const request = { query: "", filters: {} };
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (flag === "--help" || flag === "-h") return { help: true, json, request };
    const value = valueAfter(args, index, flag);
    index++;
    if (flag === "--query") request.query = value;
    else if (flag === "--limit") request.limit = parseInteger(value, flag);
    else if (flag === "--offset") request.offset = parseInteger(value, flag);
    else if (FLAG_TO_FACET.has(flag)) {
      const facet = FLAG_TO_FACET.get(flag);
      request.filters[facet] ||= [];
      request.filters[facet].push(value);
    } else {
      throw new Error(`Unknown argument: ${flag}.`);
    }
  }
  return { help: false, json, request };
}

function printHuman(result) {
  process.stdout.write(`${result.total} result${result.total === 1 ? "" : "s"}\n`);
  for (const [index, entry] of result.results.entries()) {
    const position = result.offset + index + 1;
    const reasons = entry.matchReasons.map((reason) => `${reason.field}: ${reason.value}`).join(", ");
    process.stdout.write(`${position}. ${terminalSafe(entry.item.title || "Untitled")} [${entry.score}]\n`);
    process.stdout.write(`   ${terminalSafe(entry.item.id)}\n`);
    process.stdout.write(`   ${terminalSafe(entry.item.sourceUrl)}\n`);
    if (reasons) process.stdout.write(`   ${terminalSafe(reasons)}\n`);
  }
}

try {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(usage);
  } else {
    const catalog = loadCatalog();
    const result = searchCatalog(catalog, parsed.request);
    const sources = catalog.diagnostics.sources;
    process.stderr.write(terminalSafe(
      `Catalog: ${catalog.items.length} items; mode=${catalog.diagnostics.mode}; bookmarks=${sources.bookmarks}; metadata=${sources.metadataCards}; ` +
      `web-clips=${sources.webClips}; notes=${sources.manualNotes}; skipped=${catalog.diagnostics.skipped.length}.\n`
    ));
    if (parsed.json) process.stdout.write(`${terminalSafe(JSON.stringify(result))}\n`);
    else printHuman(result);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Unexpected failure.";
  process.stderr.write(`Search failed: ${terminalSafe(message)}\n`);
  process.exitCode = 1;
}

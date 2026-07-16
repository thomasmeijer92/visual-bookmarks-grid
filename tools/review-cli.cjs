const fs = require("fs");
const path = require("path");
const { loadCatalog } = require("../lib/catalog/loader");
const {
  ReviewQueueError,
  listReviewEntries,
  reconcileReviewState,
  transition,
} = require("../lib/catalog/review-queue");

const ROOT = path.resolve(__dirname, "..");
const unsafeTerminalControls = /[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f]/g;
const terminalSafe = (value) => String(value).replace(unsafeTerminalControls, (character) =>
  `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
);
const catalogOptions = () => ({ rootDir: ROOT, catalog: loadCatalog({ rootDir: ROOT }) });

function parse(args, allowed) {
  const result = { json: false };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--json") result.json = true;
    else if (flag === "--help" || flag === "-h") result.help = true;
    else if (allowed.has(flag)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
      result[flag.slice(2)] = value;
    } else throw new Error(`Unknown argument: ${flag}.`);
  }
  return result;
}

function print(result, json, human) {
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${human(result)}\n`);
}

function run(command) {
  try {
    if (command === "reconcile") {
      const args = parse(process.argv.slice(2), new Set());
      if (args.help) return process.stdout.write("Usage: npm run --silent review:reconcile -- [--json]\n");
      const result = reconcileReviewState(catalogOptions());
      return print({ ok: true, entries: result.document.entries.length, changed: result.changed, unresolved: result.unresolved }, args.json,
        (value) => `Review queue reconciled: ${value.entries} entries (${value.changed ? "updated" : "unchanged"}).`);
    }
    if (command === "list") {
      const args = parse(process.argv.slice(2), new Set(["--status", "--limit", "--offset"]));
      if (args.help) return process.stdout.write("Usage: npm run --silent review:list -- [--status needs_review] [--limit 20] [--offset 0] [--json]\n");
      const result = listReviewEntries({ status: args.status, limit: args.limit, offset: args.offset }, catalogOptions());
      return print(result, args.json, (value) => `Review queue: ${value.total} entries (${value.entries.length} shown).`);
    }
    const args = parse(process.argv.slice(2), command === "resolve" ? new Set(["--id", "--patch"]) : new Set(["--id", "--reason"]));
    if (args.help) {
      const usage = command === "resolve"
        ? "Usage: npm run --silent review:resolve -- --id review-id --patch patch.json [--json]"
        : `Usage: npm run --silent review:${command} -- --id review-id --reason \"Reason\" [--json]`;
      return process.stdout.write(`${usage}\n`);
    }
    if (!args.id) throw new Error("--id requires a value.");
    let input;
    if (command === "resolve") {
      if (!args.patch) throw new Error("--patch requires a value.");
      try { input = { patch: JSON.parse(fs.readFileSync(args.patch, "utf8")) }; } catch { throw new Error("Patch file must contain valid JSON."); }
    } else {
      if (!args.reason) throw new Error("--reason requires a value.");
      input = { reason: args.reason };
    }
    const entry = transition(args.id, command, input, catalogOptions());
    return print({ ok: true, entry }, args.json, (value) => `Review entry ${value.entry.id} is ${value.entry.status}.`);
  } catch (error) {
    const message = error instanceof ReviewQueueError || error instanceof Error ? error.message : "Review queue failed.";
    process.stderr.write(`Review queue failed: ${terminalSafe(message)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { run };

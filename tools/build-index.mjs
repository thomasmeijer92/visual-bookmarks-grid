import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildIndex } = require("../lib/catalog/index-pipeline");
const UNSAFE_TERMINAL_CONTROL = /[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f]/g;

const usage = `Usage: npm run index:build -- [options]

Options:
  --enricher <path>
  --allow-external-enrichment
  --json
`;

function parseArguments(args) {
  const parsed = { json: false, allowExternalEnrichment: false, enricherPath: "" };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--json") parsed.json = true;
    else if (flag === "--allow-external-enrichment") parsed.allowExternalEnrichment = true;
    else if (flag === "--help" || flag === "-h") parsed.help = true;
    else if (flag === "--enricher") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("--enricher requires a path.");
      parsed.enricherPath = value;
    } else {
      throw new Error(`Unknown argument: ${flag}.`);
    }
  }
  return parsed;
}

function terminalSafe(value) {
  return String(value).replace(UNSAFE_TERMINAL_CONTROL, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

function humanSummary(summary) {
  const sourceLine = Object.entries(summary.sources)
    .map(([name, source]) => `${name}=${source.read} (${source.mode})`)
    .join(", ");
  const skipped = Object.entries(summary.skippedByReason)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(", ") || "none";
  const lines = [
    `Index published: ${summary.written} items (${summary.publishedMode}).`,
    `Sources: ${sourceLine}.`,
    `Normalized=${summary.normalized}; enriched=${summary.enriched}; deduplicated=${summary.deduplicated}; failed=${summary.failed}.`,
    `Skipped: ${skipped}.`,
    `External enrichment: attempted=${summary.enrichmentAttempted}; applied=${summary.enrichmentApplied}; failed=${summary.enrichmentFailed}.`,
  ];
  for (const failure of summary.failures) lines.push(`Enrichment failure: ${failure.id} (${failure.reason}).`);
  if (summary.failuresOmitted) lines.push(`Additional enrichment failures omitted: ${summary.failuresOmitted}.`);
  return `${lines.join("\n")}\n`;
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage);
  } else {
    const result = await buildIndex(options);
    process.stdout.write(options.json ? `${JSON.stringify(result.summary)}\n` : terminalSafe(humanSummary(result.summary)));
    if (!result.summary.ok) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`Index build failed: ${terminalSafe(error instanceof Error ? error.message : "Unexpected failure.")}\n`);
  process.exitCode = 1;
}

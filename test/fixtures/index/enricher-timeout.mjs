import fs from "node:fs";

export async function enrich(_record, { signal }) {
  signal.addEventListener("abort", () => {
    if (process.env.ENRICHER_ABORT_MARKER) fs.writeFileSync(process.env.ENRICHER_ABORT_MARKER, "aborted\n");
  }, { once: true });
  return new Promise(() => {});
}

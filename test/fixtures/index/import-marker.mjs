import fs from "node:fs";

if (process.env.ENRICHER_IMPORT_MARKER) fs.writeFileSync(process.env.ENRICHER_IMPORT_MARKER, "imported\n");

export async function enrich() {
  return { patch: {}, provenance: {} };
}

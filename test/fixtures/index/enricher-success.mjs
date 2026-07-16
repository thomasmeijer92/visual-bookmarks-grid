export async function enrich(record, { signal }) {
  if (signal.aborted) throw new Error("aborted");
  const patch = {};
  const provenance = {};
  if (!record.title) {
    patch.title = "Externally enriched title";
    provenance.title = "fixture-enricher";
  }
  if (record.tags.length === 0) {
    patch.tags = ["enriched"];
    provenance.tags = "fixture-enricher";
  }
  return { patch, provenance };
}

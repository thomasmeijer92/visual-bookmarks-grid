export async function enrich(record) {
  if (record.title === "Fail enrichment") throw new Error("PRIVATE_PROVIDER_RESPONSE");
  return {
    patch: { tags: ["staged-only"] },
    provenance: { tags: "fixture-enricher" },
  };
}

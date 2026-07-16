const forbidden = [
  "notes", "searchText", "provenance", "resolverAliases", "sourceUrl", "sourceRecordId", "creatorName", "collections",
];

export async function enrich(record) {
  if (forbidden.some((field) => Object.hasOwn(record, field))) throw new Error("privacy boundary failed");
  if (record.media.url.startsWith("/") || record.media.url.startsWith("assets/")) {
    throw new Error("local path escaped");
  }
  return { patch: {}, provenance: {} };
}

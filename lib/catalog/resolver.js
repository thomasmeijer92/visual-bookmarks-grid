const {
  canonicalizeAbsoluteUrl,
  canonicalizeMediaUrl,
  compareStrings,
} = require("./canonical");

const MAX_SELECTORS = 50;
const MAX_CLIENT_KEY_LENGTH = 80;
const MAX_SOURCE_TYPE_LENGTH = 64;
const MAX_URL_LENGTH = 2048;
const MAX_NATIVE_ID_LENGTH = 256;
const KNOWN_SOURCE_TYPES = new Set(["bookmark", "web-clip"]);

class CatalogResolverError extends Error {
  constructor(message, code = "invalid_catalog_resolve_request") {
    super(message);
    this.name = "CatalogResolverError";
    this.code = code;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredString(value, field, max) {
  if (typeof value !== "string" || !value || value.length > max) {
    throw new CatalogResolverError("Invalid catalog resolver request.");
  }
  return value;
}

function optionalString(value, field, max) {
  if (value === undefined) return "";
  return requiredString(value, field, max);
}

function exactKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function cleanSelector(raw, clientKeys) {
  const allowed = new Set([
    "clientKey", "sourceType", "sourceRecordId", "sourceUrl", "primaryMediaId", "primaryMediaUrl",
  ]);
  if (!isPlainObject(raw) || !exactKeys(raw, allowed)) {
    throw new CatalogResolverError("Invalid catalog resolver request.");
  }
  const clientKey = requiredString(raw.clientKey, "clientKey", MAX_CLIENT_KEY_LENGTH);
  if (clientKeys.has(clientKey)) throw new CatalogResolverError("Invalid catalog resolver request.");
  clientKeys.add(clientKey);
  const sourceType = requiredString(raw.sourceType, "sourceType", MAX_SOURCE_TYPE_LENGTH);
  if (!KNOWN_SOURCE_TYPES.has(sourceType)) throw new CatalogResolverError("Invalid catalog resolver request.");
  const sourceRecordId = optionalString(raw.sourceRecordId, "sourceRecordId", MAX_NATIVE_ID_LENGTH);
  const sourceUrl = optionalString(raw.sourceUrl, "sourceUrl", MAX_URL_LENGTH);
  const primaryMediaId = optionalString(raw.primaryMediaId, "primaryMediaId", MAX_NATIVE_ID_LENGTH);
  const primaryMediaUrl = requiredString(raw.primaryMediaUrl, "primaryMediaUrl", MAX_URL_LENGTH);
  if (!sourceRecordId && !sourceUrl) throw new CatalogResolverError("Invalid catalog resolver request.");
  const canonicalMedia = canonicalizeMediaUrl(primaryMediaUrl);
  if (!canonicalMedia.ok) throw new CatalogResolverError("Invalid catalog resolver request.");
  const canonicalSource = sourceUrl ? canonicalizeAbsoluteUrl(sourceUrl) : null;
  if (sourceUrl && !canonicalSource.ok) throw new CatalogResolverError("Invalid catalog resolver request.");
  return {
    clientKey,
    sourceType,
    sourceRecordId,
    sourceUrl: canonicalSource,
    primaryMediaId,
    primaryMediaUrl: canonicalMedia,
  };
}

function validateResolveRequest(request) {
  if (!isPlainObject(request) || Object.keys(request).length !== 1 || !Array.isArray(request.items)) {
    throw new CatalogResolverError("Invalid catalog resolver request.");
  }
  if (request.items.length > MAX_SELECTORS) throw new CatalogResolverError("Invalid catalog resolver request.");
  const clientKeys = new Set();
  return request.items.map((item) => cleanSelector(item, clientKeys));
}

function rowKeys(row) {
  const source = canonicalizeAbsoluteUrl(row.sourceUrl);
  const media = canonicalizeMediaUrl(row.mediaUrl);
  return { source, media };
}

function matchesMediaId(row, primaryMediaId) {
  return !primaryMediaId || (Array.isArray(row.mediaIdAliases) && row.mediaIdAliases.includes(primaryMediaId));
}

function dedupeCatalogRows(rows) {
  const byId = new Map();
  for (const row of rows) {
    const existing = byId.get(row.catalogId);
    if (!existing) byId.set(row.catalogId, row);
  }
  return [...byId.values()].sort((left, right) => compareStrings(left.catalogId, right.catalogId));
}

function resolveOne(selector, aliases) {
  const byNative = selector.sourceRecordId
    ? aliases.filter((row) => row.sourceType === selector.sourceType && row.sourceRecordId === selector.sourceRecordId)
    : [];
  if (selector.sourceRecordId) {
    if (byNative.length === 0) return { status: "not_found" };
    const matchingMedia = byNative.filter((row) => {
      const keys = rowKeys(row);
      return keys.media.ok && keys.media.key === selector.primaryMediaUrl.key && matchesMediaId(row, selector.primaryMediaId);
    });
    if (matchingMedia.length === 0) return { status: "primary_media_mismatch" };
    const matchingSource = selector.sourceUrl
      ? matchingMedia.filter((row) => {
        const keys = rowKeys(row);
        return keys.source.ok && keys.source.key === selector.sourceUrl.key;
      })
      : matchingMedia;
    if (matchingSource.length === 0) return { status: "source_url_mismatch" };
    const matched = dedupeCatalogRows(matchingSource);
    return matched.length === 1 ? { status: "resolved", catalogId: matched[0].catalogId } : { status: "ambiguous" };
  }

  const sourceMatches = aliases.filter((row) => {
    if (row.sourceType !== selector.sourceType) return false;
    const keys = rowKeys(row);
    return keys.source.ok && keys.source.key === selector.sourceUrl.key;
  });
  const pairMatches = sourceMatches.filter((row) => {
    const keys = rowKeys(row);
    return keys.media.ok && keys.media.key === selector.primaryMediaUrl.key;
  });
  if (pairMatches.length === 0) {
    return sourceMatches.length > 0 ? { status: "primary_media_mismatch" } : { status: "not_found" };
  }
  const idMatches = pairMatches.filter((row) => matchesMediaId(row, selector.primaryMediaId));
  if (idMatches.length === 0) return { status: "primary_media_mismatch" };
  const matched = dedupeCatalogRows(idMatches);
  return matched.length === 1 ? { status: "resolved", catalogId: matched[0].catalogId } : { status: "ambiguous" };
}

function resolveCatalogSelectors(catalog, request) {
  const selectors = validateResolveRequest(request);
  const aliases = Array.isArray(catalog?.resolverAliases) ? catalog.resolverAliases : [];
  const resolvedById = new Map();
  return {
    ok: true,
    items: selectors.map((selector) => {
      const result = resolveOne(selector, aliases);
      if (result.status !== "resolved") return { clientKey: selector.clientKey, status: result.status };
      const duplicateOfClientKey = resolvedById.get(result.catalogId);
      if (duplicateOfClientKey) return { clientKey: selector.clientKey, status: "duplicate", duplicateOfClientKey };
      resolvedById.set(result.catalogId, selector.clientKey);
      return { clientKey: selector.clientKey, status: "resolved", catalogId: result.catalogId };
    }),
  };
}

module.exports = {
  CatalogResolverError,
  KNOWN_SOURCE_TYPES,
  MAX_SELECTORS,
  validateResolveRequest,
  resolveCatalogSelectors,
};

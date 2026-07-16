const {
  canonicalJson,
  canonicalizeAbsoluteUrl,
  canonicalizeMediaUrl,
  cleanString,
  compareStrings,
  hasUnsafeTerminalControl,
  normalizeList,
  sha256Canonical,
} = require("./canonical");
const {
  LIST_FIELDS,
  MAX_SEARCH_TEXT_LENGTH,
  buildSearchText,
  derivedMediaId,
  validTimestamp,
  visualId,
} = require("./bootstrap");
const { PATCH_FIELDS } = require("./review-queue");

const INDEX_SCHEMA_VERSION = 1;
const MAX_INDEX_ITEMS = 100000;
const MAX_RESOLVER_ROWS = 250000;
const MAX_ITEM_LIST_VALUES = 5000;
const MAX_PROVENANCE_ORIGINS = 16;
const MAX_ALIAS_VALUES = 64;
const LEGACY_KIND_RANK = new Map([["canonical", 0], ["card", 1], ["url", 2]]);
const BASE_SOURCE_TYPES = new Set(["bookmark", "web-clip"]);
const BUILT_IN_PROVENANCE_ORIGINS = new Set(["bookmark", "web-clip", "metadata-card", "manual-note", "manual-override"]);
const VISUAL_ID = /^visual:v1:[0-9a-f]{64}$/;
const DERIVED_MEDIA_ID = /^media-url:v1:[0-9a-f]{64}$/;
const PROVENANCE_LABEL = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const IDENTITY_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const ITEM_KEYS = [
  "id", "sourceType", "sourceRecordId", "mediaId", "sourceName", "sourceUrl", "title",
  "description", "creatorName", "creatorHandle", "creatorAvatarUrl", "media", "collections",
  "categories", "styles", "colors", "interactions", "visible", "tags", "notes", "savedAt",
  "searchText", "provenance",
];
const MEDIA_KEYS = ["type", "url", "width", "height"];
const NOTE_KEYS = ["kind", "text", "updatedAt"];
const RESOLVER_KEYS = [
  "sourceType", "sourceRecordId", "sourceUrl", "mediaId", "mediaIdAliases", "mediaUrl",
  "legacyNoteKeyAliases", "catalogId",
];
const LEGACY_ALIAS_KEYS = ["kind", "key"];
const PROVENANCE_FIELDS = new Set(ITEM_KEYS.filter((key) => !["id", "searchText", "provenance"].includes(key)));

class IndexValidationError extends Error {
  constructor(message, code = "invalid_inspiration_index") {
    super(message);
    this.name = "IndexValidationError";
    this.code = code;
  }
}

function fail(role, index, reason) {
  const location = index === undefined ? role : `${role} ${index}`;
  throw new IndexValidationError(`Invalid inspiration index (${location}): ${reason}.`);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, role, index) {
  if (!isPlainObject(value)) fail(role, index, "expected an object");
  const actual = Object.keys(value).sort(compareStrings);
  const wanted = [...expected].sort(compareStrings);
  if (actual.length !== wanted.length || actual.some((key, offset) => key !== wanted[offset])) {
    fail(role, index, "unexpected object fields");
  }
}

function identityString(value, { role, index, max, allowEmpty = true }) {
  if (typeof value !== "string") fail(role, index, "expected a string");
  if ((!allowEmpty && !value) || value.length > max || IDENTITY_CONTROL.test(value)) {
    fail(role, index, "unsafe or out-of-bounds string");
  }
  return value;
}

function normalizedString(value, { role, index, max, allowEmpty = true }) {
  if (typeof value !== "string") fail(role, index, "expected a string");
  let normalized;
  try {
    normalized = cleanString(value, { field: role, max, allowEmpty });
  } catch {
    fail(role, index, "unsafe or out-of-bounds string");
  }
  if (normalized !== value) fail(role, index, "string is not normalized");
  return value;
}

function validateTimestamp(value, role, index, nullable = true) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || validTimestamp(value) !== value) fail(role, index, "invalid timestamp");
}

function validateNormalizedList(value, role, itemIndex) {
  if (!Array.isArray(value) || value.length > MAX_ITEM_LIST_VALUES) {
    fail(role, itemIndex, "expected a bounded array");
  }
  let normalized;
  try {
    normalized = normalizeList(value, { field: role, maxItems: MAX_ITEM_LIST_VALUES, maxLength: 1000 });
  } catch {
    fail(role, itemIndex, "contains invalid values");
  }
  if (canonicalJson(normalized) !== canonicalJson(value)) fail(role, itemIndex, "values are not unique and sorted");
}

function validateProvenance(value, itemIndex) {
  if (!isPlainObject(value)) fail("item provenance", itemIndex, "expected an object");
  for (const field of Object.keys(value)) {
    if (!PROVENANCE_FIELDS.has(field)) fail("item provenance", itemIndex, "contains an unknown field");
    const origins = value[field];
    if (!Array.isArray(origins) || origins.length === 0 || origins.length > MAX_PROVENANCE_ORIGINS) {
      fail("item provenance", itemIndex, "contains an invalid origin list");
    }
    const seen = new Set();
    for (const origin of origins) {
      if (typeof origin !== "string" || !PROVENANCE_LABEL.test(origin) || seen.has(origin)) {
        fail("item provenance", itemIndex, "contains an invalid origin");
      }
      seen.add(origin);
    }
  }
}

function validateGeneratorProvenance(item, itemIndex) {
  if (!BASE_SOURCE_TYPES.has(item.sourceType)) fail("item source type", itemIndex, "cannot be produced by the generator");
  const ownerFields = ["sourceType", "sourceRecordId", "mediaId", "media", "savedAt"];
  for (const field of ownerFields) {
    const origins = item.provenance[field];
    if (!Array.isArray(origins) || origins.length !== 1 || origins[0] !== item.sourceType) {
      fail("item provenance", itemIndex, "does not retain the presentation owner");
    }
  }

  const scalarOrigin = (field, allowedOrigins, permitsExternal = false) => {
    const origins = item.provenance[field];
    if (!Array.isArray(origins) || origins.length !== 1) {
      fail("item provenance", itemIndex, "has an invalid scalar origin");
    }
    const [origin] = origins;
    if (allowedOrigins.has(origin)) return;
    if (permitsExternal && !BUILT_IN_PROVENANCE_ORIGINS.has(origin)) return;
    fail("item provenance", itemIndex, "has an impossible scalar origin");
  };
  const baseListOrigins = (origins) => {
    if (!Array.isArray(origins) || origins.length === 0 || origins.some((origin) => !BASE_SOURCE_TYPES.has(origin))) {
      fail("item provenance", itemIndex, "has an impossible base-list origin");
    }
  };
  const cardFirstListOrigins = (field) => {
    const origins = item.provenance[field];
    if (!Array.isArray(origins) || origins.length === 0) fail("item provenance", itemIndex, "has an invalid list origin");
    if (origins.length === 1 && !BUILT_IN_PROVENANCE_ORIGINS.has(origins[0])) return;
    const baseOrigins = origins[0] === "metadata-card" ? origins.slice(1) : origins;
    if (origins[0] !== "metadata-card" && !BASE_SOURCE_TYPES.has(origins[0])) {
      fail("item provenance", itemIndex, "has an impossible list origin");
    }
    if (baseOrigins.length > 0) baseListOrigins(baseOrigins);
  };
  const baseThenCardListOrigins = (field) => {
    const origins = item.provenance[field];
    if (!Array.isArray(origins) || origins.length === 0) fail("item provenance", itemIndex, "has an invalid list origin");
    if (origins.length === 1 && !BUILT_IN_PROVENANCE_ORIGINS.has(origins[0])) return;
    const cardIndex = origins.indexOf("metadata-card");
    if (cardIndex !== -1 && cardIndex !== origins.length - 1) {
      fail("item provenance", itemIndex, "has an impossible list origin order");
    }
    const baseOrigins = cardIndex === -1 ? origins : origins.slice(0, -1);
    if (baseOrigins.length > 0) baseListOrigins(baseOrigins);
    else if (cardIndex === -1) fail("item provenance", itemIndex, "has an impossible list origin");
  };

  const contributedFields = [
    "sourceName", "sourceUrl", "title", "description", "creatorName", "creatorHandle", "creatorAvatarUrl",
    ...LIST_FIELDS,
  ];
  const isManualOverride = (field) => PATCH_FIELDS.has(field) && canonicalJson(item.provenance[field] || []) === '["manual-override"]';
  for (const field of contributedFields) {
    const hasValue = Array.isArray(item[field]) ? item[field].length > 0 : Boolean(item[field]);
    if (hasValue !== Object.hasOwn(item.provenance, field) && !isManualOverride(field)) {
      fail("item provenance", itemIndex, "does not match normalized field values");
    }
  }

  if (item.sourceName) scalarOrigin("sourceName", new Set([item.sourceType, "metadata-card"]));
  if (item.sourceUrl) scalarOrigin("sourceUrl", new Set([item.sourceType]));
  for (const field of ["title", "description"]) {
    if (item[field] && !isManualOverride(field)) scalarOrigin(field, new Set([item.sourceType, "metadata-card"]), true);
  }
  for (const field of ["creatorName", "creatorHandle", "creatorAvatarUrl"]) {
    if (item[field] && !isManualOverride(field)) scalarOrigin(field, new Set([item.sourceType, "metadata-card"]));
  }
  if (item.collections.length > 0 && !isManualOverride("collections")) baseListOrigins(item.provenance.collections);
  for (const field of ["categories", "styles", "colors", "interactions", "visible"]) {
    if (item[field].length > 0 && !isManualOverride(field)) cardFirstListOrigins(field);
  }
  if (item.tags.length > 0 && !isManualOverride("tags")) baseThenCardListOrigins("tags");

  if (item.notes.length > 1) fail("item notes", itemIndex, "exceeds generated note cardinality");
  if (item.notes.length === 1) {
    const origins = item.provenance.notes;
    if (!Array.isArray(origins) || origins.length !== 1 || origins[0] !== "manual-note") {
      fail("item provenance", itemIndex, "does not match manual note state");
    }
  } else if (Object.hasOwn(item.provenance, "notes")) {
    fail("item provenance", itemIndex, "contains note provenance without a note");
  }
}

function validateItem(item, index) {
  exactKeys(item, ITEM_KEYS, "item", index);
  identityString(item.id, { role: "item id", index, max: 80, allowEmpty: false });
  if (!VISUAL_ID.test(item.id)) fail("item id", index, "invalid visual id");
  normalizedString(item.sourceType, { role: "item source type", index, max: 80, allowEmpty: false });
  identityString(item.sourceRecordId, { role: "item source record id", index, max: 512 });
  identityString(item.mediaId, { role: "item media id", index, max: 1024, allowEmpty: false });
  normalizedString(item.sourceName, { role: "item source name", index, max: 512 });
  identityString(item.sourceUrl, { role: "item source url", index, max: 4096, allowEmpty: false });
  normalizedString(item.title, { role: "item title", index, max: 10000 });
  normalizedString(item.description, { role: "item description", index, max: 10000 });
  normalizedString(item.creatorName, { role: "item creator name", index, max: 512 });
  normalizedString(item.creatorHandle, { role: "item creator handle", index, max: 512 });
  normalizedString(item.creatorAvatarUrl, { role: "item creator avatar", index, max: 4096 });

  exactKeys(item.media, MEDIA_KEYS, "item media", index);
  normalizedString(item.media.type, { role: "item media type", index, max: 80, allowEmpty: false });
  identityString(item.media.url, { role: "item media url", index, max: 4096, allowEmpty: false });
  for (const dimension of [item.media.width, item.media.height]) {
    if (dimension !== null && (typeof dimension !== "number" || !Number.isFinite(dimension) || dimension < 0 || dimension > 10000000)) {
      fail("item media", index, "invalid dimensions");
    }
  }

  const source = canonicalizeAbsoluteUrl(item.sourceUrl);
  const media = canonicalizeMediaUrl(item.media.url);
  if (!source.ok || source.display !== item.sourceUrl) fail("item source url", index, "invalid URL");
  if (!media.ok || media.display !== item.media.url) fail("item media url", index, "invalid URL");
  if (visualId(source.key, media.key) !== item.id) fail("item id", index, "does not match canonical URLs");
  if (item.mediaId.startsWith("media-url:v1:")) {
    if (!DERIVED_MEDIA_ID.test(item.mediaId) || derivedMediaId(media.key) !== item.mediaId) {
      fail("item media id", index, "invalid derived media id");
    }
  }

  for (const field of LIST_FIELDS) validateNormalizedList(item[field], `item ${field}`, index);
  if (!Array.isArray(item.notes) || item.notes.length > 500) fail("item notes", index, "expected a bounded array");
  for (const note of item.notes) {
    exactKeys(note, NOTE_KEYS, "item note", index);
    if (note.kind !== "manual") fail("item note", index, "invalid kind");
    normalizedString(note.text, { role: "item note text", index, max: 2400, allowEmpty: false });
    validateTimestamp(note.updatedAt, "item note", index);
  }
  validateTimestamp(item.savedAt, "item saved timestamp", index);
  if (typeof item.searchText !== "string" || item.searchText.length > MAX_SEARCH_TEXT_LENGTH || hasUnsafeTerminalControl(item.searchText)) {
    fail("item search text", index, "unsafe or out-of-bounds string");
  }
  if (buildSearchText(item).searchText !== item.searchText) fail("item search text", index, "does not match derived value");
  validateProvenance(item.provenance, index);
  validateGeneratorProvenance(item, index);
  return { sourceKey: source.key, mediaKey: media.key };
}

function validateSortedExactStrings(value, role, rowIndex, requiredValue) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ALIAS_VALUES) {
    fail(role, rowIndex, "expected a bounded non-empty array");
  }
  let previous = null;
  const seen = new Set();
  for (const alias of value) {
    identityString(alias, { role, index: rowIndex, max: 1024, allowEmpty: false });
    if (seen.has(alias) || (previous !== null && compareStrings(previous, alias) >= 0)) {
      fail(role, rowIndex, "values are not unique and sorted");
    }
    seen.add(alias);
    previous = alias;
  }
  if (requiredValue && !seen.has(requiredValue)) fail(role, rowIndex, "missing canonical media id");
}

function validateLegacyAliases(value, rowIndex) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ALIAS_VALUES) {
    fail("resolver legacy aliases", rowIndex, "expected a bounded non-empty array");
  }
  let previous = null;
  const seen = new Set();
  for (const alias of value) {
    exactKeys(alias, LEGACY_ALIAS_KEYS, "resolver legacy alias", rowIndex);
    if (!LEGACY_KIND_RANK.has(alias.kind)) fail("resolver legacy alias", rowIndex, "invalid kind");
    identityString(alias.key, { role: "resolver legacy alias", index: rowIndex, max: 4609, allowEmpty: false });
    const identity = `${alias.kind}\u0000${alias.key}`;
    if (seen.has(identity)) fail("resolver legacy aliases", rowIndex, "contains duplicates");
    if (previous) {
      const order = LEGACY_KIND_RANK.get(previous.kind) - LEGACY_KIND_RANK.get(alias.kind) ||
        compareStrings(previous.key, alias.key);
      if (order >= 0) fail("resolver legacy aliases", rowIndex, "values are not sorted");
    }
    seen.add(identity);
    previous = alias;
  }
}

function validateGeneratedResolverAliases(row, mediaKey, rowIndex) {
  if (!BASE_SOURCE_TYPES.has(row.sourceType)) fail("resolver source type", rowIndex, "cannot be produced by the generator");
  if (row.mediaId.startsWith("media-url:v1:") && derivedMediaId(mediaKey) !== row.mediaId) {
    fail("resolver media id", rowIndex, "invalid derived media id");
  }
  if (row.mediaIdAliases.length > 2) fail("resolver media aliases", rowIndex, "exceeds generated alias cardinality");
  for (const alias of row.mediaIdAliases) {
    if (alias.startsWith("media-url:v1:") && derivedMediaId(mediaKey) !== alias) {
      fail("resolver media aliases", rowIndex, "contains an invalid derived media id");
    }
  }

  const aliasesByKind = new Map();
  for (const alias of row.legacyNoteKeyAliases) {
    const values = aliasesByKind.get(alias.kind) || [];
    values.push(alias.key);
    aliasesByKind.set(alias.kind, values);
  }
  const urls = aliasesByKind.get("url") || [];
  if (urls.length !== 1 || urls[0] !== row.mediaUrl) {
    fail("resolver legacy aliases", rowIndex, "does not retain the primary media URL alias");
  }
  if (!row.sourceRecordId) {
    if (row.mediaIdAliases.length !== 1 || row.mediaIdAliases[0] !== row.mediaId) {
      fail("resolver media aliases", rowIndex, "cannot contain a card alias without a source id");
    }
    if (row.legacyNoteKeyAliases.length !== 1) fail("resolver legacy aliases", rowIndex, "cannot be produced without a source id");
    return;
  }

  const canonical = aliasesByKind.get("canonical") || [];
  if (canonical.length !== 1 || canonical[0] !== `${row.sourceRecordId}:${row.mediaUrl}`) {
    fail("resolver legacy aliases", rowIndex, "does not retain the canonical source/media alias");
  }
  const cards = aliasesByKind.get("card") || [];
  if (cards.length > 1 || row.legacyNoteKeyAliases.length !== 2 + cards.length) {
    fail("resolver legacy aliases", rowIndex, "exceeds generated alias cardinality");
  }
  if (cards.length === 1) {
    const prefix = `${row.sourceRecordId}:`;
    if (!cards[0].startsWith(prefix)) fail("resolver legacy aliases", rowIndex, "has an invalid card alias");
    const cardUrl = canonicalizeMediaUrl(cards[0].slice(prefix.length));
    if (!cardUrl.ok || cardUrl.display !== cards[0].slice(prefix.length) || cardUrl.display === row.mediaUrl) {
      fail("resolver legacy aliases", rowIndex, "has an invalid card media alias");
    }
  }
}

function resolverComparator(left, right) {
  return compareStrings(left.row.sourceType, right.row.sourceType) ||
    compareStrings(left.row.sourceRecordId, right.row.sourceRecordId) ||
    compareStrings(left.sourceKey, right.sourceKey) ||
    compareStrings(left.row.mediaId, right.row.mediaId) ||
    compareStrings(left.mediaKey, right.mediaKey) ||
    compareStrings(left.row.catalogId, right.row.catalogId);
}

function addAmbiguity(map, selector, catalogId) {
  if (!selector) return;
  const ids = map.get(selector) || new Set();
  ids.add(catalogId);
  map.set(selector, ids);
}

function ambiguityCount(map) {
  let count = 0;
  for (const ids of map.values()) if (ids.size > 1) count++;
  return count;
}

function validateIndex(index) {
  exactKeys(index, ["schemaVersion", "generatedAt", "items", "resolverAliases"], "root");
  if (index.schemaVersion !== INDEX_SCHEMA_VERSION) fail("root", undefined, "unsupported schema version");
  validateTimestamp(index.generatedAt, "generated timestamp", undefined, false);
  if (!Array.isArray(index.items) || index.items.length > MAX_INDEX_ITEMS) fail("items", undefined, "expected a bounded array");
  if (!Array.isArray(index.resolverAliases) || index.resolverAliases.length > MAX_RESOLVER_ROWS) {
    fail("resolver aliases", undefined, "expected a bounded array");
  }
  canonicalJson(index);

  const itemIds = new Set();
  const itemKeys = new Map();
  const itemsById = new Map();
  let previousItemId = null;
  index.items.forEach((item, itemIndex) => {
    const keys = validateItem(item, itemIndex);
    if (itemIds.has(item.id) || (previousItemId !== null && compareStrings(previousItemId, item.id) >= 0)) {
      fail("items", itemIndex, "ids are not unique and sorted");
    }
    itemIds.add(item.id);
    itemKeys.set(item.id, keys);
    itemsById.set(item.id, item);
    previousItemId = item.id;
  });

  const selectorIds = new Map();
  const rowsByCatalogId = new Map();
  const ownerResolverRows = new Set();
  const nativeSelectors = new Map();
  const mediaSelectors = new Map();
  const legacySelectors = new Map();
  let previousResolver = null;
  index.resolverAliases.forEach((row, rowIndex) => {
    exactKeys(row, RESOLVER_KEYS, "resolver row", rowIndex);
    normalizedString(row.sourceType, { role: "resolver source type", index: rowIndex, max: 80, allowEmpty: false });
    identityString(row.sourceRecordId, { role: "resolver source record id", index: rowIndex, max: 512 });
    identityString(row.sourceUrl, { role: "resolver source url", index: rowIndex, max: 4096, allowEmpty: false });
    identityString(row.mediaId, { role: "resolver media id", index: rowIndex, max: 1024, allowEmpty: false });
    identityString(row.mediaUrl, { role: "resolver media url", index: rowIndex, max: 4096, allowEmpty: false });
    identityString(row.catalogId, { role: "resolver catalog id", index: rowIndex, max: 80, allowEmpty: false });
    validateSortedExactStrings(row.mediaIdAliases, "resolver media aliases", rowIndex, row.mediaId);
    validateLegacyAliases(row.legacyNoteKeyAliases, rowIndex);

    const source = canonicalizeAbsoluteUrl(row.sourceUrl);
    const media = canonicalizeMediaUrl(row.mediaUrl);
    if (!source.ok || source.display !== row.sourceUrl) fail("resolver source url", rowIndex, "invalid URL");
    if (!media.ok || media.display !== row.mediaUrl) fail("resolver media url", rowIndex, "invalid URL");
    if (!itemIds.has(row.catalogId) || visualId(source.key, media.key) !== row.catalogId) {
      fail("resolver catalog id", rowIndex, "does not match canonical URLs");
    }
    const catalogKeys = itemKeys.get(row.catalogId);
    if (catalogKeys.sourceKey !== source.key || catalogKeys.mediaKey !== media.key) {
      fail("resolver row", rowIndex, "does not agree with its catalog item");
    }
    validateGeneratedResolverAliases(row, media.key, rowIndex);
    const item = itemsById.get(row.catalogId);
    if (
      item.sourceType === row.sourceType &&
      item.sourceRecordId === row.sourceRecordId &&
      item.mediaId === row.mediaId &&
      item.sourceUrl === row.sourceUrl &&
      item.media.url === row.mediaUrl
    ) ownerResolverRows.add(row.catalogId);
    const wrapped = { row, sourceKey: source.key, mediaKey: media.key };
    if (previousResolver && resolverComparator(previousResolver, wrapped) >= 0) {
      fail("resolver aliases", rowIndex, "rows are not unique and sorted");
    }
    previousResolver = wrapped;

    const completeSelector = `${row.sourceType}\u0000${source.key}\u0000${media.key}`;
    const previousCatalogId = selectorIds.get(completeSelector);
    if (previousCatalogId && previousCatalogId !== row.catalogId) {
      fail("resolver row", rowIndex, "complete selector is ambiguous");
    }
    selectorIds.set(completeSelector, row.catalogId);
    rowsByCatalogId.set(row.catalogId, (rowsByCatalogId.get(row.catalogId) || 0) + 1);
    addAmbiguity(nativeSelectors, row.sourceRecordId ? `${row.sourceType}\u0000${row.sourceRecordId}` : "", row.catalogId);
    for (const alias of row.mediaIdAliases) addAmbiguity(mediaSelectors, alias, row.catalogId);
    for (const alias of row.legacyNoteKeyAliases) addAmbiguity(legacySelectors, alias.key, row.catalogId);
  });
  for (const catalogId of itemIds) {
    if (!rowsByCatalogId.has(catalogId)) fail("resolver aliases", undefined, "catalog item has no resolver row");
    if (!ownerResolverRows.has(catalogId)) fail("resolver aliases", undefined, "catalog item has no presentation-owner resolver row");
  }

  return {
    schemaVersion: index.schemaVersion,
    items: index.items.length,
    resolverAliases: index.resolverAliases.length,
    fingerprint: sha256Canonical({ items: index.items, resolverAliases: index.resolverAliases }),
    ambiguities: {
      nativeSourceIds: ambiguityCount(nativeSelectors),
      mediaAliases: ambiguityCount(mediaSelectors),
      legacyNoteAliases: ambiguityCount(legacySelectors),
    },
  };
}

module.exports = {
  INDEX_SCHEMA_VERSION,
  IndexValidationError,
  MAX_INDEX_ITEMS,
  MAX_RESOLVER_ROWS,
  validateIndex,
};

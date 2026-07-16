const { cleanString, compareStrings, normalizeList } = require("./catalog/canonical");

const FACETS = {
  category: { field: "categories", values: (item) => item.categories },
  style: { field: "styles", values: (item) => item.styles },
  color: { field: "colors", values: (item) => item.colors },
  interaction: { field: "interactions", values: (item) => item.interactions },
  source: { field: "sourceName", values: (item) => [item.sourceName].filter(Boolean) },
  mediaType: { field: "media.type", values: (item) => [item.media.type].filter(Boolean) },
};
const REQUEST_KEYS = new Set(["query", "filters", "limit", "offset"]);
const MAX_QUERY_TERMS = 64;
const MAX_MATCH_REASONS = 8;

class SearchValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SearchValidationError";
    this.code = "invalid_search_request";
  }
}

function validateInteger(value, field, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) throw new SearchValidationError(`${field} must be a non-negative integer.`);
  return value;
}

function normalizeSearchRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new SearchValidationError("Search request must be an object.");
  }
  for (const key of Object.keys(request)) {
    if (!REQUEST_KEYS.has(key)) throw new SearchValidationError(`Unknown search field: ${key}.`);
  }

  let query;
  try {
    if (Object.prototype.hasOwnProperty.call(request, "query") && typeof request.query !== "string") {
      throw new TypeError("query must be a string.");
    }
    query = cleanString(request.query, { field: "query", max: 2000 });
  } catch (error) {
    throw new SearchValidationError(error.message);
  }
  const rawFilters = request.filters === undefined ? {} : request.filters;
  if (!rawFilters || typeof rawFilters !== "object" || Array.isArray(rawFilters)) {
    throw new SearchValidationError("filters must be an object.");
  }
  for (const name of Object.keys(rawFilters)) {
    if (!Object.hasOwn(FACETS, name)) throw new SearchValidationError(`Unknown filter: ${name}.`);
    if (!Array.isArray(rawFilters[name])) throw new SearchValidationError(`filters.${name} must be an array.`);
  }

  const filters = {};
  for (const name of Object.keys(FACETS)) {
    try {
      const rawValues = Object.hasOwn(rawFilters, name) ? rawFilters[name] : [];
      filters[name] = normalizeList(rawValues, {
        field: `filters.${name}`,
        maxItems: 50,
        maxLength: 200,
      });
    } catch (error) {
      throw new SearchValidationError(error.message);
    }
  }
  const limit = validateInteger(request.limit, "limit", 20);
  if (limit > 50) throw new SearchValidationError("limit must not exceed 50.");
  const offset = validateInteger(request.offset, "offset", 0);
  return { query, filters, limit, offset };
}

function normalized(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function queryTerms(query) {
  const values = normalized(query).match(/[\p{L}\p{N}]+/gu) || [];
  const terms = new Set();
  for (const value of values) {
    terms.add(value);
    if (terms.size === MAX_QUERY_TERMS) break;
  }
  return [...terms];
}

function fieldDefinitions(item) {
  return [
    { field: "title", values: [item.title], termWeight: 14, phraseWeight: 32, reasonValues: false },
    { field: "categories", values: item.categories, termWeight: 11, phraseWeight: 25, reasonValues: true },
    { field: "styles", values: item.styles, termWeight: 11, phraseWeight: 25, reasonValues: true },
    { field: "colors", values: item.colors, termWeight: 9, phraseWeight: 22, reasonValues: true },
    { field: "interactions", values: item.interactions, termWeight: 11, phraseWeight: 25, reasonValues: true },
    { field: "collections", values: item.collections, termWeight: 9, phraseWeight: 22, reasonValues: true },
    { field: "tags", values: item.tags, termWeight: 8, phraseWeight: 20, reasonValues: true },
    { field: "visible", values: item.visible, termWeight: 6, phraseWeight: 14, reasonValues: true },
    { field: "creatorName", values: [item.creatorName], termWeight: 6, phraseWeight: 14, reasonValues: false },
    { field: "creatorHandle", values: [item.creatorHandle], termWeight: 5, phraseWeight: 12, reasonValues: false },
    { field: "sourceName", values: [item.sourceName], termWeight: 5, phraseWeight: 12, reasonValues: false },
    { field: "description", values: [item.description], termWeight: 3, phraseWeight: 8, reasonValues: false },
    { field: "notes", values: item.notes.map((note) => note.text), termWeight: 2, phraseWeight: 6, reasonValues: false },
    { field: "sourceUrl", values: [item.sourceUrl], termWeight: 1, phraseWeight: 3, reasonValues: false },
    { field: "media.url", values: [item.media.url], termWeight: 1, phraseWeight: 3, reasonValues: false },
  ];
}

function addReason(reasons, seen, reason) {
  const key = `${reason.kind}\u0000${reason.field}\u0000${reason.value}`;
  if (seen.has(key)) return false;
  seen.add(key);
  reasons.push(reason);
  return reasons.length >= MAX_MATCH_REASONS;
}

function matchesFilters(item, filters) {
  for (const [name, definition] of Object.entries(FACETS)) {
    const wanted = filters[name];
    if (wanted.length === 0) continue;
    const actual = definition.values(item);
    const actualKeys = new Set(actual.map(normalized));
    if (!wanted.some((value) => actualKeys.has(normalized(value)))) return false;
  }
  return true;
}

function scoreText(item, query, terms) {
  if (!query) return { matched: true, score: 0 };
  const phrase = normalized(query);
  let score = 0;
  const matchedTerms = new Set();

  for (const definition of fieldDefinitions(item)) {
    const values = definition.values.filter(Boolean);
    for (const value of values) {
      const haystack = normalized(value);
      if (phrase && haystack.includes(phrase)) {
        score += definition.phraseWeight;
      }
      for (const term of terms) {
        if (!haystack.includes(term)) continue;
        matchedTerms.add(term);
        score += definition.termWeight;
      }
    }
  }

  score += matchedTerms.size * 2;
  return { matched: matchedTerms.size > 0, score };
}

function matchReasons(item, request, terms) {
  const reasons = [];
  const seen = new Set();

  for (const [name, definition] of Object.entries(FACETS)) {
    const wanted = request.filters[name];
    if (wanted.length === 0) continue;
    const actualByKey = new Map(definition.values(item).map((value) => [normalized(value), value]));
    const match = wanted.map(normalized).find((value) => actualByKey.has(value));
    if (match && addReason(reasons, seen, {
      field: definition.field,
      value: actualByKey.get(match),
      kind: "filter",
    })) return reasons;
  }

  if (!request.query) return reasons;
  const phrase = normalized(request.query);
  for (const definition of fieldDefinitions(item)) {
    for (const value of definition.values.filter(Boolean)) {
      const haystack = normalized(value);
      if (phrase && haystack.includes(phrase) && addReason(reasons, seen, {
        field: definition.field,
        value: definition.reasonValues ? value : request.query,
        kind: "phrase",
      })) return reasons;
      for (const term of terms) {
        if (haystack.includes(term) && addReason(reasons, seen, {
          field: definition.field,
          value: definition.reasonValues ? value : term,
          kind: "term",
        })) return reasons;
      }
    }
  }
  return reasons;
}

function searchCatalog(catalog, request) {
  if (!catalog || !Array.isArray(catalog.items)) throw new SearchValidationError("Catalog is unavailable.");
  const normalizedRequest = normalizeSearchRequest(request);
  const terms = queryTerms(normalizedRequest.query);
  if (normalizedRequest.query && terms.length === 0) {
    throw new SearchValidationError("query must contain at least one letter or number.");
  }

  const ranked = [];
  for (const item of catalog.items) {
    if (!matchesFilters(item, normalizedRequest.filters)) continue;
    const text = scoreText(item, normalizedRequest.query, terms);
    if (!text.matched) continue;
    ranked.push({ item, score: text.score });
  }

  ranked.sort((left, right) =>
    right.score - left.score ||
    compareStrings(normalized(left.item.title), normalized(right.item.title)) ||
    compareStrings(left.item.id, right.item.id)
  );
  const total = ranked.length;
  const page = ranked.slice(normalizedRequest.offset, normalizedRequest.offset + normalizedRequest.limit);
  return {
    ok: true,
    query: normalizedRequest.query,
    total,
    limit: normalizedRequest.limit,
    offset: normalizedRequest.offset,
    results: page.map((entry) => ({
      ...entry,
      matchReasons: matchReasons(entry.item, normalizedRequest, terms),
    })),
  };
}

module.exports = {
  FACETS,
  MAX_MATCH_REASONS,
  MAX_QUERY_TERMS,
  SearchValidationError,
  normalizeSearchRequest,
  searchCatalog,
};

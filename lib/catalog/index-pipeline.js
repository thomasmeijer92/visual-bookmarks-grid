const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const net = require("net");
const { pathToFileURL } = require("url");
const { buildSearchText, loadBootstrapCatalog } = require("./bootstrap");
const { cleanString, compareStrings, normalizeList } = require("./canonical");
const { validateIndex } = require("./index-schema");
const { applyAcceptedPatches, reconcileReviewState } = require("./review-queue");

const INDEX_FILENAME = "inspiration-index.json";
const ENRICHMENT_TIMEOUT_MS = 30000;
const ENRICHMENT_CONCURRENCY = 4;
const MAX_REPORTED_FAILURES = 50;
const EXTERNAL_FIELDS = new Set([
  "title", "description", "categories", "styles", "colors", "interactions", "visible", "tags",
]);
const EXTERNAL_LIST_FIELDS = new Set(["categories", "styles", "colors", "interactions", "visible", "tags"]);
const PROVENANCE_LABEL = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const RESERVED_PROVENANCE_LABELS = new Set(["bookmark", "web-clip", "metadata-card", "manual-note", "manual-override"]);
// IANA/RFC special-use names and DNS infrastructure zones unsuitable for HTTP(S) media export.
const SPECIAL_USE_HOSTNAME_SUFFIXES = new Set([
  "alt", "example", "example.com", "example.net", "example.org", "invalid", "local", "localhost", "onion", "test",
  "6tisch.arpa", "eap.arpa", "eap-noob.arpa", "home.arpa", "in-addr.arpa", "ip6.arpa", "ipv4only.arpa", "resolver.arpa", "service.arpa",
]);

class IndexBuildError extends Error {
  constructor(message, code = "index_build_failed") {
    super(message);
    this.name = "IndexBuildError";
    this.code = code;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function createIndexDocument(catalog, generatedAt = catalog.generatedAt) {
  return {
    schemaVersion: 1,
    generatedAt,
    items: catalog.items,
    resolverAliases: catalog.resolverAliases,
  };
}

function normalizeDnsHostname(hostname) {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return hostname;
  const normalized = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (!normalized || normalized.startsWith(".") || normalized.includes("..") || hostname.endsWith("..")) return null;
  return normalized;
}

function isPrivateOrInternalHostname(hostname) {
  const normalized = normalizeDnsHostname(hostname.toLowerCase());
  if (normalized === null) return true;
  const host = normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
  if (net.isIP(host)) return true;
  return !host.includes(".") ||
    [...SPECIAL_USE_HOSTNAME_SUFFIXES].some((suffix) => host === suffix || host.endsWith(`.${suffix}`)) ||
    host.endsWith(".local") ||
    host.endsWith(".localdomain") ||
    host.endsWith(".internal") ||
    host.endsWith(".home") ||
    host.endsWith(".lan");
}

function externalMediaUrl(value) {
  if (typeof value !== "string") return "";
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username || parsed.password || parsed.search || parsed.hash ||
      isPrivateOrInternalHostname(parsed.hostname)
    ) return "";
    return value;
  } catch {
    return "";
  }
}

function privacyBoundedRecord(item) {
  const mediaUrl = externalMediaUrl(item.media.url);
  return structuredClone({
    id: item.id,
    title: item.title,
    description: item.description,
    categories: item.categories,
    styles: item.styles,
    colors: item.colors,
    interactions: item.interactions,
    visible: item.visible,
    tags: item.tags,
    media: {
      type: item.media.type,
      url: mediaUrl,
      width: item.media.width,
      height: item.media.height,
    },
  });
}

function validateEnrichmentResult(result, item) {
  if (!isPlainObject(result)) throw new IndexBuildError("Invalid enrichment patch.", "invalid_enrichment_patch");
  const resultKeys = Object.keys(result).sort(compareStrings);
  if (resultKeys.length !== 2 || resultKeys[0] !== "patch" || resultKeys[1] !== "provenance") {
    throw new IndexBuildError("Invalid enrichment patch.", "invalid_enrichment_patch");
  }
  if (!isPlainObject(result.patch) || !isPlainObject(result.provenance)) {
    throw new IndexBuildError("Invalid enrichment patch.", "invalid_enrichment_patch");
  }
  const patchKeys = Object.keys(result.patch).sort(compareStrings);
  const provenanceKeys = Object.keys(result.provenance).sort(compareStrings);
  if (
    patchKeys.length !== provenanceKeys.length ||
    patchKeys.some((key, index) => key !== provenanceKeys[index] || !EXTERNAL_FIELDS.has(key))
  ) {
    throw new IndexBuildError("Invalid enrichment patch.", "invalid_enrichment_patch");
  }

  const patch = {};
  const provenance = {};
  for (const field of patchKeys) {
    const existing = item[field];
    const isMissing = EXTERNAL_LIST_FIELDS.has(field) ? existing.length === 0 : existing === "";
    if (!isMissing) throw new IndexBuildError("Invalid enrichment patch.", "invalid_enrichment_patch");
    try {
      if (EXTERNAL_LIST_FIELDS.has(field)) {
        if (!Array.isArray(result.patch[field])) throw new TypeError("list required");
        patch[field] = normalizeList(result.patch[field], {
          field: `enrichment.${field}`,
          maxItems: 100,
          maxLength: 1000,
        });
        if (patch[field].length === 0) throw new TypeError("non-empty list required");
      } else {
        patch[field] = cleanString(result.patch[field], {
          field: `enrichment.${field}`,
          max: 10000,
          allowEmpty: false,
        });
      }
    } catch {
      throw new IndexBuildError("Invalid enrichment patch.", "invalid_enrichment_patch");
    }
    const origin = result.provenance[field];
    if (
      typeof origin !== "string" ||
      !PROVENANCE_LABEL.test(origin) ||
      RESERVED_PROVENANCE_LABELS.has(origin)
    ) {
      throw new IndexBuildError("Invalid enrichment patch.", "invalid_enrichment_patch");
    }
    provenance[field] = origin;
  }
  return { patch, provenance };
}

async function callWithTimeout(enrich, item, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new IndexBuildError("Enrichment timed out.", "enrichment_timeout"));
    }, timeoutMs);
  });
  try {
    const payload = privacyBoundedRecord(item);
    const result = await Promise.race([
      Promise.resolve().then(() => enrich(payload, { signal: controller.signal })),
      timeout,
    ]);
    return validateEnrichmentResult(result, item);
  } catch (error) {
    if (error instanceof IndexBuildError) throw error;
    throw new IndexBuildError("External enrichment failed.", "enricher_error");
  } finally {
    clearTimeout(timer);
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, run));
  return results;
}

async function runExternalEnrichment(baseIndex, enrich, options = {}) {
  const timeoutMs = options.timeoutMs || ENRICHMENT_TIMEOUT_MS;
  const outcomes = await mapWithConcurrency(
    baseIndex.items,
    options.concurrency || ENRICHMENT_CONCURRENCY,
    async (item) => {
      try {
        return { ok: true, value: await callWithTimeout(enrich, item, timeoutMs) };
      } catch (error) {
        return {
          ok: false,
          id: item.id,
          reason: error instanceof IndexBuildError ? error.code : "enricher_error",
        };
      }
    }
  );
  const failed = outcomes.filter((outcome) => !outcome.ok);
  if (failed.length > 0) {
    return {
      ok: false,
      index: baseIndex,
      attempted: baseIndex.items.length,
      applied: 0,
      failed: failed.length,
      appliedIds: [],
      failures: failed.slice(0, MAX_REPORTED_FAILURES).map(({ id, reason }) => ({ id, reason })),
      failuresOmitted: Math.max(0, failed.length - MAX_REPORTED_FAILURES),
    };
  }

  let applied = 0;
  const appliedIds = [];
  const items = baseIndex.items.map((item, index) => {
    const staged = outcomes[index].value;
    if (Object.keys(staged.patch).length === 0) return item;
    applied++;
    appliedIds.push(item.id);
    const enriched = structuredClone(item);
    for (const [field, value] of Object.entries(staged.patch)) {
      enriched[field] = value;
      enriched.provenance[field] = [staged.provenance[field]];
    }
    enriched.searchText = buildSearchText(enriched).searchText;
    return enriched;
  });
  const index = { ...baseIndex, items };
  validateIndex(index);
  return {
    ok: true,
    index,
    attempted: baseIndex.items.length,
    applied,
    failed: 0,
    appliedIds,
    failures: [],
    failuresOmitted: 0,
  };
}

async function atomicWriteIndex(index, indexPath, options = {}) {
  validateIndex(index);
  const serialized = `${JSON.stringify(index, null, 2)}\n`;
  validateIndex(JSON.parse(serialized));
  const target = path.resolve(indexPath);
  const suffix = `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
  const tempPath = `${target}.tmp-${suffix}`;
  let handle;
  try {
    handle = await fsp.open(tempPath, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    if (options.beforeRename) await options.beforeRename(tempPath, target);
    await fsp.rename(tempPath, target);
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch {}
    }
    try { await fsp.unlink(tempPath); } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") {
        throw new IndexBuildError("Index write failed and temporary cleanup was incomplete.", "index_cleanup_failed");
      }
    }
    throw error;
  }
  return { bytes: Buffer.byteLength(serialized), path: target };
}

function skippedByReason(skipped) {
  const counts = new Map();
  for (const entry of skipped) counts.set(entry.reason, (counts.get(entry.reason) || 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => compareStrings(left, right)));
}

function buildSummary(catalog, enrichment, publishedMode) {
  const skippedReasons = skippedByReason(catalog.diagnostics.skipped);
  if (catalog.diagnostics.unusedMetadataCards > 0) {
    skippedReasons.unused_metadata_card = catalog.diagnostics.unusedMetadataCards;
  }
  for (const conflict of catalog.diagnostics.noteConflicts) {
    const reason = `manual_note_${conflict.reason}`;
    skippedReasons[reason] = (skippedReasons[reason] || 0) + 1;
  }
  const sortedSkippedReasons = Object.fromEntries(
    Object.entries(skippedReasons).sort(([left], [right]) => compareStrings(left, right))
  );
  const skippedCount = Object.values(sortedSkippedReasons).reduce((total, count) => total + count, 0);
  const enrichedIds = new Set(enrichment.appliedIds || []);
  for (const item of catalog.items) {
    const origins = Object.values(item.provenance).flat();
    if (origins.includes("metadata-card") || origins.includes("manual-note")) enrichedIds.add(item.id);
  }
  const sourceModes = catalog.diagnostics.sources;
  return {
    ok: enrichment.failed === 0,
    sources: {
      bookmarks: { mode: sourceModes.bookmarks, read: catalog.diagnostics.input.bookmarks },
      metadataCards: { mode: sourceModes.metadataCards, read: catalog.diagnostics.input.metadataCards },
      webClips: { mode: sourceModes.webClips, read: catalog.diagnostics.input.webClips },
      manualNotes: { mode: sourceModes.manualNotes, read: catalog.diagnostics.input.manualNotes },
    },
    normalized: catalog.items.length,
    enriched: enrichedIds.size,
    skipped: skippedCount,
    skippedByReason: sortedSkippedReasons,
    deduplicated: catalog.diagnostics.duplicateCandidates,
    failed: catalog.diagnostics.skipped.length + enrichment.failed,
    written: catalog.items.length,
    enrichmentAttempted: enrichment.attempted,
    enrichmentFailed: enrichment.failed,
    enrichmentApplied: enrichment.applied,
    publishedMode,
    failures: enrichment.failures,
    failuresOmitted: enrichment.failuresOmitted,
  };
}

function validateExternalConfiguration({ enricherPath, allowExternalEnrichment }) {
  if (Boolean(enricherPath) !== Boolean(allowExternalEnrichment)) {
    throw new IndexBuildError(
      "External enrichment requires both --enricher and --allow-external-enrichment.",
      "external_enrichment_requires_double_opt_in"
    );
  }
}

async function importEnricher(enricherPath) {
  try {
    const moduleUrl = pathToFileURL(path.resolve(enricherPath));
    moduleUrl.searchParams.set("index-build", crypto.randomBytes(8).toString("hex"));
    const module = await import(moduleUrl.href);
    if (typeof module.enrich !== "function") throw new TypeError("missing enrich export");
    return module.enrich;
  } catch {
    throw new IndexBuildError("External enricher could not be loaded.", "enricher_import_failed");
  }
}

async function buildIndex(options = {}) {
  validateExternalConfiguration(options);
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, "..", ".."));
  const indexPath = path.resolve(
    options.indexPath || process.env.INSPIRATION_INDEX_PATH || path.join(rootDir, INDEX_FILENAME)
  );
  const catalog = loadBootstrapCatalog({
    ...options,
    rootDir,
    generatedAt: options.generatedAt || new Date().toISOString(),
  });
  const baseIndex = createIndexDocument(catalog);
  validateIndex(baseIndex);

  let enrichment = {
    ok: true,
    index: baseIndex,
    attempted: 0,
    applied: 0,
    failed: 0,
    failures: [],
    failuresOmitted: 0,
    appliedIds: [],
  };
  if (options.enricherPath) {
    try {
      const enrich = options.enrich || await importEnricher(options.enricherPath);
      enrichment = await runExternalEnrichment(baseIndex, enrich, options);
    } catch (error) {
      const failedIds = baseIndex.items.map((item) => item.id);
      enrichment = {
        ok: false,
        index: baseIndex,
        attempted: 0,
        applied: 0,
        failed: Math.max(1, failedIds.length),
        failures: failedIds.slice(0, MAX_REPORTED_FAILURES).map((id) => ({
          id,
          reason: error.code || "enricher_import_failed",
        })),
        failuresOmitted: Math.max(0, Math.max(1, failedIds.length) - Math.min(failedIds.length, MAX_REPORTED_FAILURES)),
        appliedIds: [],
      };
    }
  }
  const review = reconcileReviewState({
    ...options,
    rootDir,
    notesPath: options.notesPath,
    catalog: enrichment.index,
  });
  enrichment.index = applyAcceptedPatches(enrichment.index, review.document);
  validateIndex(enrichment.index);
  const publishedMode = enrichment.ok && options.enricherPath ? "external-complete" : "offline-base";
  await atomicWriteIndex(enrichment.index, indexPath, options.atomicOptions);
  return {
    index: enrichment.index,
    validation: validateIndex(enrichment.index),
    summary: buildSummary(catalog, enrichment, publishedMode),
  };
}

function readAndValidateIndex(indexPath, options = {}) {
  let contents;
  try {
    contents = (options.readFileSync || fs.readFileSync)(path.resolve(indexPath), "utf8");
  } catch {
    throw new IndexBuildError("Inspiration index could not be read.", "index_read_failed");
  }
  let index;
  try {
    index = JSON.parse(contents);
  } catch {
    throw new IndexBuildError("Inspiration index is invalid.", "index_invalid_json");
  }
  return { index, validation: validateIndex(index) };
}

module.exports = {
  ENRICHMENT_TIMEOUT_MS,
  INDEX_FILENAME,
  IndexBuildError,
  atomicWriteIndex,
  buildIndex,
  createIndexDocument,
  privacyBoundedRecord,
  readAndValidateIndex,
  runExternalEnrichment,
  validateExternalConfiguration,
  validateEnrichmentResult,
};

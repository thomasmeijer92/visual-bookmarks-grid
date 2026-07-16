const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { buildSearchText, validTimestamp } = require("./bootstrap");
const { canonicalJson, cleanString, compareStrings, normalizeList, sha256Canonical } = require("./canonical");
const {
  LOCK_STALE_MS,
  acquireLocalStateLock,
  releaseLocalStateLock,
} = require("./local-state-lock");

const REVIEW_SCHEMA_VERSION = 1;
const MANUAL_NOTES_SOURCE = "visual-bookmarks-grid manual lightbox notes";
const PATCH_STRING_FIELDS = new Map([["title", 10000], ["description", 10000], ["creatorName", 512]]);
const PATCH_LIST_FIELDS = new Set(["collections", "categories", "styles", "colors", "interactions", "visible", "tags"]);
const PATCH_FIELDS = new Set([...PATCH_STRING_FIELDS.keys(), ...PATCH_LIST_FIELDS]);
const REVIEW_ID = /^review:v1:[0-9a-f]{64}$/;
const RECORD_ID = /^visual:v1:[0-9a-f]{64}$/;
const REVIEW_STATUSES = new Set(["needs_review", "resolved", "dismissed"]);
const EVENT_ACTIONS = new Set(["intake", "resolve", "dismiss", "reopen"]);
const SYSTEM_EVENT_REASONS = new Set(["source_note_saved", "source_note_updated", "source_note_deleted"]);
const LEGACY_KIND_RANK = new Map([["canonical", 0], ["card", 1], ["url", 2]]);
const MANUAL_NOTE_FIELDS = new Set(["mediaId", "recordId", "tweetId", "sourceRecordId", "tweetUrl", "mediaUrl", "titleAtEdit", "creatorAtEdit", "note", "text", "status", "createdAt", "updatedAt"]);
const MANUAL_NOTES_ROOT_FIELDS = new Set(["generatedAt", "source", "notes"]);
const MAX_LEGACY_SELECTOR_LENGTH = 512 + 1 + 4096;
const MAX_REVIEW_DIAGNOSTICS = 50;
const MAX_DIAGNOSTIC_CANDIDATE_IDS = 50;
const MAX_REVIEW_EVENTS = 1000;

class ReviewQueueError extends Error {
  constructor(message, code = "review_queue_failed", statusCode = 400) {
    super(message);
    this.name = "ReviewQueueError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  const keys = Object.keys(value).sort(compareStrings);
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function reviewId(recordId) {
  return `review:v1:${sha256Canonical(["catalog-review-v1", recordId])}`;
}

function noteFingerprint(recordId, note) {
  return sha256Canonical({ recordId, normalizedNoteText: note });
}

function emptyReviewDocument() {
  return { schemaVersion: REVIEW_SCHEMA_VERSION, entries: [] };
}

function emptyManualNotesPayload() {
  return { generatedAt: "1970-01-01T00:00:00.000Z", source: MANUAL_NOTES_SOURCE, notes: {} };
}

function reviewPaths(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, "..", ".."));
  const reviewPath = path.resolve(options.reviewPath || process.env.METADATA_REVIEW_PATH || path.join(rootDir, "metadata-review.json"));
  return {
    rootDir,
    reviewPath,
    lockPath: path.resolve(options.lockPath || process.env.METADATA_REVIEW_LOCK_PATH || `${reviewPath.replace(/\.json$/i, "")}.lock`),
  };
}

function notePath(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, "..", ".."));
  return path.resolve(options.notesPath || process.env.MANUAL_NOTES_PATH || path.join(rootDir, "manual-media-notes.json"));
}

function atomicWriteJson(filePath, payload, options = {}) {
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const target = path.resolve(filePath);
  const tempPath = `${target}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
  let descriptor;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    descriptor = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(descriptor, serialized, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    if (options.beforeRename) options.beforeRename(tempPath, target);
    fs.renameSync(tempPath, target);
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(tempPath); } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") throw new ReviewQueueError("Review state could not be written.", "review_write_failed", 500);
    }
    throw error;
  }
}

function readJson(filePath, fallback, role) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) throw new ReviewQueueError(`${role} is invalid.`, "review_invalid_json", 500);
    throw new ReviewQueueError(`${role} could not be read.`, "review_read_failed", 500);
  }
}

function invalidReviewState() {
  return new ReviewQueueError("Review state is invalid.", "review_invalid_state", 500);
}

function invalidManualNotes() {
  return new ReviewQueueError("Manual notes are invalid.", "manual_notes_invalid", 500);
}

function cleanEvent(value, field, max, allowEmpty = false) {
  try {
    return cleanString(value, { field, max, allowEmpty });
  } catch {
    throw invalidReviewState();
  }
}

function cleanReviewReason(value, field) {
  try {
    return cleanString(value, { field, max: 240, allowEmpty: false });
  } catch {
    throw new ReviewQueueError("Review reason is invalid.", "invalid_review_request");
  }
}

function cleanUserReviewReason(value, field) {
  const reason = cleanReviewReason(value, field);
  if (SYSTEM_EVENT_REASONS.has(reason) || reason === "accepted_patch") {
    throw new ReviewQueueError("Review reason is reserved.", "invalid_review_request");
  }
  return reason;
}

function normalizePatch(patch, { requireNonEmpty = true } = {}) {
  if (!isPlainObject(patch)) throw new ReviewQueueError("Patch must be an object.", "invalid_review_patch");
  const keys = Object.keys(patch);
  if (requireNonEmpty && keys.length === 0) throw new ReviewQueueError("Patch must not be empty.", "invalid_review_patch");
  const normalized = {};
  for (const key of keys) {
    if (!PATCH_FIELDS.has(key)) throw new ReviewQueueError(`Patch field is not allowed: ${key}.`, "invalid_review_patch");
    try {
      normalized[key] = PATCH_STRING_FIELDS.has(key)
        ? cleanString(patch[key], { field: `patch ${key}`, max: PATCH_STRING_FIELDS.get(key) })
        : normalizeList(patch[key], { field: `patch ${key}`, maxItems: 500, maxLength: 1000 });
    } catch {
      throw new ReviewQueueError(`Patch field is invalid: ${key}.`, "invalid_review_patch");
    }
  }
  return Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => compareStrings(left, right)));
}

function validateAcceptedPatch(value) {
  if (value === null) return null;
  if (!isPlainObject(value) || !exactKeys(value, ["patch", "provenance"]) || !isPlainObject(value.patch) || !isPlainObject(value.provenance)) {
    throw invalidReviewState();
  }
  let patch;
  try { patch = normalizePatch(value.patch); } catch { throw invalidReviewState(); }
  const patchKeys = Object.keys(patch).sort(compareStrings);
  if (!exactKeys(value.provenance, patchKeys)) throw invalidReviewState();
  for (const key of patchKeys) if (value.provenance[key] !== "manual-override") throw invalidReviewState();
  return { patch, provenance: Object.fromEntries(patchKeys.map((key) => [key, "manual-override"])) };
}

function initialReplayState() {
  return { status: null, sourcePresent: null, resolved: false };
}

function replayReviewEvent(state, event) {
  const { action, reason } = event;
  if (action === "intake") {
    if (state.status !== null || reason !== "source_note_saved") return null;
    return { status: "needs_review", sourcePresent: true, resolved: false };
  }
  if (action === "resolve") {
    if (reason !== "accepted_patch" || state.status !== "needs_review") return null;
    return { ...state, status: "resolved", resolved: true };
  }
  if (action === "dismiss") {
    if (reason === "source_note_deleted") {
      if (state.status !== "needs_review" && state.status !== "resolved" && state.status !== "dismissed") return null;
      return { ...state, status: state.status === "needs_review" ? "dismissed" : state.status, sourcePresent: false };
    }
    if (SYSTEM_EVENT_REASONS.has(reason) || reason === "accepted_patch" || state.status !== "needs_review") return null;
    return { ...state, status: "dismissed" };
  }
  if (action !== "reopen") return null;
  if (reason === "source_note_updated") {
    if (state.status !== "needs_review" && state.status !== "resolved" && state.status !== "dismissed") return null;
    return { ...state, status: "needs_review", sourcePresent: true };
  }
  if (SYSTEM_EVENT_REASONS.has(reason) || reason === "accepted_patch" || (state.status !== "resolved" && state.status !== "dismissed")) return null;
  return { ...state, status: "needs_review" };
}

function replayStateKey(state) {
  return `${state.status || ""}\u0000${state.sourcePresent === null ? "" : state.sourcePresent}\u0000${state.resolved}`;
}

function preferWitness(candidate, current) {
  if (!current || candidate.indexes.length < current.indexes.length) return true;
  if (candidate.indexes.length > current.indexes.length) return false;
  for (let index = candidate.indexes.length - 1; index >= 0; index--) {
    if (candidate.indexes[index] !== current.indexes[index]) return candidate.indexes[index] > current.indexes[index];
  }
  return false;
}

function replayStates(events) {
  const states = [initialReplayState()];
  for (const event of events) {
    const state = replayReviewEvent(states.at(-1), event);
    if (!state) throw invalidReviewState();
    states.push(state);
  }
  return states;
}

function replayWitness(events, targetState) {
  const states = new Map([[replayStateKey(initialReplayState()), { state: initialReplayState(), indexes: [] }]]);
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    for (const candidate of [...states.values()]) {
      const nextState = replayReviewEvent(candidate.state, event);
      if (!nextState) continue;
      const next = { state: nextState, indexes: [...candidate.indexes, index] };
      const key = replayStateKey(nextState);
      if (preferWitness(next, states.get(key))) states.set(key, next);
    }
  }
  return states.get(replayStateKey(targetState))?.indexes || null;
}

function compactReviewEvents(events) {
  if (events.length <= MAX_REVIEW_EVENTS) return events;
  const states = replayStates(events);
  for (let suffixLength = MAX_REVIEW_EVENTS; suffixLength >= 0; suffixLength--) {
    const suffixStart = events.length - suffixLength;
    const witness = replayWitness(events.slice(0, suffixStart), states[suffixStart]);
    if (!witness || witness.length + suffixLength > MAX_REVIEW_EVENTS) continue;
    return [...witness.map((index) => events[index]), ...events.slice(suffixStart)];
  }
  throw invalidReviewState();
}

function compactReviewDocument(document) {
  let changed = false;
  for (const entry of document.entries) {
    const events = compactReviewEvents(entry.events);
    if (events !== entry.events) {
      entry.events = events;
      changed = true;
    }
  }
  return changed;
}

function validateReviewDocument(document) {
  if (!isPlainObject(document) || !exactKeys(document, ["entries", "schemaVersion"]) || document.schemaVersion !== REVIEW_SCHEMA_VERSION || !Array.isArray(document.entries)) {
    throw invalidReviewState();
  }
  const entries = [];
  let previous = "";
  for (const raw of document.entries) {
    if (!isPlainObject(raw) || !exactKeys(raw, ["acceptedPatch", "events", "id", "mediaId", "recordId", "sourceNoteFingerprint", "sourcePresent", "status"])) throw invalidReviewState();
    const { id, recordId, mediaId, sourceNoteFingerprint, sourcePresent, status, events, acceptedPatch } = raw;
    if (typeof id !== "string" || !REVIEW_ID.test(id) || typeof recordId !== "string" || !RECORD_ID.test(recordId) || reviewId(recordId) !== id ||
      typeof mediaId !== "string" || mediaId.length > 1024 || /[\u0000-\u001f\u007f-\u009f]/.test(mediaId) || typeof sourceNoteFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(sourceNoteFingerprint) ||
      typeof sourcePresent !== "boolean" || !REVIEW_STATUSES.has(status) || !Array.isArray(events) || events.length === 0 || events.length > MAX_REVIEW_EVENTS ||
      (previous && compareStrings(previous, recordId) >= 0)) throw invalidReviewState();
    previous = recordId;
    let replayed = initialReplayState();
    const normalizedEvents = events.map((event, index) => {
      if (!isPlainObject(event) || !exactKeys(event, ["action", "at", "reason"]) || typeof event.at !== "string" || validTimestamp(event.at) !== event.at ||
        !EVENT_ACTIONS.has(event.action)) throw invalidReviewState();
      const action = cleanEvent(event.action, "event action", 80);
      const reason = cleanEvent(event.reason, "event reason", 240);
      replayed = replayReviewEvent(replayed, { action, reason });
      if (!replayed || (action === "intake" && index !== 0)) throw invalidReviewState();
      return { at: event.at, action, reason };
    });
    const normalizedPatch = validateAcceptedPatch(acceptedPatch);
    if (replayed.status !== status || replayed.sourcePresent !== sourcePresent || (status === "resolved" && !normalizedPatch) || (normalizedPatch && !replayed.resolved)) throw invalidReviewState();
    entries.push({ id, recordId, mediaId, sourceNoteFingerprint, sourcePresent, status, events: normalizedEvents, acceptedPatch: normalizedPatch });
  }
  return { schemaVersion: REVIEW_SCHEMA_VERSION, entries };
}

function strictManualString(value, max, { allowEmpty = true } = {}) {
  if (typeof value !== "string") throw invalidManualNotes();
  try {
    if (cleanString(value, { max, allowEmpty }) !== value) throw invalidManualNotes();
  } catch {
    throw invalidManualNotes();
  }
  return value;
}

function optionalManualString(value, max, options = {}) {
  if (value === undefined) return "";
  return strictManualString(value, max, options);
}

function optionalManualTimestamp(value) {
  if (value === undefined) return null;
  if (typeof value !== "string" || validTimestamp(value) !== value) throw invalidManualNotes();
  return value;
}

function normalizeManualNote(raw, mapKey, index, generatedAt) {
  if (!isPlainObject(raw) || Object.keys(raw).some((key) => !MANUAL_NOTE_FIELDS.has(key))) throw invalidManualNotes();
  for (const field of ["mediaId", "recordId", "tweetId", "sourceRecordId", "tweetUrl", "mediaUrl", "titleAtEdit", "creatorAtEdit", "note", "text", "status", "createdAt", "updatedAt"]) {
    if (raw[field] !== undefined && typeof raw[field] !== "string") throw invalidManualNotes();
  }
  if (raw.status !== undefined && raw.status !== "needs_agent_review") throw invalidManualNotes();
  const recordId = optionalManualString(raw.recordId, 1024);
  if (recordId && !RECORD_ID.test(recordId)) throw invalidManualNotes();
  const updatedAt = optionalManualTimestamp(raw.updatedAt);
  const createdAt = optionalManualTimestamp(raw.createdAt);
  const note = optionalManualString(raw.note !== undefined ? raw.note : raw.text, 2400);
  return {
    mapKey,
    index,
    raw: structuredClone(raw),
    mediaId: optionalManualString(raw.mediaId, 1024),
    recordId,
    tweetId: optionalManualString(raw.tweetId !== undefined ? raw.tweetId : raw.sourceRecordId, 512),
    tweetUrl: optionalManualString(raw.tweetUrl, 600),
    mediaUrl: optionalManualString(raw.mediaUrl, 4096),
    titleAtEdit: optionalManualString(raw.titleAtEdit, 240),
    creatorAtEdit: optionalManualString(raw.creatorAtEdit, 180),
    note,
    status: raw.status || "needs_agent_review",
    createdAt: createdAt || updatedAt || generatedAt,
    updatedAt,
  };
}

function validateManualNotesPayload(payload) {
  if (!isPlainObject(payload)) throw invalidManualNotes();
  const noteEntryShape = (value) => isPlainObject(value) && Object.keys(value).length > 0 &&
    Object.keys(value).every((key) => MANUAL_NOTE_FIELDS.has(key));
  const envelopeCandidate = Object.prototype.hasOwnProperty.call(payload, "notes") &&
    !noteEntryShape(payload.notes) &&
    (Array.isArray(payload.notes) || isPlainObject(payload.notes));
  if (envelopeCandidate && Object.keys(payload).some((key) => !MANUAL_NOTES_ROOT_FIELDS.has(key))) throw invalidManualNotes();
  const envelopeShape = envelopeCandidate;
  const generatedAt = envelopeShape ? optionalManualTimestamp(payload.generatedAt) || "1970-01-01T00:00:00.000Z" : "1970-01-01T00:00:00.000Z";
  const source = envelopeShape ? optionalManualString(payload.source, 240) || MANUAL_NOTES_SOURCE : MANUAL_NOTES_SOURCE;
  const rawNotes = envelopeShape ? payload.notes : payload;
  if (!rawNotes || typeof rawNotes !== "object") throw invalidManualNotes();
  const notes = {};
  const entries = [];
  if (Array.isArray(rawNotes)) {
    if (rawNotes.length > 10000) throw invalidManualNotes();
    rawNotes.forEach((raw, index) => entries.push(normalizeManualNote(raw, undefined, index, generatedAt)));
  } else if (isPlainObject(rawNotes)) {
    const keys = Object.keys(rawNotes);
    if (keys.length > 10000) throw invalidManualNotes();
    keys.forEach((mapKey, index) => {
      strictManualString(mapKey, MAX_LEGACY_SELECTOR_LENGTH, { allowEmpty: false });
      const normalized = normalizeManualNote(rawNotes[mapKey], mapKey, index, generatedAt);
      entries.push(normalized);
      notes[mapKey] = normalized;
    });
  } else {
    throw invalidManualNotes();
  }
  return {
    generatedAt,
    source,
    notes,
    entries,
    storageKind: Array.isArray(rawNotes) ? "array" : envelopeShape ? "notes-map" : "root-map",
  };
}

function manualNotesPayload(filePath) {
  return validateManualNotesPayload(readJson(filePath, emptyManualNotesPayload(), "Manual notes"));
}

function browserManualNote(entry) {
  return {
    mediaId: entry.mediaId,
    recordId: entry.recordId,
    tweetId: entry.tweetId,
    tweetUrl: entry.tweetUrl,
    mediaUrl: entry.mediaUrl,
    titleAtEdit: entry.titleAtEdit,
    creatorAtEdit: entry.creatorAtEdit,
    note: entry.note,
    status: entry.status,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function browserManualNoteKey(entry, usedKeys) {
  const preferred = entry.mediaId || entry.recordId || entry.mapKey;
  if (preferred && !usedKeys.has(preferred)) return preferred;
  return `legacy-note:v1:${sha256Canonical([entry.mapKey || "", entry.index, entry.raw])}`;
}

function manualNotesBrowserPayload(payload) {
  const notesPayload = Array.isArray(payload?.entries) ? payload : validateManualNotesPayload(payload);
  const notes = Object.create(null);
  const usedKeys = new Set();
  for (const entry of notesPayload.entries) {
    let key = browserManualNoteKey(entry, usedKeys);
    while (usedKeys.has(key)) key = `legacy-note:v1:${sha256Canonical([key, entry.raw])}`;
    usedKeys.add(key);
    notes[key] = browserManualNote(entry);
  }
  return { generatedAt: notesPayload.generatedAt, source: notesPayload.source, notes };
}

function persistedManualNote(raw) {
  if (raw.raw) return structuredClone(raw.raw);
  return {
    mediaId: raw.mediaId,
    recordId: raw.recordId,
    tweetId: raw.tweetId,
    tweetUrl: raw.tweetUrl,
    mediaUrl: raw.mediaUrl,
    titleAtEdit: raw.titleAtEdit,
    creatorAtEdit: raw.creatorAtEdit,
    note: raw.note,
    status: raw.status,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function manualNotesForWrite(payload) {
  if (payload.storageKind === "array") {
    return { generatedAt: payload.generatedAt, source: payload.source, notes: payload.entries.map(persistedManualNote) };
  }
  const notes = Object.fromEntries(payload.entries.map((entry) => [entry.mapKey, persistedManualNote(entry)]));
  if (payload.storageKind === "root-map") return notes;
  return { generatedAt: payload.generatedAt, source: payload.source, notes };
}

function readReviewDocument(filePath) {
  return validateReviewDocument(readJson(filePath, emptyReviewDocument(), "Review state"));
}

function eventAt(value, fallback) {
  if (typeof value === "string" && validTimestamp(value) === value) return value;
  if (typeof fallback === "string" && validTimestamp(fallback) === fallback) return fallback;
  return "1970-01-01T00:00:00.000Z";
}

function resolverMap(catalog) {
  const ids = new Set((catalog.items || []).map((item) => item.id));
  const mediaByRecord = new Map((catalog.items || []).map((item) => [item.id, item.mediaId]));
  const aliases = new Map();
  const add = (key, catalogId, kind) => {
    if (!key || !LEGACY_KIND_RANK.has(kind)) return;
    const matches = aliases.get(key) || [];
    matches.push({ catalogId, kind });
    aliases.set(key, matches);
  };
  for (const row of catalog.resolverAliases || []) {
    add(row.mediaId, row.catalogId, "canonical");
    for (const mediaId of row.mediaIdAliases || []) add(mediaId, row.catalogId, mediaId === row.mediaId ? "canonical" : "card");
    for (const alias of row.legacyNoteKeyAliases || []) add(alias.key, row.catalogId, alias.kind);
  }
  return { ids, mediaByRecord, aliases };
}

function resolveNote(raw, mapKey, resolver) {
  if (raw.recordId) {
    return resolver.ids.has(raw.recordId)
      ? { recordId: raw.recordId, aliasKind: "canonical" }
      : { reason: "unresolved_record_id", candidateRecordIds: [raw.recordId] };
  }
  const selectors = [mapKey, raw.mediaId];
  if (raw.tweetId && raw.mediaUrl) selectors.push(`${raw.tweetId}:${raw.mediaUrl}`);
  if (raw.mediaUrl) selectors.push(raw.mediaUrl);
  const candidates = selectors.flatMap((selector) => resolver.aliases.get(selector) || []);
  const ids = [...new Set(candidates.map((candidate) => candidate.catalogId))];
  if (ids.length === 0) return { reason: "unresolved_legacy_note_alias", candidateRecordIds: [] };
  if (ids.length !== 1) return { reason: "ambiguous_legacy_note_alias", candidateRecordIds: ids.sort(compareStrings) };
  const recordId = ids[0];
  const aliasKind = candidates.filter((candidate) => candidate.catalogId === recordId)
    .sort((left, right) => LEGACY_KIND_RANK.get(left.kind) - LEGACY_KIND_RANK.get(right.kind) || compareStrings(left.kind, right.kind))[0].kind;
  return { recordId, aliasKind };
}

function reviewCandidates(notesPayload, catalog) {
  const resolver = resolverMap(catalog);
  const candidates = [];
  const unresolved = {};
  const diagnostics = [];
  const protectedRecordIds = new Set();
  let preserveAllExistingSourcePresence = false;
  for (const raw of notesPayload.entries) {
    if (!raw.note) continue;
    const resolved = resolveNote(raw, raw.mapKey, resolver);
    if (!resolved.recordId) {
      unresolved[resolved.reason] = (unresolved[resolved.reason] || 0) + 1;
      const candidateRecordIds = [...new Set(resolved.candidateRecordIds || [])].sort(compareStrings);
      candidateRecordIds.forEach((recordId) => protectedRecordIds.add(recordId));
      if (candidateRecordIds.length === 0) preserveAllExistingSourcePresence = true;
      diagnostics.push({ reason: resolved.reason, candidateRecordIds });
      continue;
    }
    candidates.push({
      recordId: resolved.recordId,
      mediaId: resolver.mediaByRecord.get(resolved.recordId) || "",
      fingerprint: noteFingerprint(resolved.recordId, raw.note),
      at: eventAt(raw.updatedAt, notesPayload.generatedAt),
      aliasKind: resolved.aliasKind,
    });
  }
  candidates.sort((left, right) => compareStrings(left.recordId, right.recordId) || Date.parse(right.at) - Date.parse(left.at) ||
    LEGACY_KIND_RANK.get(left.aliasKind) - LEGACY_KIND_RANK.get(right.aliasKind) || compareStrings(left.fingerprint, right.fingerprint));
  return {
    candidates,
    unresolved: Object.fromEntries(Object.entries(unresolved).sort(([left], [right]) => compareStrings(left, right))),
    diagnostics: diagnostics.sort((left, right) => compareStrings(left.reason, right.reason) ||
      compareStrings(left.candidateRecordIds.join("\u0000"), right.candidateRecordIds.join("\u0000"))),
    protectedRecordIds,
    preserveAllExistingSourcePresence,
  };
}

function reconcileDocument(document, notesPayload, catalog) {
  const current = validateReviewDocument(document);
  const notes = Array.isArray(notesPayload?.entries) ? notesPayload : validateManualNotesPayload(notesPayload);
  const { candidates, unresolved, diagnostics, protectedRecordIds, preserveAllExistingSourcePresence } = reviewCandidates(notes, catalog);
  const selected = new Map();
  for (const candidate of candidates) if (!selected.has(candidate.recordId)) selected.set(candidate.recordId, candidate);
  const entries = new Map(current.entries.map((entry) => [entry.recordId, structuredClone(entry)]));

  for (const [recordId, candidate] of selected) {
    const existing = entries.get(recordId);
    if (!existing) {
      entries.set(recordId, {
        id: reviewId(recordId), recordId, mediaId: candidate.mediaId, sourceNoteFingerprint: candidate.fingerprint,
        sourcePresent: true, status: "needs_review",
        events: [{ at: candidate.at, action: "intake", reason: "source_note_saved" }], acceptedPatch: null,
      });
      continue;
    }
    const changed = existing.sourceNoteFingerprint !== candidate.fingerprint || !existing.sourcePresent;
    existing.mediaId = candidate.mediaId;
    existing.sourceNoteFingerprint = candidate.fingerprint;
    existing.sourcePresent = true;
    if (changed) {
      existing.status = "needs_review";
      existing.events.push({ at: candidate.at, action: "reopen", reason: "source_note_updated" });
    }
  }

  for (const entry of entries.values()) {
    if (selected.has(entry.recordId) || !entry.sourcePresent || protectedRecordIds.has(entry.recordId) || preserveAllExistingSourcePresence) continue;
    entry.sourcePresent = false;
    entry.events.push({ at: eventAt(notes.generatedAt, null), action: "dismiss", reason: "source_note_deleted" });
    if (entry.status === "needs_review") {
      entry.status = "dismissed";
    }
  }
  const result = { schemaVersion: REVIEW_SCHEMA_VERSION, entries: [...entries.values()].sort((left, right) => compareStrings(left.recordId, right.recordId)) };
  compactReviewDocument(result);
  validateReviewDocument(result);
  return { document: result, changed: canonicalJson(current) !== canonicalJson(result), unresolved, diagnostics };
}

function boundedReviewDiagnostics(diagnostics) {
  const visibleDiagnostics = diagnostics.slice(0, MAX_REVIEW_DIAGNOSTICS);
  return {
    diagnostics: visibleDiagnostics.map((diagnostic) => {
      const candidateRecordIds = [...new Set(diagnostic.candidateRecordIds || [])].sort(compareStrings);
      return {
        reason: diagnostic.reason,
        candidateRecordIds: candidateRecordIds.slice(0, MAX_DIAGNOSTIC_CANDIDATE_IDS),
        candidateRecordIdsOmitted: Math.max(0, candidateRecordIds.length - MAX_DIAGNOSTIC_CANDIDATE_IDS),
      };
    }),
    diagnosticsOmitted: Math.max(0, diagnostics.length - MAX_REVIEW_DIAGNOSTICS),
  };
}

function acquireLock(lockPath, now = Date.now()) {
  return acquireLocalStateLock(lockPath, {
    now,
    errors: {
      busy: () => new ReviewQueueError("Review queue is busy.", "review_lock_busy", 503),
      failed: () => new ReviewQueueError("Review queue is unavailable.", "review_lock_failed", 503),
    },
  });
}

function releaseLock(lockPath, owner) {
  releaseLocalStateLock(lockPath, owner);
}

function withLock(options, operation) {
  const paths = reviewPaths(options);
  const owner = acquireLock(paths.lockPath, options.lockNow || Date.now());
  try { return operation(paths); } finally { releaseLock(paths.lockPath, owner); }
}

function reconcileReviewState(options = {}) {
  return withLock(options, ({ reviewPath }) => {
    const catalog = options.catalog || options.loadCatalog?.();
    if (!catalog) throw new ReviewQueueError("Catalog is unavailable.", "review_catalog_unavailable", 503);
    const notes = manualNotesPayload(notePath(options));
    const current = readReviewDocument(reviewPath);
    const reconciled = reconcileDocument(current, notes, catalog);
    if (reconciled.changed) atomicWriteJson(reviewPath, reconciled.document, options.reviewAtomicOptions);
    return reconciled;
  });
}

function makeManualNote(rawNote, existing, catalog) {
  if (!isPlainObject(rawNote)) throw new ReviewQueueError("Missing note payload.", "invalid_manual_note");
  let mediaId;
  let text;
  try {
    mediaId = cleanString(rawNote.mediaId, { field: "mediaId", max: 1024, allowEmpty: false });
    text = cleanString(rawNote.note, { field: "note", max: 2400 });
  } catch {
    throw new ReviewQueueError("Manual note is invalid.", "invalid_manual_note");
  }
  const resolver = resolverMap(catalog);
  const resolved = resolveNote({ mediaId }, mediaId, resolver);
  if (!text) return { mediaId, targetRecordId: resolved.recordId || "", deleted: true };
  const clean = (key, max) => {
    try { return cleanString(rawNote[key], { field: key, max }); } catch { throw new ReviewQueueError("Manual note is invalid.", "invalid_manual_note"); }
  };
  const now = new Date().toISOString();
  return {
    mediaId,
    targetRecordId: resolved.recordId || "",
    entry: {
      mediaId, recordId: resolved.recordId || "", tweetId: clean("tweetId", 80), tweetUrl: clean("tweetUrl", 600),
      mediaUrl: clean("mediaUrl", 1000), titleAtEdit: clean("titleAtEdit", 240), creatorAtEdit: clean("creatorAtEdit", 180),
      note: text, status: "needs_agent_review", createdAt: existing?.createdAt || now, updatedAt: now,
    },
    deleted: false,
  };
}

function manualNoteMatches(entry, mutation, resolver) {
  if (!mutation.targetRecordId) return entry.mapKey === mutation.mediaId || entry.mediaId === mutation.mediaId;
  return resolveNote(entry, entry.mapKey, resolver).recordId === mutation.targetRecordId;
}

function existingManualNote(payload, mutation, resolver) {
  return payload.entries.find((entry) => manualNoteMatches(entry, mutation, resolver));
}

function mutationEntry(mutation, mapKey, index) {
  return { ...structuredClone(mutation.entry), raw: structuredClone(mutation.entry), mapKey, index };
}

function applyManualNoteMutation(payload, mutation, resolver) {
  const entries = [];
  let inserted = false;
  for (const entry of payload.entries) {
    if (!manualNoteMatches(entry, mutation, resolver)) {
      entries.push(entry);
      continue;
    }
    if (!mutation.deleted && !inserted) {
      const mapKey = payload.storageKind === "array" ? undefined : mutation.mediaId;
      entries.push(mutationEntry(mutation, mapKey, entries.length));
      inserted = true;
    }
  }
  if (!mutation.deleted && !inserted) {
    const mapKey = payload.storageKind === "array" ? undefined : mutation.mediaId;
    entries.push(mutationEntry(mutation, mapKey, entries.length));
  }
  payload.entries = entries.map((entry, index) => ({ ...entry, index }));
  if (payload.storageKind !== "array") {
    payload.notes = Object.fromEntries(payload.entries.map((entry) => [entry.mapKey, entry]));
  }
}

function mutateManualNote(rawNote, options = {}) {
  return withLock(options, ({ reviewPath }) => {
    const catalog = options.catalog || options.loadCatalog?.();
    if (!catalog) throw new ReviewQueueError("Catalog is unavailable.", "review_catalog_unavailable", 503);
    const notesPath = notePath(options);
    const notes = manualNotesPayload(notesPath);
    const current = readReviewDocument(reviewPath);
    const before = reconcileDocument(current, notes, catalog);
    const requested = makeManualNote(rawNote, null, catalog);
    const resolver = resolverMap(catalog);
    const mutation = makeManualNote(rawNote, existingManualNote(notes, requested, resolver), catalog);
    applyManualNoteMutation(notes, mutation, resolver);
    notes.generatedAt = mutation.deleted ? new Date().toISOString() : mutation.entry.updatedAt;
    const persistedNotes = manualNotesForWrite(notes);
    atomicWriteJson(notesPath, persistedNotes, options.notesAtomicOptions);
    try {
      const after = reconcileDocument(before.document, persistedNotes, catalog);
      if (after.changed || before.changed) atomicWriteJson(reviewPath, after.document, options.reviewAtomicOptions);
      return { entry: mutation.entry || null, deleted: mutation.deleted, review: after.document, unresolved: after.unresolved };
    } catch (error) {
      const failure = error instanceof ReviewQueueError ? error : new ReviewQueueError("Review reconciliation is pending.", "review_reconcile_pending", 500);
      failure.noteSaved = true;
      throw failure;
    }
  });
}

function transition(id, action, input, options = {}) {
  return withLock(options, ({ reviewPath }) => {
    const catalog = options.catalog || options.loadCatalog?.();
    if (!catalog) throw new ReviewQueueError("Catalog is unavailable.", "review_catalog_unavailable", 503);
    const notes = manualNotesPayload(notePath(options));
    const current = readReviewDocument(reviewPath);
    const reconciled = reconcileDocument(current, notes, catalog);
    const document = structuredClone(reconciled.document);
    const entry = document.entries.find((candidate) => candidate.id === id);
    if (!entry) throw new ReviewQueueError("Review entry not found.", "review_not_found", 404);
    if (!isPlainObject(input)) throw new ReviewQueueError("Review request must be an object.", "invalid_review_request");
    const at = options.now || new Date().toISOString();
    if (action === "resolve") {
      if (entry.status !== "needs_review") throw new ReviewQueueError("Review entry cannot be resolved from its current status.", "invalid_review_transition");
      const patch = normalizePatch(input.patch);
      entry.status = "resolved";
      entry.acceptedPatch = { patch, provenance: Object.fromEntries(Object.keys(patch).map((key) => [key, "manual-override"])) };
      entry.events.push({ at, action: "resolve", reason: "accepted_patch" });
    } else if (action === "dismiss") {
      if (entry.status !== "needs_review") throw new ReviewQueueError("Review entry cannot be dismissed from its current status.", "invalid_review_transition");
      const reason = cleanUserReviewReason(input.reason, "dismiss reason");
      entry.status = "dismissed";
      entry.events.push({ at, action: "dismiss", reason });
    } else if (action === "reopen") {
      if (entry.status === "needs_review") throw new ReviewQueueError("Review entry is already open.", "invalid_review_transition");
      const reason = cleanUserReviewReason(input.reason, "reopen reason");
      entry.status = "needs_review";
      entry.events.push({ at, action: "reopen", reason });
    } else {
      throw new ReviewQueueError("Invalid review transition.", "invalid_review_transition");
    }
    compactReviewDocument(document);
    validateReviewDocument(document);
    atomicWriteJson(reviewPath, document, options.reviewAtomicOptions);
    return entry;
  });
}

function listReviewEntries(request = {}, options = {}) {
  const status = request.status === undefined || request.status === "" ? "" : request.status;
  if (status && !REVIEW_STATUSES.has(status)) throw new ReviewQueueError("Invalid review status.", "invalid_review_list");
  const limit = request.limit === undefined ? 20 : Number(request.limit);
  const offset = request.offset === undefined ? 0 : Number(request.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0) throw new ReviewQueueError("Invalid review pagination.", "invalid_review_list");
  const reconciled = reconcileReviewState(options);
  const entries = reconciled.document.entries.filter((entry) => !status || entry.status === status);
  const diagnostics = boundedReviewDiagnostics(reconciled.diagnostics);
  return {
    ok: true,
    status: status || null,
    total: entries.length,
    limit,
    offset,
    entries: entries.slice(offset, offset + limit),
    unresolved: reconciled.unresolved,
    diagnostics: diagnostics.diagnostics,
    diagnosticsOmitted: diagnostics.diagnosticsOmitted,
  };
}

function applyAcceptedPatches(index, document) {
  const patches = new Map();
  for (const entry of validateReviewDocument(document).entries) if (entry.acceptedPatch) patches.set(entry.recordId, entry.acceptedPatch);
  const items = index.items.map((item) => {
    const accepted = patches.get(item.id);
    if (!accepted) return item;
    const next = structuredClone(item);
    for (const [field, value] of Object.entries(accepted.patch)) {
      next[field] = value;
      next.provenance[field] = [accepted.provenance[field]];
    }
    next.searchText = buildSearchText(next).searchText;
    return next;
  });
  return { ...index, items };
}

module.exports = {
  LOCK_STALE_MS,
  MANUAL_NOTES_SOURCE,
  MAX_REVIEW_EVENTS,
  PATCH_FIELDS,
  REVIEW_SCHEMA_VERSION,
  ReviewQueueError,
  acquireLock,
  applyAcceptedPatches,
  atomicWriteJson,
  listReviewEntries,
  manualNotesBrowserPayload,
  manualNotesPayload,
  mutateManualNote,
  normalizePatch,
  reconcileDocument,
  reconcileReviewState,
  releaseLock,
  reviewId,
  transition,
  validateManualNotesPayload,
  validateReviewDocument,
};

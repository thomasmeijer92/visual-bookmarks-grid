const fs = require("fs");
const path = require("path");
const {
  boundedRawString,
  canonicalizeAbsoluteUrl,
  canonicalizeMediaUrl,
  cleanString,
  compareStrings,
  hasUnsafeTerminalControl,
  normalizeList,
  sha256Canonical,
} = require("./canonical");

const LIST_FIELDS = ["collections", "categories", "styles", "colors", "interactions", "visible", "tags"];
const LEGACY_KIND_RANK = new Map([["canonical", 0], ["card", 1], ["url", 2]]);
const MISSING = Symbol("missing catalog source");
const MAX_LEGACY_ALIAS_LENGTH = 512 + 1 + 4096;
const MAX_SEARCH_TEXT_LENGTH = 10000;
const DERIVED_MEDIA_ID = /^media-url:v1:[0-9a-f]{64}$/;
const MANUAL_NOTE_FIELDS = new Set(["mediaId", "recordId", "tweetId", "sourceRecordId", "tweetUrl", "mediaUrl", "titleAtEdit", "creatorAtEdit", "note", "text", "status", "createdAt", "updatedAt"]);
const MANUAL_NOTES_ROOT_FIELDS = new Set(["generatedAt", "source", "notes"]);
const ISO_TIMESTAMP_WITH_OFFSET = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2})(?:\.(?<fraction>\d+))?)?(?<zone>Z|(?<offsetSign>[+-])(?<offsetHour>\d{2}):?(?<offsetMinute>\d{2}))$/i;

class CatalogValidationError extends Error {
  constructor(message, code = "catalog_validation_error") {
    super(message);
    this.name = "CatalogValidationError";
    this.code = code;
  }
}

function asObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CatalogValidationError(`${field} must be an object.`);
  }
  return value;
}

function optionalString(value, field, max = 10000) {
  return cleanString(value, { field, max });
}

function identityString(value, field, max) {
  return boundedRawString(value, { field, max });
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function validTimestamp(value) {
  if (typeof value !== "string") return null;
  const timestamp = value.trim();
  const match = ISO_TIMESTAMP_WITH_OFFSET.exec(timestamp);
  if (!match) return null;

  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  const hour = Number(match.groups.hour);
  const minute = Number(match.groups.minute);
  const second = match.groups.second === undefined ? 0 : Number(match.groups.second);
  const offsetHour = match.groups.offsetHour === undefined ? 0 : Number(match.groups.offsetHour);
  const offsetMinute = match.groups.offsetMinute === undefined ? 0 : Number(match.groups.offsetMinute);
  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 23 || offsetMinute > 59 ||
    !Number.isFinite(Date.parse(timestamp))
  ) return null;
  return timestamp;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function flattenInputs(...values) {
  const output = [];
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) output.push(...value);
    else output.push(value);
  }
  return output;
}

function normalizedLists(raw, sourceType) {
  const groups = raw.tagGroups && typeof raw.tagGroups === "object" && !Array.isArray(raw.tagGroups)
    ? raw.tagGroups
    : {};
  const tweetFolders = raw.tweet && typeof raw.tweet === "object" && Array.isArray(raw.tweet.folders)
    ? raw.tweet.folders
    : [];
  const isCard = sourceType === "metadata-card";

  return {
    collections: normalizeList(flattenInputs(
      raw.collections,
      raw.collection,
      raw.folders,
      isCard ? tweetFolders : [],
      groups.collection
    ), { field: `${sourceType}.collections` }),
    categories: normalizeList(flattenInputs(raw.categories, raw.category, groups.category), {
      field: `${sourceType}.categories`,
    }),
    styles: normalizeList(flattenInputs(raw.styles, raw.style, groups.style), { field: `${sourceType}.styles` }),
    colors: normalizeList(flattenInputs(raw.colors, raw.color, groups.color), { field: `${sourceType}.colors` }),
    interactions: normalizeList(flattenInputs(raw.interactions, raw.interaction, groups.interaction), {
      field: `${sourceType}.interactions`,
    }),
    visible: normalizeList(flattenInputs(
      raw.visible,
      raw.visibleText,
      raw.objects,
      raw.scene,
      groups.visible
    ), { field: `${sourceType}.visible` }),
    tags: normalizeList(flattenInputs(raw.tags, raw.tagSlugs, groups.tags), { field: `${sourceType}.tags` }),
  };
}

function cleanMedia(rawMedia, field) {
  const media = asObject(rawMedia, field);
  return {
    type: optionalString(media.type, `${field}.type`, 80),
    url: identityString(media.url, `${field}.url`, 4096),
    width: numberOrNull(media.width),
    height: numberOrNull(media.height),
  };
}

function derivedMediaId(canonicalMediaKey) {
  return `media-url:v1:${sha256Canonical(["catalog-media-url-v1", canonicalMediaKey])}`;
}

function normalizedNativeMediaId(value, field) {
  const id = identityString(value, field, 1024);
  // This namespace belongs exclusively to canonical-media derivation. A source
  // value that occupies it cannot remain an alias for a different URL.
  return DERIVED_MEDIA_ID.test(id) ? "" : id;
}

function visualId(canonicalSourceKey, canonicalMediaKey) {
  return `visual:v1:${sha256Canonical(["catalog-visual-v1", canonicalSourceKey, canonicalMediaKey])}`;
}

function cardSourceId(card) {
  const historical = card.tweet && typeof card.tweet === "object" ? card.tweet.id : "";
  return identityString(historical || card.sourceRecordId, "metadata-card.sourceRecordId", 512);
}

function cardProjection(card) {
  return {
    sourceRecordId: card.sourceRecordId,
    mediaId: card.mediaId,
    mediaUrl: card.mediaUrl,
    canonicalMediaKey: card.canonicalMediaKey,
    title: card.title,
    description: card.description,
    creatorName: card.creatorName,
    creatorHandle: card.creatorHandle,
    creatorAvatarUrl: card.creatorAvatarUrl,
    sourceName: card.sourceName,
    mediaType: card.mediaType,
    scanStatus: card.scanStatus,
    lists: card.lists,
    ordinal: card.ordinal,
    declaresPrimaryOrdinal: card.declaresPrimaryOrdinal,
  };
}

function normalizeCard(rawCard) {
  const raw = asObject(rawCard, "metadata card");
  const mediaRaw = raw.media && typeof raw.media === "object" && !Array.isArray(raw.media) ? raw.media : {};
  const rawMediaUrl = identityString(mediaRaw.url, "metadata-card.media.url", 4096);
  const canonicalMedia = rawMediaUrl ? canonicalizeMediaUrl(rawMediaUrl) : { ok: false };
  const author = raw.author && typeof raw.author === "object" && !Array.isArray(raw.author) ? raw.author : {};
  const ordinalValue = raw.mediaIndex ?? raw.mediaOrdinal ?? raw.ordinal ?? null;
  const ordinal = Number.isInteger(ordinalValue) ? ordinalValue : null;
  const declaresPrimaryOrdinal = Number.isInteger(raw.mediaIndex)
    ? raw.mediaIndex === 0
    : Number.isInteger(raw.mediaOrdinal)
      ? raw.mediaOrdinal === 1
      : Number.isInteger(raw.ordinal)
        ? raw.ordinal === 0 || raw.ordinal === 1
        : false;
  const card = {
    sourceRecordId: cardSourceId(raw),
    mediaId: normalizedNativeMediaId(raw.mediaId || mediaRaw.mediaId || mediaRaw.id, "metadata-card.mediaId"),
    mediaUrl: canonicalMedia.ok ? canonicalMedia.display : "",
    canonicalMediaKey: canonicalMedia.ok ? canonicalMedia.key : "",
    title: optionalString(raw.title, "metadata-card.title"),
    description: optionalString(raw.description, "metadata-card.description"),
    creatorName: optionalString(raw.creator || author.name, "metadata-card.creatorName"),
    creatorHandle: optionalString(raw.creatorHandle || author.handle, "metadata-card.creatorHandle", 512),
    creatorAvatarUrl: optionalString(author.avatarUrl, "metadata-card.creatorAvatarUrl", 4096),
    sourceName: optionalString(raw.source, "metadata-card.sourceName", 512),
    mediaType: optionalString(mediaRaw.type, "metadata-card.media.type", 80),
    scanStatus: optionalString(raw.scanStatus, "metadata-card.scanStatus", 160),
    ordinal,
    declaresPrimaryOrdinal,
    lists: normalizedLists(raw, "metadata-card"),
  };
  card.fingerprint = sha256Canonical(cardProjection(card));
  return card;
}

function mediaIdEncodesPrimary(mediaId, sourceRecordId) {
  if (!mediaId || !sourceRecordId || !mediaId.startsWith(sourceRecordId)) return false;
  const suffix = mediaId.slice(sourceRecordId.length);
  return /(?:^|[-_:])(0|00|01)(?:$|[-_:])/i.test(suffix);
}

function cardEvidence(card, base) {
  if (base.nativeMediaId && card.mediaId === base.nativeMediaId) return 0;
  if (card.canonicalMediaKey && card.canonicalMediaKey === base.canonicalMediaKey) return 1;
  if (
    card.sourceRecordId === base.sourceRecordId &&
    (card.declaresPrimaryOrdinal || mediaIdEncodesPrimary(card.mediaId, base.sourceRecordId))
  ) {
    return 2;
  }
  if (base.mediaCount === 1) return card.scanStatus === "vision_scanned" ? 3 : 4;
  return Number.POSITIVE_INFINITY;
}

function selectPrimaryCard(base, cards) {
  const eligible = cards
    .map((card) => ({ card, evidence: cardEvidence(card, base) }))
    .filter((entry) => Number.isFinite(entry.evidence));
  eligible.sort((left, right) =>
    left.evidence - right.evidence ||
    compareStrings(left.card.mediaId, right.card.mediaId) ||
    compareStrings(left.card.canonicalMediaKey, right.card.canonicalMediaKey) ||
    compareStrings(left.card.fingerprint, right.card.fingerprint)
  );
  return eligible[0]?.card || null;
}

function normalizedImageProjection(rawImages) {
  if (!Array.isArray(rawImages)) throw new CatalogValidationError("bookmark.images must be an array.");
  return rawImages.map((image, index) => {
    const normalized = cleanMedia(image, `bookmark.images[${index}]`);
    return {
      id: normalizedNativeMediaId(image.mediaId || image.id, `bookmark.images[${index}].id`),
      ...normalized,
    };
  });
}

function createBookmarkBase(rawBookmark) {
  const raw = asObject(rawBookmark, "bookmark");
  const images = normalizedImageProjection(raw.images);
  if (images.length === 0 || !images[0].url) return { skipped: "missing_primary_visual" };

  const sourceUrl = identityString(raw.url, "bookmark.url", 4096);
  const canonicalSource = canonicalizeAbsoluteUrl(sourceUrl);
  if (!canonicalSource.ok) return { skipped: "invalid_source_url" };
  const canonicalMedia = canonicalizeMediaUrl(images[0].url);
  if (!canonicalMedia.ok) return { skipped: "invalid_primary_media_url" };

  images[0].url = canonicalMedia.display;
  const sourceRecordId = identityString(raw.id || raw.tweetId, "bookmark.id", 512);
  const nativeMediaId = images[0].id;
  const lists = normalizedLists(raw, "bookmark");
  const title = optionalString(raw.title || raw.text, "bookmark.title");
  const description = optionalString(raw.description || raw.text, "bookmark.description");
  const base = {
    sourceType: "bookmark",
    sourceRecordId,
    hasNativeSourceId: Boolean(sourceRecordId),
    nativeMediaId,
    mediaId: nativeMediaId || derivedMediaId(canonicalMedia.key),
    sourceName: optionalString(raw.sourcePlatform || raw.source, "bookmark.sourceName", 512),
    sourceUrl: canonicalSource.display,
    canonicalSourceKey: canonicalSource.key,
    canonicalMediaKey: canonicalMedia.key,
    title,
    description,
    creatorName: optionalString(raw.authorName, "bookmark.creatorName", 512),
    creatorHandle: optionalString(raw.authorHandle, "bookmark.creatorHandle", 512),
    creatorAvatarUrl: optionalString(raw.authorAvatar, "bookmark.creatorAvatarUrl", 4096),
    media: {
      type: images[0].type,
      url: images[0].url,
      width: images[0].width,
      height: images[0].height,
    },
    mediaCount: images.length,
    lists,
    savedAt: validTimestamp(raw.bookmarkedAt || raw.savedAt || raw.postedAt),
    imageProjection: images,
  };
  base.catalogId = visualId(base.canonicalSourceKey, base.canonicalMediaKey);
  base.fingerprint = sha256Canonical({
    sourceType: base.sourceType,
    sourceRecordId: base.sourceRecordId,
    sourceName: base.sourceName,
    sourceUrl: base.sourceUrl,
    title: base.title,
    description: base.description,
    creatorName: base.creatorName,
    creatorHandle: base.creatorHandle,
    creatorAvatarUrl: base.creatorAvatarUrl,
    images: base.imageProjection,
    lists: base.lists,
    savedAt: base.savedAt,
  });
  return { base };
}

function selectWebClipSource(raw) {
  const canonicalCandidate = typeof raw.canonicalUrl === "string"
    ? canonicalizeAbsoluteUrl(identityString(raw.canonicalUrl, "web-clip.canonicalUrl", 4096))
    : { ok: false };
  if (canonicalCandidate.ok) return canonicalCandidate;
  return canonicalizeAbsoluteUrl(identityString(raw.sourceUrl, "web-clip.sourceUrl", 4096));
}

function createWebClipBase(rawClip) {
  const raw = asObject(rawClip, "web clip");
  const selectedSource = selectWebClipSource(raw);
  if (!selectedSource.ok) return { skipped: "invalid_source_url" };
  if (!raw.media || typeof raw.media !== "object" || Array.isArray(raw.media)) {
    return { skipped: "missing_primary_visual" };
  }
  const media = cleanMedia(raw.media, "web-clip.media");
  if (!media.url) return { skipped: "missing_primary_visual" };
  const canonicalMedia = canonicalizeMediaUrl(media.url);
  if (!canonicalMedia.ok) return { skipped: "invalid_primary_media_url" };

  const avatar = raw.avatar && typeof raw.avatar === "object" && !Array.isArray(raw.avatar) ? raw.avatar : {};
  media.url = canonicalMedia.display;
  const sourceRecordId = identityString(raw.id, "web-clip.id", 512);
  const nativeMediaId = normalizedNativeMediaId(raw.media.mediaId || raw.media.id, "web-clip.mediaId");
  const lists = normalizedLists({
    collections: raw.collections || raw.collection || "Web Clips",
    categories: raw.categories || raw.category,
    styles: raw.styles || raw.style,
    colors: raw.colors || raw.color,
    interactions: raw.interactions || raw.interaction,
    visible: raw.visible,
    tags: raw.tags,
  }, "web-clip");
  const base = {
    sourceType: "web-clip",
    sourceRecordId,
    hasNativeSourceId: Boolean(sourceRecordId),
    nativeMediaId,
    mediaId: nativeMediaId || derivedMediaId(canonicalMedia.key),
    sourceName: optionalString(raw.sourcePlatform || raw.siteName || raw.host, "web-clip.sourceName", 512),
    sourceUrl: selectedSource.display,
    canonicalSourceKey: selectedSource.key,
    canonicalMediaKey: canonicalMedia.key,
    title: optionalString(raw.title, "web-clip.title"),
    description: optionalString(raw.description, "web-clip.description"),
    creatorName: optionalString(raw.creator, "web-clip.creatorName", 512),
    creatorHandle: optionalString(raw.creatorHandle, "web-clip.creatorHandle", 512),
    creatorAvatarUrl: optionalString(avatar.url, "web-clip.creatorAvatarUrl", 4096),
    media,
    mediaCount: 1,
    lists,
    savedAt: validTimestamp(raw.capturedAt || raw.savedAt || raw.updatedAt),
    imageProjection: [media],
  };
  base.catalogId = visualId(base.canonicalSourceKey, base.canonicalMediaKey);
  base.fingerprint = sha256Canonical({
    sourceType: base.sourceType,
    sourceRecordId: base.sourceRecordId,
    sourceName: base.sourceName,
    sourceUrl: base.sourceUrl,
    title: base.title,
    description: base.description,
    creatorName: base.creatorName,
    creatorHandle: base.creatorHandle,
    creatorAvatarUrl: base.creatorAvatarUrl,
    media: base.media,
    lists: base.lists,
    savedAt: base.savedAt,
  });
  return { base };
}

function baseComparator(left, right) {
  return Number(!left.hasNativeSourceId) - Number(!right.hasNativeSourceId) ||
    compareStrings(left.sourceType, right.sourceType) ||
    compareStrings(left.sourceRecordId, right.sourceRecordId) ||
    compareStrings(left.canonicalSourceKey, right.canonicalSourceKey) ||
    compareStrings(left.canonicalMediaKey, right.canonicalMediaKey) ||
    compareStrings(left.fingerprint, right.fingerprint);
}

function scalarWinner(levels) {
  for (const level of levels) {
    const choices = level
      .filter((entry) => entry.value)
      .map((entry) => ({ ...entry, key: entry.value.toLowerCase() }))
      .sort((left, right) => compareStrings(left.key, right.key) || compareStrings(left.value, right.value));
    if (choices.length > 0) return choices[0];
  }
  return { value: "", origin: "" };
}

function listWinner(levels) {
  const selected = new Map();
  const origins = [];
  for (const level of levels) {
    const levelValues = new Map();
    for (const entry of level) {
      for (const display of entry.values) {
        const key = display.toLowerCase();
        const previous = levelValues.get(key);
        if (!previous || compareStrings(display, previous.display) < 0) {
          levelValues.set(key, { display, origin: entry.origin });
        }
      }
    }
    for (const [key, winner] of [...levelValues.entries()].sort(([left], [right]) => compareStrings(left, right))) {
      if (selected.has(key)) continue;
      selected.set(key, winner.display);
      if (winner.origin && !origins.includes(winner.origin)) origins.push(winner.origin);
    }
  }
  return {
    values: [...selected.entries()].sort(([left], [right]) => compareStrings(left, right)).map(([, value]) => value),
    origins,
  };
}

function addProvenance(provenance, field, origins) {
  const values = Array.isArray(origins) ? origins : [origins];
  const clean = values.filter(Boolean);
  if (clean.length > 0) provenance[field] = [...new Set(clean)];
}

function aliasRowsForBase(base) {
  const card = base.primaryCard;
  const mediaIdAliases = [base.mediaId];
  if (card?.mediaId) mediaIdAliases.push(card.mediaId);
  const legacy = [];
  if (base.sourceRecordId) {
    legacy.push({ kind: "canonical", key: `${base.sourceRecordId}:${base.media.url}` });
    if (card?.mediaUrl && card.mediaUrl !== base.media.url) {
      legacy.push({ kind: "card", key: `${base.sourceRecordId}:${card.mediaUrl}` });
    }
  }
  legacy.push({ kind: "url", key: base.media.url });

  return {
    sourceType: base.sourceType,
    sourceRecordId: base.sourceRecordId,
    sourceUrl: base.sourceUrl,
    mediaId: base.mediaId,
    mediaIdAliases: [...new Set(mediaIdAliases)].sort(compareStrings),
    mediaUrl: base.media.url,
    legacyNoteKeyAliases: uniqueLegacyAliases(legacy),
    catalogId: base.catalogId,
    _canonicalSourceKey: base.canonicalSourceKey,
    _canonicalMediaKey: base.canonicalMediaKey,
  };
}

function uniqueLegacyAliases(aliases) {
  const seen = new Set();
  return aliases
    .map((alias) => ({
      ...alias,
      key: identityString(alias.key, "legacy note alias", MAX_LEGACY_ALIAS_LENGTH),
    }))
    .filter((alias) => alias.key && LEGACY_KIND_RANK.has(alias.kind))
    .filter((alias) => {
      const identity = `${alias.kind}\u0000${alias.key}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    })
    .sort((left, right) =>
      LEGACY_KIND_RANK.get(left.kind) - LEGACY_KIND_RANK.get(right.kind) || compareStrings(left.key, right.key)
    );
}

function mergeAliasRows(rows) {
  const merged = new Map();
  for (const row of rows) {
    const key = [row.sourceType, row.sourceRecordId, row.sourceUrl, row.mediaId, row.mediaUrl, row.catalogId].join("\u0000");
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, { ...row });
      continue;
    }
    previous.mediaIdAliases = [...new Set([...previous.mediaIdAliases, ...row.mediaIdAliases])].sort(compareStrings);
    previous.legacyNoteKeyAliases = uniqueLegacyAliases([
      ...previous.legacyNoteKeyAliases,
      ...row.legacyNoteKeyAliases,
    ]);
  }
  return [...merged.values()].sort((left, right) =>
    compareStrings(left.sourceType, right.sourceType) ||
    compareStrings(left.sourceRecordId, right.sourceRecordId) ||
    compareStrings(left._canonicalSourceKey, right._canonicalSourceKey) ||
    compareStrings(left.mediaId, right.mediaId) ||
    compareStrings(left._canonicalMediaKey, right._canonicalMediaKey) ||
    compareStrings(left.catalogId, right.catalogId)
  );
}

function noteEntries(notesPayload) {
  if (notesPayload === MISSING || notesPayload === undefined) return [];
  const payload = asObject(notesPayload, "manual notes");
  const noteEntryShape = (value) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0 &&
    Object.keys(value).every((key) => MANUAL_NOTE_FIELDS.has(key));
  const envelopeCandidate = Object.prototype.hasOwnProperty.call(payload, "notes") &&
    !noteEntryShape(payload.notes) &&
    (Array.isArray(payload.notes) || (payload.notes && typeof payload.notes === "object" && !Array.isArray(payload.notes)));
  if (envelopeCandidate && Object.keys(payload).some((key) => !MANUAL_NOTES_ROOT_FIELDS.has(key))) {
    throw new CatalogValidationError("manual notes envelope is invalid.");
  }
  const notes = envelopeCandidate ? payload.notes : payload;
  if (Array.isArray(notes)) {
    return notes.map((entry, index) => ({
      mapKey: undefined,
      index,
      raw: asObject(entry, `manual note entry ${index}`),
    }));
  }
  if (!notes || typeof notes !== "object" || Array.isArray(notes)) {
    throw new CatalogValidationError("manual notes.notes must be an object or array.");
  }
  return Object.entries(notes).map(([mapKey, entry], index) => ({
    mapKey,
    index,
    raw: asObject(entry, `manual note entry ${index}`),
  }));
}

function buildNoteLookup(aliasRows) {
  const lookup = new Map();
  const add = (selector, catalogId, kind) => {
    if (!selector) return;
    const matches = lookup.get(selector) || [];
    matches.push({ catalogId, kind });
    lookup.set(selector, matches);
  };
  for (const row of aliasRows) {
    add(row.mediaId, row.catalogId, "canonical");
    for (const alias of row.mediaIdAliases) add(alias, row.catalogId, alias === row.mediaId ? "canonical" : "card");
    for (const alias of row.legacyNoteKeyAliases) add(alias.key, row.catalogId, alias.kind);
  }
  return lookup;
}

function resolveNotes(notesPayload, aliasRows, validCatalogIds, diagnostics) {
  const lookup = buildNoteLookup(aliasRows);
  const resolved = new Map();
  for (const { mapKey, raw } of noteEntries(notesPayload)) {
    const text = optionalString(raw.note ?? raw.text, "manual-note.text", 2400);
    if (!text) continue;
    const selectors = [];
    if (mapKey !== undefined) {
      selectors.push(identityString(mapKey, "manual-note.selector", MAX_LEGACY_ALIAS_LENGTH));
    }
    selectors.push(identityString(raw.mediaId, "manual-note.mediaId", 1024));
    const tweetId = identityString(raw.tweetId || raw.sourceRecordId, "manual-note.sourceRecordId", 512);
    const mediaUrl = identityString(raw.mediaUrl, "manual-note.mediaUrl", 4096);
    if (tweetId && mediaUrl) selectors.push(`${tweetId}:${mediaUrl}`);
    if (mediaUrl) selectors.push(mediaUrl);

    const recordId = identityString(raw.recordId, "manual-note.recordId", 1024);
    const candidates = recordId && validCatalogIds.has(recordId)
      ? [{ catalogId: recordId, kind: "canonical" }]
      : selectors.flatMap((selector) => lookup.get(selector) || []);
    const ids = [...new Set(candidates.map((candidate) => candidate.catalogId))];
    if (ids.length !== 1) {
      diagnostics.noteConflicts.push({ reason: ids.length === 0 ? "unresolved" : "ambiguous" });
      continue;
    }
    const catalogId = ids[0];
    const kind = candidates
      .filter((candidate) => candidate.catalogId === catalogId)
      .sort((left, right) => LEGACY_KIND_RANK.get(left.kind) - LEGACY_KIND_RANK.get(right.kind))[0]?.kind || "url";
    const note = {
      kind: "manual",
      text,
      updatedAt: validTimestamp(raw.updatedAt),
      _aliasKind: kind,
      _fingerprint: sha256Canonical({
        recordId,
        mediaId: identityString(raw.mediaId, "manual-note.mediaId", 1024),
        sourceRecordId: tweetId,
        mediaUrl,
        text,
        updatedAt: validTimestamp(raw.updatedAt),
      }),
    };
    const values = resolved.get(catalogId) || [];
    values.push(note);
    resolved.set(catalogId, values);
  }

  for (const [catalogId, values] of resolved) {
    values.sort((left, right) => {
      const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : Number.NEGATIVE_INFINITY;
      const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : Number.NEGATIVE_INFINITY;
      return rightTime - leftTime ||
        LEGACY_KIND_RANK.get(left._aliasKind) - LEGACY_KIND_RANK.get(right._aliasKind) ||
        compareStrings(left._fingerprint, right._fingerprint);
    });
    if (values.length > 1) diagnostics.noteConflicts.push({ reason: "superseded" });
    resolved.set(catalogId, values.slice(0, 1).map(({ kind, text, updatedAt }) => ({ kind, text, updatedAt })));
  }
  return resolved;
}

function safeSearchTextPrefix(value, maxLength) {
  if (value.length <= maxLength) return value;
  let end = Math.max(0, maxLength);
  if (
    end > 0 &&
    end < value.length &&
    value.charCodeAt(end - 1) >= 0xd800 &&
    value.charCodeAt(end - 1) <= 0xdbff &&
    value.charCodeAt(end) >= 0xdc00 &&
    value.charCodeAt(end) <= 0xdfff
  ) {
    end--;
  }
  return value.slice(0, end);
}

function buildSearchText(item) {
  const values = [
    item.title,
    item.description,
    item.creatorName,
    item.creatorHandle,
    item.sourceName,
    item.sourceUrl,
    item.media.url,
    ...LIST_FIELDS.flatMap((field) => item[field]),
    ...item.notes.map((note) => note.text),
  ];
  let searchText = "";
  let truncated = false;
  for (const rawValue of values) {
    if (!rawValue || hasUnsafeTerminalControl(rawValue)) continue;
    const value = cleanString(rawValue).toLowerCase();
    if (!value) continue;
    const separator = searchText ? " " : "";
    const available = MAX_SEARCH_TEXT_LENGTH - searchText.length - separator.length;
    if (available <= 0) {
      truncated = true;
      break;
    }
    const prefix = safeSearchTextPrefix(value, available);
    if (prefix) searchText += separator + prefix;
    if (prefix.length !== value.length) {
      truncated = true;
      break;
    }
  }
  return { searchText, truncated };
}

function mergeGroup(group) {
  const sorted = [...group].sort(baseComparator);
  const owner = sorted[0];
  const remaining = sorted.slice(1);
  const card = owner.primaryCard;
  const provenance = {};
  const ownerOrigin = owner.sourceType;
  const cardOrigin = "metadata-card";

  const scalar = (field, levels) => {
    const winner = scalarWinner(levels);
    addProvenance(provenance, field, winner.origin);
    return winner.value;
  };
  const list = (field, levels) => {
    const winner = listWinner(levels);
    addProvenance(provenance, field, winner.origins);
    return winner.values;
  };
  const baseEntries = (field, bases = sorted) => bases.map((base) => ({ values: base.lists[field], origin: base.sourceType }));

  const item = {
    id: owner.catalogId,
    sourceType: owner.sourceType,
    sourceRecordId: owner.sourceRecordId,
    mediaId: owner.mediaId,
    sourceName: scalar("sourceName", [
      [{ value: owner.sourceName, origin: ownerOrigin }],
      [{ value: card?.sourceName || "", origin: cardOrigin }],
    ]),
    sourceUrl: scalar("sourceUrl", [
      [{ value: owner.sourceUrl, origin: ownerOrigin }],
      remaining.map((base) => ({ value: base.sourceUrl, origin: base.sourceType })),
    ]),
    title: scalar("title", [
      [{ value: card?.title || "", origin: cardOrigin }],
      [{ value: owner.title, origin: ownerOrigin }],
    ]),
    description: scalar("description", [
      [{ value: card?.description || "", origin: cardOrigin }],
      [{ value: owner.description, origin: ownerOrigin }],
    ]),
    creatorName: scalar("creatorName", [
      [{ value: owner.creatorName, origin: ownerOrigin }],
      [{ value: card?.creatorName || "", origin: cardOrigin }],
    ]),
    creatorHandle: scalar("creatorHandle", [
      [{ value: owner.creatorHandle, origin: ownerOrigin }],
      [{ value: card?.creatorHandle || "", origin: cardOrigin }],
    ]),
    creatorAvatarUrl: scalar("creatorAvatarUrl", [
      [{ value: owner.creatorAvatarUrl, origin: ownerOrigin }],
      [{ value: card?.creatorAvatarUrl || "", origin: cardOrigin }],
    ]),
    media: owner.media,
    collections: list("collections", [baseEntries("collections")]),
    categories: list("categories", [
      card ? [{ values: card.lists.categories, origin: cardOrigin }] : [],
      baseEntries("categories", [owner]),
      baseEntries("categories", remaining),
    ]),
    styles: list("styles", [
      card ? [{ values: card.lists.styles, origin: cardOrigin }] : [],
      baseEntries("styles", [owner]),
      baseEntries("styles", remaining),
    ]),
    colors: list("colors", [
      card ? [{ values: card.lists.colors, origin: cardOrigin }] : [],
      baseEntries("colors", [owner]),
      baseEntries("colors", remaining),
    ]),
    interactions: list("interactions", [
      card ? [{ values: card.lists.interactions, origin: cardOrigin }] : [],
      baseEntries("interactions", [owner]),
      baseEntries("interactions", remaining),
    ]),
    visible: list("visible", [
      card ? [{ values: card.lists.visible, origin: cardOrigin }] : [],
      baseEntries("visible", [owner]),
      baseEntries("visible", remaining),
    ]),
    tags: list("tags", [
      baseEntries("tags", [owner]),
      baseEntries("tags", remaining),
      card ? [{ values: card.lists.tags, origin: cardOrigin }] : [],
    ]),
    notes: [],
    savedAt: owner.savedAt,
    searchText: "",
    provenance,
  };
  addProvenance(provenance, "sourceType", ownerOrigin);
  addProvenance(provenance, "sourceRecordId", ownerOrigin);
  addProvenance(provenance, "mediaId", ownerOrigin);
  addProvenance(provenance, "media", ownerOrigin);
  addProvenance(provenance, "savedAt", ownerOrigin);
  return item;
}

function parseBookmarksPayload(payload) {
  if (Array.isArray(payload)) return payload;
  return asObject(payload, "bookmarks payload").bookmarks;
}

function parseCardsPayload(payload) {
  if (Array.isArray(payload)) return payload;
  return asObject(payload, "metadata cards payload").cards;
}

function parseClipsPayload(payload) {
  if (payload === MISSING || payload === undefined) return [];
  if (Array.isArray(payload)) return payload;
  return asObject(payload, "web clips payload").clips;
}

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new CatalogValidationError(`${field} must be an array.`);
  return value;
}

function buildCatalog({
  bookmarksPayload,
  cardsPayload,
  webClipsPayload = MISSING,
  notesPayload = MISSING,
  generatedAt,
} = {}) {
  const bookmarks = requireArray(parseBookmarksPayload(bookmarksPayload), "bookmarks");
  const cards = requireArray(parseCardsPayload(cardsPayload), "metadata cards");
  const clips = requireArray(parseClipsPayload(webClipsPayload), "web clips");
  const manualNotes = noteEntries(notesPayload);
  const diagnostics = {
    input: {
      bookmarks: bookmarks.length,
      metadataCards: cards.length,
      webClips: clips.length,
      manualNotes: manualNotes.length,
    },
    skipped: [],
    joinedMetadataCards: 0,
    unusedMetadataCards: 0,
    duplicateCandidates: 0,
    noteConflicts: [],
    searchTextTruncations: { count: 0, reasons: [] },
  };

  const cardsBySourceId = new Map();
  const validCards = [];
  for (const rawCard of cards) {
    try {
      const card = normalizeCard(rawCard);
      validCards.push(card);
      if (!card.sourceRecordId) {
        diagnostics.unusedMetadataCards++;
        continue;
      }
      const values = cardsBySourceId.get(card.sourceRecordId) || [];
      values.push(card);
      cardsBySourceId.set(card.sourceRecordId, values);
    } catch {
      diagnostics.skipped.push({ sourceType: "metadata-card", sourceRecordId: "", reason: "invalid_metadata_card" });
    }
  }

  const bases = [];
  const selectedCards = new Set();
  const addBase = (raw, sourceType, factory) => {
    let sourceRecordId = "";
    try {
      sourceRecordId = raw && typeof raw === "object" && typeof raw.id === "string" ? raw.id.slice(0, 512) : "";
      const result = factory(raw);
      if (result.skipped) {
        diagnostics.skipped.push({ sourceType, sourceRecordId, reason: result.skipped });
        return;
      }
      const base = result.base;
      const joined = base.sourceRecordId ? (cardsBySourceId.get(base.sourceRecordId) || []) : [];
      base.primaryCard = selectPrimaryCard(base, joined);
      if (base.primaryCard) {
        diagnostics.joinedMetadataCards++;
        selectedCards.add(base.primaryCard);
      }
      bases.push(base);
    } catch {
      diagnostics.skipped.push({ sourceType, sourceRecordId, reason: "invalid_source_record" });
    }
  };
  for (const bookmark of bookmarks) addBase(bookmark, "bookmark", createBookmarkBase);
  for (const clip of clips) addBase(clip, "web-clip", createWebClipBase);
  diagnostics.unusedMetadataCards = validCards.length - selectedCards.size;

  const groups = new Map();
  for (const base of bases) {
    const values = groups.get(base.catalogId) || [];
    values.push(base);
    groups.set(base.catalogId, values);
  }
  const items = [...groups.values()].map((group) => {
    diagnostics.duplicateCandidates += Math.max(0, group.length - 1);
    return mergeGroup(group);
  });
  items.sort((left, right) => compareStrings(left.id, right.id));

  const aliasRows = mergeAliasRows(bases.map(aliasRowsForBase));
  const validCatalogIds = new Set(items.map((item) => item.id));
  const notesById = resolveNotes(notesPayload, aliasRows, validCatalogIds, diagnostics);
  for (const item of items) {
    item.notes = notesById.get(item.id) || [];
    if (item.notes.length > 0) addProvenance(item.provenance, "notes", "manual-note");
    const derivedSearch = buildSearchText(item);
    item.searchText = derivedSearch.searchText;
    if (derivedSearch.truncated) {
      diagnostics.searchTextTruncations.count++;
      if (diagnostics.searchTextTruncations.reasons.length === 0) {
        diagnostics.searchTextTruncations.reasons.push("max_search_text_length_exceeded");
      }
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: generatedAt || new Date().toISOString(),
    items,
    resolverAliases: aliasRows.map(({ _canonicalSourceKey, _canonicalMediaKey, ...row }) => row),
    diagnostics,
  };
}

function readJson(filePath, role, code, readFileSync) {
  let contents;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return MISSING;
    throw new CatalogValidationError(`${role} could not be read.`, `catalog_${code}_read_failed`);
  }
  try {
    return JSON.parse(contents);
  } catch {
    throw new CatalogValidationError(`${role} contains invalid JSON.`, `catalog_${code}_invalid_json`);
  }
}

function readRequiredFallback(primaryPath, fallbackPath, role, code, readFileSync) {
  const primary = readJson(primaryPath, role, code, readFileSync);
  if (primary !== MISSING) return { payload: primary, source: "local" };
  const fallback = readJson(fallbackPath, `${role} sample fallback`, `${code}_sample`, readFileSync);
  if (fallback === MISSING) {
    throw new CatalogValidationError(`${role} and its sample fallback are missing.`, `catalog_${code}_missing`);
  }
  return { payload: fallback, source: "sample" };
}

function loadBootstrapCatalog(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, "..", ".."));
  const readFileSync = options.readFileSync || fs.readFileSync;
  const bookmarks = readRequiredFallback(
    path.resolve(options.bookmarksPath || process.env.BOOKMARKS_PATH || path.join(rootDir, "bookmarks-data.json")),
    path.resolve(options.bookmarksSamplePath || path.join(rootDir, "bookmarks-data.sample.json")),
    "Bookmark data",
    "bookmarks",
    readFileSync
  );
  const cards = readRequiredFallback(
    path.resolve(options.cardsPath || process.env.MEDIA_CARDS_PATH || path.join(rootDir, "media-cards-clean.json")),
    path.resolve(options.cardsSamplePath || path.join(rootDir, "media-cards.sample.json")),
    "Metadata cards",
    "metadata_cards",
    readFileSync
  );
  const webClipsPath = path.resolve(options.webClipsPath || process.env.WEB_CLIPS_PATH || path.join(rootDir, "web-clips.json"));
  const notesPath = path.resolve(options.notesPath || process.env.MANUAL_NOTES_PATH || path.join(rootDir, "manual-media-notes.json"));
  const webClipsPayload = readJson(webClipsPath, "Web clips", "web_clips", readFileSync);
  const notesPayload = readJson(notesPath, "Manual notes", "manual_notes", readFileSync);
  const catalog = buildCatalog({
    bookmarksPayload: bookmarks.payload,
    cardsPayload: cards.payload,
    webClipsPayload,
    notesPayload,
    generatedAt: options.generatedAt,
  });
  catalog.diagnostics.sources = {
    bookmarks: bookmarks.source,
    metadataCards: cards.source,
    webClips: webClipsPayload === MISSING ? "absent" : "local",
    manualNotes: notesPayload === MISSING ? "absent" : "local",
  };
  return catalog;
}

module.exports = {
  CatalogValidationError,
  LIST_FIELDS,
  MAX_SEARCH_TEXT_LENGTH,
  buildSearchText,
  buildCatalog,
  derivedMediaId,
  loadBootstrapCatalog,
  validTimestamp,
  visualId,
};

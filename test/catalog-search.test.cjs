const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  canonicalJson,
  canonicalizeAbsoluteUrl,
  canonicalizeLocalAssetUrl,
  cleanString,
  normalizeList,
} = require("../lib/catalog/canonical");
const {
  CatalogValidationError,
  MAX_SEARCH_TEXT_LENGTH,
  buildCatalog,
  loadBootstrapCatalog,
} = require("../lib/catalog/bootstrap");
const {
  MAX_MATCH_REASONS,
  MAX_QUERY_TERMS,
  SearchValidationError,
  searchCatalog,
} = require("../lib/search");

const ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.join(__dirname, "fixtures", "search");
const REVIEW_TEST_PATH = path.join(os.tmpdir(), `catalog-search-review-${process.pid}.json`);
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(FIXTURES, file), "utf8"));

function fixtureCatalog() {
  return loadBootstrapCatalog({
    rootDir: ROOT,
    bookmarksPath: path.join(FIXTURES, "bookmarks.json"),
    cardsPath: path.join(FIXTURES, "cards.fixture.json"),
    webClipsPath: path.join(FIXTURES, "clips.fixture.json"),
    notesPath: path.join(FIXTURES, "manual-notes.json"),
    generatedAt: "2026-02-04T10:00:00.000Z",
  });
}

function cliEnvironment(overrides = {}) {
  return {
    ...process.env,
    BOOKMARKS_PATH: path.join(FIXTURES, "bookmarks.json"),
    MEDIA_CARDS_PATH: path.join(FIXTURES, "cards.fixture.json"),
    WEB_CLIPS_PATH: path.join(FIXTURES, "clips.fixture.json"),
    MANUAL_NOTES_PATH: path.join(FIXTURES, "manual-notes.json"),
    INSPIRATION_INDEX_PATH: path.join(FIXTURES, "absent-inspiration-index.json"),
    METADATA_REVIEW_PATH: REVIEW_TEST_PATH,
    METADATA_REVIEW_LOCK_PATH: REVIEW_TEST_PATH.replace(/\.json$/, ".lock"),
    ...overrides,
  };
}

function makeSearchItem(index, overrides = {}) {
  return {
    id: `visual:v1:${String(index).padStart(4, "0")}`,
    sourceType: "bookmark",
    sourceRecordId: `record-${index}`,
    mediaId: `media-${index}`,
    sourceName: "Example",
    sourceUrl: `https://example.com/${index}`,
    title: "Bounded search fixture",
    description: "",
    creatorName: "",
    creatorHandle: "",
    creatorAvatarUrl: "",
    media: { type: "photo", url: `assets/example-${index}.webp`, width: 10, height: 10 },
    collections: [],
    categories: [],
    styles: [],
    colors: [],
    interactions: [],
    visible: [],
    tags: [],
    notes: [],
    savedAt: null,
    searchText: "",
    provenance: {},
    ...overrides,
  };
}

function assertNoUnsafeTerminalControls(output, label) {
  assert.equal(
    /[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f]/.test(output),
    false,
    `${label} contains an unsafe terminal control`
  );
}

test("canonical JSON is recursive, strict, and independent of object key order", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: -0, x: true } }), '{"a":{"x":true,"y":0},"z":1}');
  assert.equal(canonicalJson(["x", null, 1.5]), '["x",null,1.5]');
  assert.throws(() => canonicalJson({ value: undefined }), /JSON domain/);
  assert.throws(() => canonicalJson([1, , 2]), /sparse/);
  assert.throws(() => canonicalJson(Number.NaN), /finite/);
});

test("human text normalization collapses ordinary whitespace and rejects terminal controls", () => {
  assert.equal(cleanString(" \tAlpha\n beta\f "), "Alpha beta");
  assert.deepEqual(normalizeList([" Alpha\n beta ", "Reference"]), ["Alpha beta", "Reference"]);
  assert.throws(() => cleanString("Unsafe\u001b]0;title\u0007"), /unsafe control characters/);
  assert.throws(() => cleanString("Unsafe\u009b31m"), /unsafe control characters/);
  assert.throws(() => normalizeList(["Safe", "Unsafe\u0085list"]), /unsafe control characters/);
});

test("absolute URL keys preserve meaningful URL distinctions and reject unsafe sources", () => {
  assert.deepEqual(
    canonicalizeAbsoluteUrl("  HTTPS://Example.COM:443/a/../B?b=2&a=1#preview  "),
    { ok: true, display: "HTTPS://Example.COM:443/a/../B?b=2&a=1#preview", key: "web:https://example.com/B?b=2&a=1" }
  );
  assert.equal(canonicalizeAbsoluteUrl("https://user@example.com/private").ok, false);
  assert.equal(canonicalizeAbsoluteUrl("ftp://example.com/file").ok, false);
  assert.equal(canonicalizeAbsoluteUrl("https://example.com/a\u0000b").ok, false);
});

test("local asset URL keys normalize safe spellings and reject traversal at every decode layer", () => {
  for (const value of [
    "/assets/clips/web-example/image.webp",
    "assets/clips/web-example/image.webp",
    "./assets/clips/web-example/image.webp#preview",
    "assets/clips/web-example/%69mage.webp",
  ]) {
    assert.equal(
      canonicalizeLocalAssetUrl(value).key,
      "local:assets/clips/web-example/image.webp",
      value
    );
  }

  const unsafe = [
    "//assets.example/image.webp",
    "/other/image.webp",
    "/assets/../image.webp",
    "/assets/%2e%2e/image.webp",
    "/assets/%252e%252e/image.webp",
    "/assets/%25252e%25252e/image.webp",
    "/assets/clips%2fprivate/image.webp",
    "/assets/clips%252fprivate/image.webp",
    "/assets/clips%255cprivate/image.webp",
    "/assets/clips\\private/image.webp",
    "/assets/%00private/image.webp",
    "/assets/%ZZ/image.webp",
    "/assets/%252525252e%252525252e/image.webp",
  ];
  for (const value of unsafe) assert.equal(canonicalizeLocalAssetUrl(value).ok, false, value);
  assert.equal(
    canonicalizeLocalAssetUrl("/assets/%252525252e%252525252e/image.webp").error,
    "decode_depth_exceeded"
  );
});

test("sample-only bootstrap produces one stable visual record per visible sample", () => {
  const catalog = loadBootstrapCatalog({ rootDir: ROOT, generatedAt: "2026-02-04T10:00:00.000Z" });
  assert.equal(catalog.items.length, 8);
  assert.equal(catalog.diagnostics.sources.bookmarks, "sample");
  assert.equal(catalog.diagnostics.sources.metadataCards, "sample");
  assert.ok(catalog.items.every((item) => item.id.startsWith("visual:v1:")));
  assert.ok(catalog.items.every((item) => item.media.url && item.sourceUrl));
  assert.ok(catalog.items.every((item) => !("resolverAliases" in item)));
});

test("derived search text is bounded for maximum scalars without changing structured search", () => {
  const maxScalar = "M".repeat(MAX_SEARCH_TEXT_LENGTH);
  const catalog = buildCatalog({
    bookmarksPayload: {
      bookmarks: [{
        id: "bounded-scalar",
        text: maxScalar,
        url: "https://example.com/bounded-scalar",
        images: [{ id: "bounded-scalar-media", url: "assets/sample-interface.svg", type: "photo" }],
      }],
    },
    cardsPayload: { cards: [] },
    generatedAt: "fixed",
  });

  assert.equal(catalog.items.length, 1);
  assert.equal(catalog.items[0].title.length, MAX_SEARCH_TEXT_LENGTH);
  assert.equal(catalog.items[0].description.length, MAX_SEARCH_TEXT_LENGTH);
  assert.equal(catalog.items[0].searchText.length, MAX_SEARCH_TEXT_LENGTH);
  assert.equal(catalog.items[0].searchText, maxScalar.toLowerCase());
  assert.deepEqual(catalog.diagnostics.searchTextTruncations, {
    count: 1,
    reasons: ["max_search_text_length_exceeded"],
  });
  assert.equal(searchCatalog(catalog, { query: "mmmm" }).total, 1);
});

test("large duplicate-list merges truncate deterministically without splitting surrogate pairs", () => {
  const list = (prefix) => Array.from(
    { length: 500 },
    (_, index) => `${prefix}-${String(index).padStart(3, "0")}-${"x".repeat(32)}`
  );
  const firstTags = list("alpha");
  const secondTags = list("omega");
  secondTags[499] = `zz-tailmarker-${"z".repeat(32)}`;
  const bookmarks = [
    {
      id: "duplicate-a",
      title: `${"A".repeat(MAX_SEARCH_TEXT_LENGTH - 2)}`,
      description: "😀 structured tail",
      url: "https://example.com/merged-duplicate",
      tags: firstTags,
      images: [{ id: "duplicate-a-media", url: "assets/sample-interface.svg", type: "photo" }],
    },
    {
      id: "duplicate-b",
      text: "Duplicate list source",
      url: "https://example.com/merged-duplicate",
      tags: secondTags,
      images: [{ id: "duplicate-b-media", url: "assets/sample-interface.svg", type: "photo" }],
    },
  ];
  const build = (values) => buildCatalog({
    bookmarksPayload: { bookmarks: values },
    cardsPayload: { cards: [] },
    generatedAt: "fixed",
  });
  const original = build(bookmarks);
  const permuted = build([...bookmarks].reverse().map((bookmark) => ({
    ...bookmark,
    tags: [...bookmark.tags].reverse(),
  })));

  assert.equal(original.items.length, 1);
  assert.equal(original.items[0].tags.length, 1000);
  assert.equal(original.items[0].searchText.length, MAX_SEARCH_TEXT_LENGTH - 2);
  assert.ok(!/[\uD800-\uDBFF]$/.test(original.items[0].searchText));
  assert.deepEqual(permuted.items, original.items);
  assert.deepEqual(permuted.diagnostics.searchTextTruncations, original.diagnostics.searchTextTruncations);
  assert.ok(!original.items[0].searchText.includes("tailmarker"));
  assert.equal(searchCatalog(original, { query: "tailmarker" }).total, 1);
  assert.equal(searchCatalog(original, { query: "structured tail" }).total, 1);
});

test("timestamp conflict resolution is identical across process timezones", () => {
  const script = String.raw`
    const fs = require("node:fs");
    const path = require("node:path");
    const { buildCatalog } = require("./lib/catalog/bootstrap");
    const fixtures = path.join(process.cwd(), "test", "fixtures", "search");
    const read = (name) => JSON.parse(fs.readFileSync(path.join(fixtures, name), "utf8"));
    const bookmarks = read("bookmarks.json");
    bookmarks.bookmarks[0].bookmarkedAt = "2026-02-01T12:00:00+02:00";
    bookmarks.bookmarks[1].bookmarkedAt = "2026-02-03T10:00:00";
    const catalog = buildCatalog({
      bookmarksPayload: bookmarks,
      cardsPayload: read("cards.fixture.json"),
      notesPayload: read("manual-notes-timezone.json"),
      generatedAt: "fixed",
    });
    const pricing = catalog.items.find((item) => item.sourceRecordId === "fixture-pricing-001");
    const notes = catalog.items.find((item) => item.sourceRecordId === "fixture-notes-002");
    process.stdout.write(JSON.stringify({
      explicitSavedAt: pricing.savedAt,
      timezoneLessSavedAt: notes.savedAt,
      winningNote: notes.notes[0],
    }));
  `;
  const results = ["UTC", "America/Los_Angeles"].map((timezone) => {
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        TZ: timezone,
        METADATA_REVIEW_PATH: REVIEW_TEST_PATH,
        METADATA_REVIEW_LOCK_PATH: REVIEW_TEST_PATH.replace(/\.json$/, ".lock"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  });

  assert.deepEqual(results[1], results[0]);
  assert.equal(results[0].explicitSavedAt, "2026-02-01T12:00:00+02:00");
  assert.equal(results[0].timezoneLessSavedAt, null);
  assert.deepEqual(results[0].winningNote, {
    kind: "manual",
    text: "Offset-stable winner",
    updatedAt: "2026-02-03T15:00:00Z",
  });
});

test("timestamp validation rejects impossible calendar components before conflict ordering", () => {
  const invalidTimestamps = [
    "9999-02-30T23:59:59Z",
    "2025-02-29T12:00:00Z",
    "2026-13-01T12:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T12:60:00Z",
    "2026-01-01T12:00:60Z",
    "2026-01-01T12:00:00+24:00",
    "2026-01-01T12:00:00-12:60",
  ];
  const bookmarks = invalidTimestamps.map((bookmarkedAt, index) => ({
    id: `invalid-time-${index}`,
    text: `Invalid calendar ${index}`,
    url: `https://example.com/invalid-time-${index}`,
    bookmarkedAt,
    images: [{ id: `invalid-time-media-${index}`, url: "assets/sample-interface.svg", type: "photo" }],
  }));
  bookmarks.push({
    id: "valid-leap-time",
    text: "Valid leap calendar",
    url: "https://example.com/valid-leap-time",
    bookmarkedAt: "2024-02-29T23:59+14:00",
    images: [{ id: "valid-leap-media", url: "assets/sample-interface.svg", type: "photo" }],
  });

  const timestamps = buildCatalog({
    bookmarksPayload: { bookmarks },
    cardsPayload: { cards: [] },
    generatedAt: "fixed",
  });
  for (let index = 0; index < invalidTimestamps.length; index++) {
    assert.equal(timestamps.items.find((item) => item.sourceRecordId === `invalid-time-${index}`).savedAt, null);
  }
  assert.equal(
    timestamps.items.find((item) => item.sourceRecordId === "valid-leap-time").savedAt,
    "2024-02-29T23:59+14:00"
  );

  const conflict = buildCatalog({
    bookmarksPayload: {
      bookmarks: [{
        id: "calendar-conflict",
        text: "Calendar conflict",
        url: "https://example.com/calendar-conflict",
        images: [{ id: "calendar-conflict-media", url: "assets/sample-interface.svg", type: "photo" }],
      }],
    },
    cardsPayload: { cards: [] },
    notesPayload: {
      notes: [
        {
          mediaId: "calendar-conflict-media",
          note: "Impossible future date",
          updatedAt: "9999-02-30T23:59:59Z",
        },
        {
          mediaId: "calendar-conflict-media",
          note: "Calendar-valid winner",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    },
    generatedAt: "fixed",
  });
  assert.deepEqual(conflict.items[0].notes, [{
    kind: "manual",
    text: "Calendar-valid winner",
    updatedAt: "2026-01-01T00:00:00Z",
  }]);
  assert.deepEqual(conflict.diagnostics.noteConflicts, [{ reason: "superseded" }]);
});

test("twelve golden requests cover ranking, all facets, empty browse, and pagination", () => {
  const catalog = loadBootstrapCatalog({ rootDir: ROOT, generatedAt: "2026-02-04T10:00:00.000Z" });
  const golden = readJson("golden-requests.json");
  assert.ok(golden.length >= 10);
  for (const fixture of golden) {
    const response = searchCatalog(catalog, fixture.request);
    assert.deepEqual(response.results.map((entry) => entry.item.id), fixture.expectedIds, fixture.name);
    assert.equal(response.total, fixture.expectedTotal ?? fixture.expectedIds.length, fixture.name);
    const hasConstraint = Boolean(fixture.request.query) ||
      Object.values(fixture.request.filters || {}).some((values) => values.length > 0);
    if (hasConstraint) {
      assert.ok(
        response.results.every((entry) => entry.matchReasons.length > 0),
        `${fixture.name} should explain every result`
      );
    }
  }
});

test("primary image, primary card, alternate aliases, web clips, and notes normalize together", () => {
  const catalog = fixtureCatalog();
  assert.equal(catalog.items.length, 3);

  const pricing = catalog.items.find((item) => item.sourceRecordId === "fixture-pricing-001");
  assert.equal(pricing.media.url, "assets/sample-interface.svg");
  assert.equal(pricing.mediaId, "fixture-pricing-base-media");
  assert.equal(pricing.title, "Dark Minimal Pricing");
  assert.deepEqual(pricing.categories, ["Interface"]);
  assert.ok(!pricing.searchText.includes("secondary motion detail"));
  const pricingAlias = catalog.resolverAliases.find((row) => row.sourceRecordId === "fixture-pricing-001");
  assert.deepEqual(pricingAlias.mediaIdAliases, ["fixture-pricing-base-media", "fixture-pricing-primary-card"]);

  const clip = catalog.items.find((item) => item.sourceType === "web-clip");
  assert.equal(clip.sourceRecordId, "");
  assert.equal(clip.sourceUrl, "https://example.com/reference");
  assert.equal(clip.media.url, "/assets/clips/web-example-001/image.webp");
  assert.match(clip.mediaId, /^media-url:v1:[a-f0-9]{64}$/);

  const noteResult = searchCatalog(catalog, { query: "kinetic cadence" });
  assert.equal(noteResult.total, 1);
  assert.equal(noteResult.results[0].item.sourceRecordId, "fixture-notes-002");
  assert.ok(noteResult.results[0].matchReasons.every((reason) => !reason.value.includes("restrained campaign")));
  assert.ok(!JSON.stringify(noteResult).includes("resolverAliases"));
});

test("native aliases preserve Unicode form, repeated spaces, and selected URL display spelling", () => {
  const sources = [
    { id: "caf\u00e9", slug: "unicode-nfc", title: "NFC metadata" },
    { id: "cafe\u0301", slug: "unicode-nfd", title: "NFD metadata" },
    { id: "space id", slug: "space-single", title: "Single-space metadata" },
    { id: "space  id", slug: "space-double", title: "Double-space metadata" },
  ];
  const bookmarksPayload = {
    bookmarks: sources.map(({ id, slug }) => ({
      id,
      text: slug,
      url: `https://example.com/${slug}`,
      images: [{ url: "assets/sample-interface.svg", type: "photo", width: 10, height: 10 }],
    })),
  };
  const cardsPayload = {
    cards: sources.map(({ id, title }) => ({
      mediaId: `card-${title}`,
      mediaIndex: 0,
      title,
      media: { url: "assets/sample-interface.svg", type: "photo" },
      tweet: { id },
    })),
  };
  const catalog = buildCatalog({ bookmarksPayload, cardsPayload, generatedAt: "fixed" });
  assert.deepEqual(
    catalog.items.map((item) => [item.sourceRecordId, item.title]).sort(),
    sources.map(({ id, title }) => [id, title]).sort()
  );
  assert.deepEqual(
    new Set(catalog.resolverAliases.map((row) => row.sourceRecordId)),
    new Set(sources.map(({ id }) => id))
  );

  const sourceUrl = " \tHTTPS://Example.COM:443/a/../Reference?x=1#Shown \n";
  const mediaUrl = " \t./assets/sample-interface.svg#Preview \r";
  const displayCatalog = buildCatalog({
    bookmarksPayload: {
      bookmarks: [{
        id: "display-id",
        text: "URL display",
        url: sourceUrl,
        images: [{ id: "media  id", url: mediaUrl, type: "photo" }],
      }],
    },
    cardsPayload: { cards: [] },
    generatedAt: "fixed",
  });
  const displayItem = displayCatalog.items[0];
  const displayAlias = displayCatalog.resolverAliases[0];
  assert.equal(displayItem.sourceUrl, "HTTPS://Example.COM:443/a/../Reference?x=1#Shown");
  assert.equal(displayItem.media.url, "./assets/sample-interface.svg#Preview");
  assert.equal(displayItem.mediaId, "media  id");
  assert.equal(
    displayAlias.legacyNoteKeyAliases[0].key,
    "display-id:./assets/sample-interface.svg#Preview"
  );
});

test("card selection remains stable for canonically equivalent URL and legacy alias spellings", () => {
  const bookmarksPayload = {
    bookmarks: [{
      id: "card-order",
      text: "Card order",
      url: "https://example.com/card-order",
      images: [{ url: "assets/sample-interface.svg", type: "photo" }],
    }],
  };
  const cards = [
    {
      mediaId: "card-order-primary",
      title: "Deterministic card",
      category: ["Interface", "Reference"],
      media: { url: "assets/sample-interface.svg", type: "photo" },
      tweet: { id: "card-order" },
    },
    {
      mediaId: "card-order-primary",
      title: "Deterministic card",
      category: ["Reference", "Interface"],
      media: { url: "/assets/sample-interface.svg", type: "photo" },
      tweet: { id: "card-order" },
    },
  ];
  const original = buildCatalog({ bookmarksPayload, cardsPayload: { cards }, generatedAt: "fixed" });
  const reversed = buildCatalog({
    bookmarksPayload,
    cardsPayload: { cards: [...cards].reverse() },
    generatedAt: "fixed",
  });
  assert.deepEqual(reversed.items, original.items);
  assert.deepEqual(reversed.resolverAliases, original.resolverAliases);
  assert.ok(original.resolverAliases[0].legacyNoteKeyAliases.length >= 2);
});

test("a valid canonical recordId wins over conflicting stale note aliases", () => {
  const bookmarksPayload = {
    bookmarks: [
      {
        id: "note-owner",
        text: "Owner",
        url: "https://example.com/note-owner",
        images: [{ id: "owner-media", url: "assets/sample-interface.svg", type: "photo" }],
      },
      {
        id: "stale-target",
        text: "Stale target",
        url: "https://example.com/stale-target",
        images: [{ id: "stale-media", url: "assets/sample-motion.svg", type: "photo" }],
      },
    ],
  };
  const withoutNotes = buildCatalog({ bookmarksPayload, cardsPayload: { cards: [] }, generatedAt: "fixed" });
  const ownerId = withoutNotes.items.find((item) => item.sourceRecordId === "note-owner").id;
  const catalog = buildCatalog({
    bookmarksPayload,
    cardsPayload: { cards: [] },
    notesPayload: {
      notes: [{
        recordId: ownerId,
        mediaId: "stale-media",
        note: "Canonical destination",
      }],
    },
    generatedAt: "fixed",
  });
  assert.deepEqual(catalog.items.find((item) => item.id === ownerId).notes, [{
    kind: "manual",
    text: "Canonical destination",
    updatedAt: null,
  }]);
  assert.deepEqual(catalog.items.find((item) => item.sourceRecordId === "stale-target").notes, []);
  assert.equal(catalog.diagnostics.noteConflicts.length, 0);
});

test("manual-note array indexes never resolve an exact numeric catalog alias", () => {
  const bookmarksPayload = {
    bookmarks: [{
      id: "numeric-alias",
      text: "Numeric alias",
      url: "https://example.com/numeric-alias",
      images: [{ id: "0", url: "assets/sample-interface.svg", type: "photo" }],
    }],
  };
  const arrayNotes = buildCatalog({
    bookmarksPayload,
    cardsPayload: { cards: [] },
    notesPayload: {
      notes: [
        { note: "Position is not a selector" },
        { mediaId: "0", note: "Explicit media selector" },
      ],
    },
    generatedAt: "fixed",
  });
  assert.deepEqual(arrayNotes.items[0].notes, [{
    kind: "manual",
    text: "Explicit media selector",
    updatedAt: null,
  }]);
  assert.deepEqual(arrayNotes.diagnostics.noteConflicts, [{ reason: "unresolved" }]);
  assert.ok(!arrayNotes.diagnostics.noteConflicts.some((conflict) => conflict.reason === "ambiguous"));

  const mapNote = buildCatalog({
    bookmarksPayload,
    cardsPayload: { cards: [] },
    notesPayload: { notes: { 0: { note: "Object map selector" } } },
    generatedAt: "fixed",
  });
  assert.deepEqual(mapNote.items[0].notes, [{
    kind: "manual",
    text: "Object map selector",
    updatedAt: null,
  }]);
  assert.deepEqual(mapNote.diagnostics.noteConflicts, []);
});

test("card, source container, and unordered list permutations do not change catalog output", () => {
  const bookmarksPayload = readJson("bookmarks.json");
  const cardsPayload = readJson("cards.fixture.json");
  const clipsPayload = readJson("clips.fixture.json");
  const notesPayload = readJson("manual-notes.json");
  const original = buildCatalog({
    bookmarksPayload,
    cardsPayload,
    webClipsPayload: clipsPayload,
    notesPayload,
    generatedAt: "fixed",
  });

  const permutedBookmarks = structuredClone(bookmarksPayload);
  permutedBookmarks.bookmarks.reverse();
  for (const bookmark of permutedBookmarks.bookmarks) {
    bookmark.folders?.reverse();
    bookmark.tags?.reverse();
  }
  const permutedCards = structuredClone(cardsPayload);
  permutedCards.cards.reverse();
  for (const card of permutedCards.cards) {
    for (const field of ["style", "color", "interaction", "visible", "tags"]) card[field]?.reverse();
  }
  const permuted = buildCatalog({
    bookmarksPayload: permutedBookmarks,
    cardsPayload: permutedCards,
    webClipsPayload: clipsPayload,
    notesPayload,
    generatedAt: "fixed",
  });
  assert.deepEqual(permuted.items, original.items);
  assert.deepEqual(permuted.resolverAliases, original.resolverAliases);
});

test("web clip source selection falls back safely and missing native ids keep pair-derived identity", () => {
  const bookmarksPayload = { bookmarks: [] };
  const cardsPayload = { cards: [] };
  const baseClip = readJson("clips.fixture.json").clips[0];
  const variants = [
    { ...baseClip },
    { ...baseClip, id: undefined },
    { ...baseClip, id: "" },
  ];
  const ids = variants.map((clip) => buildCatalog({
    bookmarksPayload,
    cardsPayload,
    webClipsPayload: { clips: [clip] },
    generatedAt: "fixed",
  }).items[0].id);
  assert.equal(new Set(ids).size, 1);

  const fallback = buildCatalog({
    bookmarksPayload,
    cardsPayload,
    webClipsPayload: { clips: [{ ...baseClip, canonicalUrl: "javascript:bad" }] },
    generatedAt: "fixed",
  });
  assert.equal(fallback.items[0].sourceUrl, baseClip.sourceUrl);
  const invalid = buildCatalog({
    bookmarksPayload,
    cardsPayload,
    webClipsPayload: { clips: [{ ...baseClip, canonicalUrl: "bad", sourceUrl: "file:///tmp/private" }] },
    generatedAt: "fixed",
  });
  assert.equal(invalid.items.length, 0);
  assert.equal(invalid.diagnostics.skipped[0].reason, "invalid_source_url");
});

test("a zero-based secondary media ordinal cannot enrich image zero", () => {
  const bookmarksPayload = {
    bookmarks: [{
      id: "ordinal-fixture",
      text: "Primary visual",
      url: "https://example.com/ordinal",
      images: [
        { url: "assets/sample-interface.svg", type: "photo", width: 10, height: 10 },
        { url: "assets/sample-motion.svg", type: "photo", width: 10, height: 10 },
      ],
      folders: [],
      tags: [],
    }],
  };
  const cardsPayload = {
    cards: [{
      mediaId: "unrelated-secondary",
      mediaIndex: 1,
      title: "Secondary metadata",
      media: { type: "photo", url: "assets/sample-motion.svg", width: 10, height: 10 },
      tweet: { id: "ordinal-fixture" },
    }],
  };
  const catalog = buildCatalog({ bookmarksPayload, cardsPayload, generatedAt: "fixed" });
  assert.equal(catalog.items[0].title, "Primary visual");
  assert.ok(!catalog.resolverAliases[0].mediaIdAliases.includes("unrelated-secondary"));
});

test("catalog reads leave all fixture source files byte-for-byte unchanged", () => {
  const files = ["bookmarks.json", "cards.fixture.json", "clips.fixture.json", "manual-notes.json"];
  const before = files.map((file) => fs.readFileSync(path.join(FIXTURES, file), "utf8"));
  fixtureCatalog();
  const after = files.map((file) => fs.readFileSync(path.join(FIXTURES, file), "utf8"));
  assert.deepEqual(after, before);
});

test("missing optional files are absent while present null payloads fail validation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-null-test-"));
  const nullPath = path.join(directory, "null.json");
  const missingClipsPath = path.join(directory, "missing-clips.json");
  const missingNotesPath = path.join(directory, "missing-notes.json");
  fs.writeFileSync(nullPath, "null\n");
  const baseOptions = {
    rootDir: ROOT,
    bookmarksPath: path.join(FIXTURES, "bookmarks.json"),
    cardsPath: path.join(FIXTURES, "cards.fixture.json"),
    webClipsPath: missingClipsPath,
    notesPath: missingNotesPath,
    generatedAt: "fixed",
  };
  try {
    const absent = loadBootstrapCatalog(baseOptions);
    assert.equal(absent.diagnostics.sources.webClips, "absent");
    assert.equal(absent.diagnostics.sources.manualNotes, "absent");

    assert.throws(
      () => loadBootstrapCatalog({ ...baseOptions, bookmarksPath: nullPath }),
      CatalogValidationError
    );
    assert.throws(
      () => loadBootstrapCatalog({ ...baseOptions, cardsPath: nullPath }),
      CatalogValidationError
    );
    assert.throws(
      () => loadBootstrapCatalog({ ...baseOptions, webClipsPath: nullPath }),
      CatalogValidationError
    );
    assert.throws(
      () => loadBootstrapCatalog({ ...baseOptions, notesPath: nullPath }),
      CatalogValidationError
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("manual-note map validation never includes raw selector keys", () => {
  const privateKey = "/private/workspace/SECRET_TOKEN/manual-note.json";
  assert.throws(() => buildCatalog({
    bookmarksPayload: { bookmarks: [] },
    cardsPayload: { cards: [] },
    notesPayload: { notes: { [privateKey]: null } },
    generatedAt: "fixed",
  }), (error) => {
    assert.equal(error.message, "manual note entry 0 must be an object.");
    assert.ok(!error.message.includes(privateKey));
    assert.ok(!error.message.includes("/private/workspace"));
    assert.ok(!error.message.includes("SECRET_TOKEN"));
    return true;
  });
});

test("catalog read failures expose only source roles and stable codes", () => {
  const hiddenPath = path.join(ROOT, "private", "bookmark-source.json");
  assert.throws(() => loadBootstrapCatalog({
    rootDir: ROOT,
    bookmarksPath: hiddenPath,
    cardsPath: path.join(FIXTURES, "cards.fixture.json"),
    readFileSync(filePath, encoding) {
      if (filePath === hiddenPath) {
        const error = new Error(`EACCES: permission denied, open '${filePath}'`);
        error.code = "EACCES";
        throw error;
      }
      return fs.readFileSync(filePath, encoding);
    },
  }), (error) => {
    assert.equal(error.code, "catalog_bookmarks_read_failed");
    assert.equal(error.message, "Bookmark data could not be read.");
    assert.ok(!error.message.includes(hiddenPath));
    return true;
  });
});

test("invalid search requests fail without returning catalog records", () => {
  const catalog = fixtureCatalog();
  const invalid = [
    { filters: { unknown: ["x"] } },
    { filters: { style: "Minimal" } },
    { limit: 51 },
    { offset: -1 },
    { query: null },
    { query: false },
    { query: 0 },
    { query: {} },
    { query: [] },
    { query: "---" },
    { extra: true },
  ];
  for (const request of invalid) {
    assert.throws(() => searchCatalog(catalog, request), SearchValidationError);
  }
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    const filters = Object.fromEntries([[name, ["x"]]]);
    assert.throws(
      () => searchCatalog(catalog, { filters }),
      (error) => error instanceof SearchValidationError && error.message === `Unknown filter: ${name}.`
    );
  }
  const inheritedFilters = Object.create({ style: ["Minimal"] });
  assert.equal(searchCatalog(catalog, { filters: inheritedFilters }).total, catalog.items.length);
  assert.doesNotThrow(() => searchCatalog(catalog, {}));
});

test("search bounds query work, reasons, pagination, and large valid lists", () => {
  const longQuery = "x".repeat(2000);
  assert.equal(searchCatalog({ items: [makeSearchItem(0)] }, { query: longQuery }).total, 0);
  assert.throws(
    () => searchCatalog({ items: [makeSearchItem(0)] }, { query: `${longQuery}x` }),
    SearchValidationError
  );

  const terms = Array.from({ length: MAX_QUERY_TERMS + 36 }, (_, index) => `term${index}`);
  const query = terms.join(" ");
  const largeValues = Array.from({ length: 500 }, (_, index) => `value-${String(index).padStart(3, "0")}`);
  const filters = Array.from({ length: 49 }, (_, index) => `missing-${index}`).concat("value-499");
  const items = Array.from({ length: 80 }, (_, index) => makeSearchItem(index, {
    title: query,
    categories: largeValues,
    styles: largeValues,
    colors: largeValues,
    interactions: largeValues,
    collections: largeValues,
    tags: largeValues,
    visible: largeValues,
  }));
  const result = searchCatalog({ items }, {
    query,
    filters: {
      category: filters,
      style: filters,
      color: filters,
      interaction: filters,
    },
    offset: 10,
    limit: 50,
  });
  assert.equal(result.total, 80);
  assert.equal(result.results.length, 50);
  assert.ok(result.results.every((entry) => entry.matchReasons.length > 0));
  assert.ok(result.results.every((entry) => entry.matchReasons.length <= MAX_MATCH_REASONS));
  assert.equal(result.results[0].matchReasons.length, MAX_MATCH_REASONS);
  assert.equal(result.results[0].score, 32 + (MAX_QUERY_TERMS * 14) + (MAX_QUERY_TERMS * 2));
});

test("npm search JSON mode keeps stdout machine-readable and diagnostics on stderr", () => {
  const result = spawnSync("npm", ["run", "--silent", "search", "--", "--query", "kinetic", "--category", "Typography", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    env: cliEnvironment(),
  });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.total, 1);
  assert.equal(response.results[0].item.sourceRecordId, "fixture-notes-002");
  assert.match(result.stderr, /Catalog: 3 items/);
});

test("direct node JSON mode works and CLI rejects a missing query value", () => {
  const direct = spawnSync(process.execPath, ["tools/search.mjs", "--query", "kinetic", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    env: cliEnvironment(),
  });
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(JSON.parse(direct.stdout).total, 1);

  const invalid = spawnSync(process.execPath, ["tools/search.mjs", "--query", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    env: cliEnvironment(),
  });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /--query requires a value/);
});

test("CLI catalog failures do not disclose configured local paths", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-cli-error-"));
  const hiddenPath = path.join(directory, "private-catalog.json");
  fs.writeFileSync(hiddenPath, "{invalid json");
  try {
    const cli = spawnSync(process.execPath, ["tools/search.mjs", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      env: cliEnvironment({ BOOKMARKS_PATH: hiddenPath }),
    });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /Bookmark data contains invalid JSON/);
    assert.ok(!cli.stderr.includes(hiddenPath));
    assert.ok(!cli.stderr.includes("BOOKMARKS_PATH"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI malformed manual-note maps do not disclose selector keys or configuration", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-cli-notes-"));
  const notesPath = path.join(directory, "manual-notes.json");
  const privateKey = "/private/workspace/SECRET_TOKEN/manual-note.json";
  fs.writeFileSync(notesPath, `${JSON.stringify({ notes: { [privateKey]: null } })}\n`);
  try {
    const cli = spawnSync(process.execPath, ["tools/search.mjs", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      env: cliEnvironment({ MANUAL_NOTES_PATH: notesPath }),
    });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /manual note entry 0 must be an object/);
    assert.ok(!cli.stderr.includes(privateKey));
    assert.ok(!cli.stderr.includes("/private/workspace"));
    assert.ok(!cli.stderr.includes("SECRET_TOKEN"));
    assert.ok(!cli.stderr.includes(notesPath));
    assert.ok(!cli.stderr.includes("MANUAL_NOTES_PATH"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("direct human CLI output blocks imported ANSI, OSC, and C1 controls", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-cli-terminal-"));
  const bookmarksPath = path.join(directory, "bookmarks.json");
  const cardsPath = path.join(directory, "cards.json");
  const notesPath = path.join(directory, "manual-notes.json");
  const missingClipsPath = path.join(directory, "missing-clips.json");
  const missingNotesPath = path.join(directory, "missing-notes.json");
  const runCli = (manualNotesPath = missingNotesPath) => spawnSync(process.execPath, ["tools/search.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
    env: cliEnvironment({
      BOOKMARKS_PATH: bookmarksPath,
      MEDIA_CARDS_PATH: cardsPath,
      WEB_CLIPS_PATH: missingClipsPath,
      MANUAL_NOTES_PATH: manualNotesPath,
    }),
  });

  fs.writeFileSync(cardsPath, `${JSON.stringify({ cards: [] })}\n`);
  try {
    fs.writeFileSync(bookmarksPath, `${JSON.stringify({
      bookmarks: [{
        id: "terminal-identity",
        text: "Terminal identity",
        url: "https://example.com/\u009bIDENTITY_PAYLOAD",
        images: [{ id: "terminal-media", url: "assets/sample-interface.svg", type: "photo" }],
      }],
    })}\n`);
    const identity = runCli();
    assert.equal(identity.status, 0, identity.stderr);
    assert.match(identity.stdout, /\\u009bIDENTITY_PAYLOAD/);
    assertNoUnsafeTerminalControls(identity.stdout, "identity stdout");
    assertNoUnsafeTerminalControls(identity.stderr, "identity stderr");

    fs.writeFileSync(bookmarksPath, `${JSON.stringify({
      bookmarks: [{
        id: "terminal-title",
        text: "Visible\u001b]0;TITLE_PAYLOAD\u0007",
        url: "https://example.com/terminal-title",
        images: [{ id: "terminal-media", url: "assets/sample-interface.svg", type: "photo" }],
      }],
    })}\n`);
    const rejectedTitle = runCli();
    assert.equal(rejectedTitle.status, 0, rejectedTitle.stderr);
    assert.equal(rejectedTitle.stdout, "0 results\n");
    assert.ok(!rejectedTitle.stdout.includes("TITLE_PAYLOAD"));
    assert.ok(!rejectedTitle.stderr.includes("TITLE_PAYLOAD"));
    assertNoUnsafeTerminalControls(rejectedTitle.stdout, "rejected title stdout");
    assertNoUnsafeTerminalControls(rejectedTitle.stderr, "rejected title stderr");

    fs.writeFileSync(bookmarksPath, `${JSON.stringify({
      bookmarks: [{
        id: "terminal-note",
        text: "Terminal note",
        url: "https://example.com/terminal-note",
        images: [{ id: "terminal-note-media", url: "assets/sample-interface.svg", type: "photo" }],
      }],
    })}\n`);
    fs.writeFileSync(notesPath, `${JSON.stringify({
      notes: [{
        mediaId: "terminal-note-media",
        note: "Unsafe\u001b]2;NOTE_PAYLOAD\u0007",
      }],
    })}\n`);
    const rejectedNote = runCli(notesPath);
    assert.equal(rejectedNote.status, 1);
    assert.equal(rejectedNote.stdout, "");
    assert.match(rejectedNote.stderr, /manual-note\.text contains unsafe control characters/);
    assert.ok(!rejectedNote.stderr.includes("NOTE_PAYLOAD"));
    assertNoUnsafeTerminalControls(rejectedNote.stdout, "rejected note stdout");
    assertNoUnsafeTerminalControls(rejectedNote.stderr, "rejected note stderr");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

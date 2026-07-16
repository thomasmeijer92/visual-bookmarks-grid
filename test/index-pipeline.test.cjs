const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const { buildCatalog, buildSearchText, loadBootstrapCatalog } = require("../lib/catalog/bootstrap");
const {
  atomicWriteIndex,
  buildIndex,
  createIndexDocument,
  privacyBoundedRecord,
  readAndValidateIndex,
  runExternalEnrichment,
} = require("../lib/catalog/index-pipeline");
const { validateIndex } = require("../lib/catalog/index-schema");
const { loadCatalog } = require("../lib/catalog/loader");

const ROOT = path.resolve(__dirname, "..");
const SEARCH_FIXTURES = path.join(__dirname, "fixtures", "search");
const INDEX_FIXTURES = path.join(__dirname, "fixtures", "index");
const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(SEARCH_FIXTURES, name), "utf8"));

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertExactAliasesResolve(index, expectedId) {
  const selectors = new Map();
  const add = (selector, catalogId) => {
    const ids = selectors.get(selector) || new Set();
    ids.add(catalogId);
    selectors.set(selector, ids);
  };
  for (const row of index.resolverAliases) {
    add(row.mediaId, row.catalogId);
    for (const alias of row.mediaIdAliases) add(alias, row.catalogId);
    for (const alias of row.legacyNoteKeyAliases) add(alias.key, row.catalogId);
  }
  for (const ids of selectors.values()) assert.deepEqual([...ids], [expectedId]);
}

function bookmark(id, title, sourceSuffix = id, mediaSuffix = id, overrides = {}) {
  return {
    id,
    text: title,
    url: `https://example.com/index/${sourceSuffix}`,
    authorName: "Example Studio",
    images: [{ type: "photo", url: `assets/${mediaSuffix}.webp`, width: 1200, height: 900 }],
    tags: [],
    ...overrides,
  };
}

function createWorkspace(records, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "inspiration-index-test-"));
  const paths = {
    directory,
    bookmarksPath: path.join(directory, "bookmarks.json"),
    cardsPath: path.join(directory, "cards.json"),
    webClipsPath: path.join(directory, "clips.json"),
    notesPath: path.join(directory, "notes.json"),
    reviewPath: path.join(directory, "metadata-review.json"),
    lockPath: path.join(directory, "metadata-review.lock"),
    indexPath: path.join(directory, "inspiration-index.json"),
  };
  fs.writeFileSync(paths.bookmarksPath, `${JSON.stringify({ bookmarks: records })}\n`);
  fs.writeFileSync(paths.cardsPath, `${JSON.stringify(options.cards || { cards: [] })}\n`);
  if (options.clips !== undefined) fs.writeFileSync(paths.webClipsPath, `${JSON.stringify(options.clips)}\n`);
  if (options.notes !== undefined) fs.writeFileSync(paths.notesPath, `${JSON.stringify(options.notes)}\n`);
  return paths;
}

function buildOptions(paths, overrides = {}) {
  return {
    rootDir: ROOT,
    bookmarksPath: paths.bookmarksPath,
    cardsPath: paths.cardsPath,
    webClipsPath: paths.webClipsPath,
    notesPath: paths.notesPath,
    reviewPath: paths.reviewPath,
    lockPath: paths.lockPath,
    indexPath: paths.indexPath,
    ...overrides,
  };
}

async function request(port, pathname, method = "GET", body = "") {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {},
    }, (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { responseBody += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: responseBody }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function startServer(environment) {
  const reviewPath = environment.METADATA_REVIEW_PATH || path.join(os.tmpdir(), `index-server-review-${process.pid}-${Date.now()}.json`);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GRID_HOST: "127.0.0.1",
      PORT: "0",
      GRID_PORT: "0",
      METADATA_REVIEW_PATH: reviewPath,
      METADATA_REVIEW_LOCK_PATH: environment.METADATA_REVIEW_LOCK_PATH || reviewPath.replace(/\.json$/, ".lock"),
      ...environment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let port = 0;
  const inspect = (chunk) => {
    output += chunk;
    const match = output.match(/Server running at http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) port = Number(match[1]);
  };
  child.stdout.on("data", inspect);
  child.stderr.on("data", inspect);
  for (let attempt = 0; attempt < 50 && !port; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!port) {
    child.kill();
    throw new Error(`Server did not start: ${output}`);
  }
  return { child, port, output: () => output };
}

test("the full generic source set builds a deterministic validated index", async () => {
  const workspace = createWorkspace(readFixture("bookmarks.json").bookmarks, {
    cards: readFixture("cards.fixture.json"),
    clips: readFixture("clips.fixture.json"),
    notes: readFixture("manual-notes.json"),
  });
  try {
    const first = await buildIndex(buildOptions(workspace, { generatedAt: "2026-07-11T10:00:00.000Z" }));
    assert.equal(first.summary.written, 3);
    assert.deepEqual(first.summary.sources, {
      bookmarks: { mode: "local", read: 2 },
      metadataCards: { mode: "local", read: 3 },
      webClips: { mode: "local", read: 1 },
      manualNotes: { mode: "local", read: 1 },
    });
    assert.equal(first.index.items.find((item) => item.sourceType === "web-clip").media.url,
      "/assets/clips/web-example-001/image.webp");
    assert.ok(first.index.items.some((item) => item.notes.length === 1));
    validateIndex(first.index);

    const bookmarks = readFixture("bookmarks.json");
    bookmarks.bookmarks.reverse();
    const cards = readFixture("cards.fixture.json");
    cards.cards.reverse();
    const notes = readFixture("manual-notes.json");
    notes.notes = Object.fromEntries(Object.entries(notes.notes).reverse());
    fs.writeFileSync(workspace.bookmarksPath, `${JSON.stringify(bookmarks)}\n`);
    fs.writeFileSync(workspace.cardsPath, `${JSON.stringify(cards)}\n`);
    fs.writeFileSync(workspace.notesPath, `${JSON.stringify(notes)}\n`);
    const second = await buildIndex(buildOptions(workspace, { generatedAt: "2026-07-11T10:01:00.000Z" }));
    assert.deepEqual(second.index.items, first.index.items);
    assert.deepEqual(second.index.resolverAliases, first.index.resolverAliases);
    assert.equal(second.validation.fingerprint, first.validation.fingerprint);
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("web clip native-id variants retain stable visual and derived media identity", () => {
  const clip = readFixture("clips.fixture.json").clips[0];
  const ids = [];
  for (const variant of ["web-example-001", "", undefined]) {
    const raw = { ...clip };
    if (variant === undefined) delete raw.id;
    else raw.id = variant;
    const catalog = buildCatalog({
      bookmarksPayload: { bookmarks: [] },
      cardsPayload: { cards: [] },
      webClipsPayload: { clips: [raw] },
      generatedAt: "2026-07-11T10:00:00.000Z",
    });
    const index = createIndexDocument(catalog);
    validateIndex(index);
    ids.push({ id: index.items[0].id, mediaId: index.items[0].mediaId });
    assert.equal(index.items[0].sourceUrl, "https://example.com/reference");
  }
  assert.equal(new Set(ids.map((entry) => entry.id)).size, 1);
  assert.equal(new Set(ids.map((entry) => entry.mediaId)).size, 1);
});

test("duplicate ownership changes preserve pair identity and sorted aliases", () => {
  const low = bookmark("z-owner", "Lower owner", "same", "same");
  const high = bookmark("a-owner", "Higher owner", "same", "same");
  const build = (records) => createIndexDocument(buildCatalog({
    bookmarksPayload: { bookmarks: records }, cardsPayload: { cards: [] }, generatedAt: "2026-07-11T10:00:00.000Z",
  }));
  const single = build([low]);
  const duplicate = build([low, high]);
  const restored = build([low]);
  assert.equal(single.items[0].id, duplicate.items[0].id);
  assert.equal(restored.items[0].id, duplicate.items[0].id);
  assert.equal(duplicate.items[0].sourceRecordId, "a-owner");
  assert.equal(duplicate.resolverAliases.length, 2);
  validateIndex(duplicate);

  const separate = build([
    bookmark("native-id", "First", "first", "first"),
    bookmark("native-id", "Second", "second", "second"),
  ]);
  assert.equal(separate.items.length, 2);
  assert.equal(new Set(separate.items.map((item) => item.id)).size, 2);
});

test("independent duplicate and source-container permutations preserve the complete index", () => {
  const owner = bookmark("a-owner", "Base title", "same", "same", {
    collections: ["Saved", "Design"],
    categories: ["Interface", "Interface"],
    styles: "Minimal",
    colors: ["Dark", "dark"],
    interactions: "Motion",
    visibleText: ["pricing cards", "pricing cards"],
    tags: ["saas", "SaaS"],
  });
  const duplicate = bookmark("z-owner", "Duplicate title", "same", "same", {
    collection: "Archive",
    category: "Product",
    style: ["Editorial", "Editorial"],
    color: "Blue",
    interaction: ["Scroll", "Scroll"],
    objects: "navigation",
    tagSlugs: ["reference", "Reference"],
  });
  const cards = {
    cards: [
      {
        mediaId: "a-owner-card", title: "Card title", category: ["Interface", "Interface"],
        style: "Minimal", color: ["Dark", "dark"], interaction: "Motion", visibleText: "pricing cards",
        tags: ["SaaS", "saas"], media: { type: "photo", url: "assets/same.webp" }, tweet: { id: "a-owner" },
      },
      {
        mediaId: "unused-card", title: "Unused", media: { type: "photo", url: "assets/other.webp" }, tweet: { id: "a-owner" },
      },
    ],
  };
  const notes = { notes: {
    "a-owner-card": { mediaId: "a-owner-card", note: "Selected note", updatedAt: "2026-07-11T10:00:00.000Z" },
    "a-owner:assets/same.webp": { mediaUrl: "assets/same.webp", tweetId: "a-owner", note: "Older note", updatedAt: "2026-07-10T10:00:00.000Z" },
  } };
  const build = ({ bookmarks = [owner, duplicate], metadataCards = cards, manualNotes = notes } = {}) =>
    createIndexDocument(buildCatalog({
      bookmarksPayload: { bookmarks }, cardsPayload: metadataCards, notesPayload: manualNotes,
      generatedAt: "2026-07-11T10:00:00.000Z",
    }));
  const baseline = build();
  const variants = [
    build({ bookmarks: [duplicate, owner] }),
    build({ metadataCards: { cards: [...cards.cards].reverse() } }),
    build({ manualNotes: { notes: Object.fromEntries(Object.entries(notes.notes).reverse()) } }),
    build({
      bookmarks: [
        { ...owner, collections: ["Design", "Saved", "Saved"], categories: "Interface", styles: ["Minimal", "Minimal"], colors: ["dark", "Dark"], interactions: ["Motion"], visibleText: "pricing cards", tags: ["SaaS", "saas"] },
        { ...duplicate, collection: ["Archive", "Archive"], category: ["Product"], style: "Editorial", color: ["Blue"], interaction: "Scroll", objects: ["navigation"], tagSlugs: ["Reference", "reference"] },
      ],
    }),
  ];
  for (const variant of variants) {
    assert.deepEqual(variant.items, baseline.items);
    assert.deepEqual(variant.resolverAliases, baseline.resolverAliases);
    assert.equal(validateIndex(variant).fingerprint, validateIndex(baseline).fingerprint);
  }
});

test("persisted duplicate-owner transitions retain catalog identity and exact aliases", async () => {
  const low = bookmark("z-owner", "Lower owner", "same", "same");
  const high = bookmark("a-owner", "Higher owner", "same", "same");
  const workspace = createWorkspace([low]);
  try {
    const expectedIds = [];
    for (const { records, ownerId } of [
      { records: [low], ownerId: "z-owner" },
      { records: [low, high], ownerId: "a-owner" },
      { records: [low], ownerId: "z-owner" },
    ]) {
      fs.writeFileSync(workspace.bookmarksPath, `${JSON.stringify({ bookmarks: records })}\n`);
      const built = await buildIndex(buildOptions(workspace, { generatedAt: "2026-07-11T10:00:00.000Z" }));
      const persisted = loadCatalog(buildOptions(workspace));
      assert.equal(persisted.diagnostics.mode, "index");
      assert.deepEqual(persisted.items, built.index.items);
      assert.equal(built.index.items[0].sourceRecordId, ownerId);
      assert.ok(built.index.resolverAliases.some((row) =>
        row.sourceType === built.index.items[0].sourceType &&
        row.sourceRecordId === ownerId &&
        row.mediaId === built.index.items[0].mediaId
      ));
      assertExactAliasesResolve(persisted, built.index.items[0].id);
      expectedIds.push(built.index.items[0].id);
    }
    assert.equal(new Set(expectedIds).size, 1);
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("derived media and card aliases resolve exactly in bootstrap and persisted indexes", async () => {
  const source = bookmark("alias-owner", "Alias fixture", "alias", "alias");
  delete source.images[0].id;
  const workspace = createWorkspace([source], {
    cards: { cards: [{
      mediaId: "alias-card-media", title: "Alias card", media: { type: "photo", url: "assets/alias.webp" },
      tweet: { id: "alias-owner" },
    }] },
    notes: { generatedAt: "2026-07-11T10:00:00.000Z", source: "visual-bookmarks-grid manual lightbox notes", notes: {
      "alias-card-media": {
        mediaId: "alias-card-media", recordId: "", tweetId: "", tweetUrl: "", mediaUrl: "", titleAtEdit: "", creatorAtEdit: "",
        note: "Alias note", status: "needs_agent_review", createdAt: "2026-07-11T10:00:00.000Z", updatedAt: "2026-07-11T10:00:00.000Z",
      },
    } },
  });
  try {
    const bootstrap = loadBootstrapCatalog(buildOptions(workspace, { generatedAt: "2026-07-11T10:00:00.000Z" }));
    const bootstrapIndex = createIndexDocument(bootstrap);
    const built = await buildIndex(buildOptions(workspace, { generatedAt: "2026-07-11T10:00:00.000Z" }));
    const expectedId = built.index.items[0].id;
    assert.match(built.index.items[0].mediaId, /^media-url:v1:[0-9a-f]{64}$/);
    assert.deepEqual(built.index.resolverAliases[0].mediaIdAliases, ["alias-card-media", built.index.items[0].mediaId]);
    assert.deepEqual(built.index.resolverAliases[0].legacyNoteKeyAliases, [
      { kind: "canonical", key: "alias-owner:assets/alias.webp" },
      { kind: "url", key: "assets/alias.webp" },
    ]);
    assert.equal(built.index.items[0].notes[0].text, "Alias note");
    assertExactAliasesResolve(bootstrapIndex, expectedId);
    const persisted = loadCatalog(buildOptions(workspace));
    assertExactAliasesResolve(persisted, expectedId);
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("derived media-id namespace is reserved during normalization and malformed values remain rejected", async () => {
  const collidingId = `media-url:v1:${"a".repeat(64)}`;
  const source = bookmark("derived-id", "Derived namespace", "derived-id", "derived-id", {
    images: [{ id: collidingId, type: "photo", url: "assets/derived-id.webp", width: 1200, height: 900 }],
  });
  const workspace = createWorkspace([source], {
    cards: { cards: [{
      mediaId: collidingId, title: "Card fallback", media: { type: "photo", url: "assets/derived-id.webp" },
      tweet: { id: "derived-id" },
    }] },
  });
  try {
    const built = await buildIndex(buildOptions(workspace, { generatedAt: "2026-07-11T10:00:00.000Z" }));
    const item = built.index.items[0];
    assert.match(item.mediaId, /^media-url:v1:[0-9a-f]{64}$/);
    assert.notEqual(item.mediaId, collidingId);
    assert.deepEqual(built.index.resolverAliases[0].mediaIdAliases, [item.mediaId]);
    validateIndex(built.index);
    const persisted = loadCatalog(buildOptions(workspace));
    assert.deepEqual(persisted.resolverAliases, built.index.resolverAliases);

    for (const mediaId of ["media-url:v1:deadbeef", `media-url:v1:${"b".repeat(64)}`]) {
      const malformed = jsonClone(built.index);
      malformed.items[0].mediaId = mediaId;
      malformed.resolverAliases[0].mediaId = mediaId;
      malformed.resolverAliases[0].mediaIdAliases = [mediaId];
      assert.throws(() => validateIndex(malformed), (error) => error.code === "invalid_inspiration_index");
    }
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("schema rejects impossible owner aliases and non-generator provenance combinations", () => {
  const source = bookmark("owner-check", "", "owner-check", "owner-check", {
    sourcePlatform: "", authorName: "", categories: ["Base category"], tags: ["Base tag"],
  });
  const catalog = buildCatalog({
    bookmarksPayload: { bookmarks: [source] },
    cardsPayload: { cards: [{
      mediaId: "owner-check-card", title: "Card title", source: "Card source", creator: "Card creator",
      category: "Card category", tags: ["Card tag"], media: { type: "photo", url: "assets/owner-check.webp" },
      tweet: { id: "owner-check" },
    }] },
    generatedAt: "2026-07-11T10:00:00.000Z",
  });
  const valid = createIndexDocument(catalog);
  validateIndex(valid);
  const mutations = [
    (index) => { index.items[0].provenance.title = ["metadata-card", "bookmark"]; },
    (index) => { index.items[0].provenance.categories = ["fixture-enricher", "bookmark"]; },
    (index) => { index.items[0].provenance.tags = ["metadata-card", "bookmark"]; },
    (index) => { index.items[0].provenance.sourceName = ["fixture-enricher"]; },
    (index) => { index.resolverAliases[0].sourceUrl = "https://example.com:443/index/owner-check"; },
  ];
  for (const mutate of mutations) {
    const index = jsonClone(valid);
    mutate(index);
    assert.throws(() => validateIndex(index), (error) => error.code === "invalid_inspiration_index");
  }

  const noSourceId = createIndexDocument(buildCatalog({
    bookmarksPayload: { bookmarks: [bookmark("", "No source id", "no-source", "no-source")] },
    cardsPayload: { cards: [] },
    generatedAt: "2026-07-11T10:00:00.000Z",
  }));
  const row = noSourceId.resolverAliases[0];
  row.mediaIdAliases = ["card-only-alias", row.mediaId].sort();
  assert.throws(() => validateIndex(noSourceId), (error) => error.code === "invalid_inspiration_index");
});

test("Bet Two list roles are independently order-insensitive while primary visual order remains semantic", async () => {
  const listRoles = ["collections", "categories", "styles", "colors", "interactions", "visible", "tags"];
  const baseLists = Object.fromEntries(listRoles.map((role) => [role, [`Owner ${role} B`, `Owner ${role} A`]]));
  const duplicateLists = Object.fromEntries(listRoles.map((role) => [role, [`Duplicate ${role} B`, `Duplicate ${role} A`]]));
  const cardLists = Object.fromEntries(listRoles.map((role) => [role, [`Card ${role} B`, `Card ${role} A`]]));
  const owner = bookmark("a-owner", "", "matrix", "matrix", {
    ...baseLists, sourcePlatform: "", authorName: "", authorHandle: "", authorAvatar: "",
    bookmarkedAt: "2026-07-01T10:00:00.000Z",
    images: [{ id: "owner-media", type: "photo", url: "assets/matrix.webp", width: 1200, height: 900 }],
  });
  const duplicate = bookmark("z-duplicate", "Duplicate title", "matrix", "matrix", duplicateLists);
  const card = {
    ...cardLists,
    mediaId: "matrix-card", title: "Card title", description: "Card description", source: "Card source", creator: "Card creator",
    creatorHandle: "card-handle", author: { avatarUrl: "https://example.com/card-avatar.webp" },
    media: { type: "photo", url: "assets/matrix.webp" }, tweet: { id: "a-owner" },
  };
  const workspace = createWorkspace([owner, duplicate], { cards: { cards: [card] } });
  const rebuild = async (records, cards) => {
    fs.writeFileSync(workspace.bookmarksPath, `${JSON.stringify({ bookmarks: records })}\n`);
    fs.writeFileSync(workspace.cardsPath, `${JSON.stringify({ cards })}\n`);
    await buildIndex(buildOptions(workspace, { generatedAt: "2026-07-11T10:00:00.000Z" }));
    return loadCatalog(buildOptions(workspace));
  };
  try {
    const baseline = await rebuild([owner, duplicate], [card]);
    const item = baseline.items[0];
    assert.equal(item.sourceName, "Card source");
    assert.equal(item.creatorName, "Card creator");
    assert.equal(item.creatorHandle, "card-handle");
    assert.equal(item.creatorAvatarUrl, "https://example.com/card-avatar.webp");
    assert.equal(item.sourceRecordId, "a-owner");
    assert.equal(item.mediaId, "owner-media");
    assert.equal(item.savedAt, "2026-07-01T10:00:00.000Z");
    assert.deepEqual(item.collections, ["Duplicate collections A", "Duplicate collections B", "Owner collections A", "Owner collections B"]);
    assert.ok(!item.collections.some((value) => value.startsWith("Card collections")));
    assertExactAliasesResolve(baseline, item.id);

    for (const role of listRoles) {
      const baseVariant = [jsonClone(owner), jsonClone(duplicate)];
      for (const record of baseVariant) record[role].reverse();
      const cardVariant = jsonClone(card);
      cardVariant[role].reverse();
      for (const [records, cards] of [[baseVariant, [card]], [[owner, duplicate], [cardVariant]]]) {
        const persisted = await rebuild(records, cards);
        assert.deepEqual(persisted.items, baseline.items, role);
        assert.deepEqual(persisted.resolverAliases, baseline.resolverAliases, role);
        assert.equal(persisted.diagnostics.validation.fingerprint, baseline.diagnostics.validation.fingerprint, role);
        assertExactAliasesResolve(persisted, item.id);
      }
    }

    const rejected = await runExternalEnrichment(createIndexDocument(buildCatalog({
      bookmarksPayload: { bookmarks: [owner] }, cardsPayload: { cards: [card] }, generatedAt: "2026-07-11T10:00:00.000Z",
    })), async () => ({
      patch: { collections: ["External collection"] }, provenance: { collections: "fixture-enricher" },
    }));
    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.index.items[0].collections, ["Owner collections A", "Owner collections B"]);
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }

  const primaryFirst = bookmark("visual-order", "Primary order", "visual-order", "first", {
    images: [
      { id: "first", type: "photo", url: "assets/first.webp", width: 1200, height: 900 },
      { id: "second", type: "photo", url: "assets/second.webp", width: 1200, height: 900 },
    ],
  });
  const primarySecond = { ...primaryFirst, images: [...primaryFirst.images].reverse() };
  const first = createIndexDocument(buildCatalog({
    bookmarksPayload: { bookmarks: [primaryFirst] }, cardsPayload: { cards: [] }, generatedAt: "2026-07-11T10:00:00.000Z",
  }));
  const second = createIndexDocument(buildCatalog({
    bookmarksPayload: { bookmarks: [primarySecond] }, cardsPayload: { cards: [] }, generatedAt: "2026-07-11T10:00:00.000Z",
  }));
  assert.notEqual(first.items[0].id, second.items[0].id);
  assert.equal(first.items[0].media.url, "assets/first.webp");
  assert.equal(second.items[0].media.url, "assets/second.webp");
});

test("schema validation rejects malformed derived, sorted, provenance, and bounded fields without content", () => {
  const catalog = loadBootstrapCatalog({ rootDir: ROOT, generatedAt: "2026-07-11T10:00:00.000Z" });
  const valid = createIndexDocument(catalog);
  const mutations = [
    (index) => { index.schemaVersion = 2; },
    (index) => { index.generatedAt = "not-a-date"; },
    (index) => { index.items.reverse(); },
    (index) => { index.items[0].id = `visual:v1:${"0".repeat(64)}`; },
    (index) => { index.items[0].mediaId = `media-url:v1:${"0".repeat(64)}`; },
    (index) => { index.items[0].searchText = "PRIVATE_SOURCE_CONTENT"; },
    (index) => { index.items[0].provenance.title = ["/private/local/path"]; },
    (index) => { delete index.items[0].provenance.media; },
    (index) => { index.items[0].title = "x".repeat(10001); },
    (index) => { index.resolverAliases.reverse(); },
    (index) => { index.resolverAliases.push(jsonClone(index.resolverAliases.at(-1))); },
    (index) => { index.resolverAliases = index.resolverAliases.filter((row) => row.sourceRecordId !== index.items[0].sourceRecordId); },
    (index) => { index.resolverAliases[0].mediaIdAliases.push("media-url:v1:deadbeef"); },
    (index) => {
      const row = index.resolverAliases.find((candidate) => candidate.sourceRecordId);
      row.legacyNoteKeyAliases = [{ kind: "url", key: row.mediaUrl }];
    },
    (index) => {
      index.items[0].notes = [
        { kind: "manual", text: "First note", updatedAt: null },
        { kind: "manual", text: "Second note", updatedAt: null },
      ];
      index.items[0].provenance.notes = ["manual-note"];
    },
    (index) => { index.items[0].notes = []; index.items[0].provenance.notes = ["manual-note"]; },
  ];
  for (const mutate of mutations) {
    const index = jsonClone(valid);
    mutate(index);
    assert.throws(() => validateIndex(index), (error) => {
      assert.equal(error.code, "invalid_inspiration_index");
      assert.ok(!error.message.includes("PRIVATE_SOURCE_CONTENT"));
      assert.ok(!error.message.includes("/private/local/path"));
      return true;
    });
  }
});

test("manual-override provenance is limited to accepted patch fields in generated and persisted indexes", async () => {
  const workspace = createWorkspace([bookmark("manual-override", "Imported title", "manual-override", "manual-override", {
    authorHandle: "example-handle",
  })]);
  try {
    const built = await buildIndex(buildOptions(workspace, { generatedAt: "2026-07-11T10:00:00.000Z" }));
    const acceptedPatch = jsonClone(built.index);
    acceptedPatch.items[0].title = "Reviewed title";
    acceptedPatch.items[0].provenance.title = ["manual-override"];
    acceptedPatch.items[0].searchText = buildSearchText(acceptedPatch.items[0]).searchText;
    assert.doesNotThrow(() => validateIndex(acceptedPatch));

    const persisted = JSON.parse(fs.readFileSync(workspace.indexPath, "utf8"));
    persisted.items[0].provenance.creatorHandle = ["manual-override"];
    fs.writeFileSync(workspace.indexPath, `${JSON.stringify(persisted)}\n`);
    assert.throws(() => readAndValidateIndex(workspace.indexPath), (error) => error.code === "invalid_inspiration_index");
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("invalid inputs, final validation, and interrupted writes preserve the previous index", async () => {
  const workspace = createWorkspace([bookmark("stable", "Stable index")]);
  try {
    await buildIndex(buildOptions(workspace, { generatedAt: "2026-07-11T10:00:00.000Z" }));
    const previous = fs.readFileSync(workspace.indexPath);
    fs.writeFileSync(workspace.bookmarksPath, "{invalid json\n");
    await assert.rejects(buildIndex(buildOptions(workspace)), /invalid JSON/);
    assert.deepEqual(fs.readFileSync(workspace.indexPath), previous);

    const valid = JSON.parse(previous);
    const invalid = jsonClone(valid);
    invalid.items[0].searchText = "invalid";
    await assert.rejects(atomicWriteIndex(invalid, workspace.indexPath), /search text/);
    assert.deepEqual(fs.readFileSync(workspace.indexPath), previous);

    await assert.rejects(atomicWriteIndex(valid, workspace.indexPath, {
      beforeRename: async () => { throw new Error("simulated interruption"); },
    }), /simulated interruption/);
    assert.deepEqual(fs.readFileSync(workspace.indexPath), previous);
    assert.deepEqual(fs.readdirSync(workspace.directory).filter((name) => name.includes(".tmp-")), []);
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("index loader prefers valid persisted data, rejects a present invalid index, and falls back only when absent", async () => {
  const workspace = createWorkspace([bookmark("bootstrap", "Bootstrap result")]);
  try {
    await buildIndex(buildOptions(workspace, { generatedAt: "2026-07-11T10:00:00.000Z" }));
    fs.writeFileSync(workspace.bookmarksPath, `${JSON.stringify({ bookmarks: [bookmark("changed", "Changed source")] })}\n`);
    const indexed = loadCatalog(buildOptions(workspace));
    assert.equal(indexed.diagnostics.mode, "index");
    assert.equal(indexed.items[0].sourceRecordId, "bootstrap");

    fs.writeFileSync(workspace.indexPath, "{}\n");
    assert.throws(() => loadCatalog(buildOptions(workspace)), (error) => error.code === "catalog_index_invalid");
    fs.unlinkSync(workspace.indexPath);
    const fallback = loadCatalog(buildOptions(workspace));
    assert.equal(fallback.diagnostics.mode, "bootstrap");
    assert.equal(fallback.items[0].sourceRecordId, "changed");
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("search CLI and API use the valid index while preserving response shape", async () => {
  const workspace = createWorkspace([bookmark("indexed", "Indexed needle")]);
  let server;
  try {
    const built = await buildIndex(buildOptions(workspace, { generatedAt: "2026-07-11T10:00:00.000Z" }));
    fs.writeFileSync(workspace.bookmarksPath, `${JSON.stringify({ bookmarks: [bookmark("fallback", "Fallback needle")] })}\n`);
    const environment = {
      INSPIRATION_INDEX_PATH: workspace.indexPath,
      BOOKMARKS_PATH: workspace.bookmarksPath,
      MEDIA_CARDS_PATH: workspace.cardsPath,
      WEB_CLIPS_PATH: workspace.webClipsPath,
      MANUAL_NOTES_PATH: workspace.notesPath,
      METADATA_REVIEW_PATH: workspace.reviewPath,
      METADATA_REVIEW_LOCK_PATH: workspace.lockPath,
    };
    const cli = spawnSync(process.execPath, ["tools/search.mjs", "--query", "indexed", "--json"], {
      cwd: ROOT, env: { ...process.env, ...environment }, encoding: "utf8",
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).results[0].item.sourceRecordId, "indexed");
    assert.match(cli.stderr, /mode=index/);

    server = await startServer(environment);
    const search = await request(server.port, "/api/search", "POST", JSON.stringify({ query: "indexed" }));
    const searchJson = JSON.parse(search.body);
    assert.equal(search.status, 200);
    assert.equal(searchJson.results[0].item.sourceRecordId, "indexed");
    assert.deepEqual(Object.keys(searchJson).sort(), ["limit", "offset", "ok", "query", "results", "total"]);
    const item = await request(server.port, `/api/items/${encodeURIComponent(built.index.items[0].id)}`);
    assert.equal(JSON.parse(item.body).item.id, built.index.items[0].id);
    assert.equal((await request(server.port, "/inspiration-index.json")).status, 403);

    fs.writeFileSync(workspace.indexPath, "{}\n");
    const invalid = await request(server.port, "/api/search", "POST", "{}");
    assert.equal(invalid.status, 500);
    assert.equal(JSON.parse(invalid.body).error, "Catalog is unavailable.");
    assert.ok(!invalid.body.includes(workspace.directory));

    fs.unlinkSync(workspace.indexPath);
    const fallback = await request(server.port, "/api/search", "POST", JSON.stringify({ query: "fallback" }));
    assert.equal(fallback.status, 200);
    assert.equal(JSON.parse(fallback.body).results[0].item.sourceRecordId, "fallback");
  } finally {
    server?.child.kill();
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("offline build performs no network calls and emits human and JSON command summaries", async () => {
  const workspace = createWorkspace([bookmark("offline", "Offline build")]);
  const originals = { fetch: global.fetch, http: http.request, https: https.request, connect: net.connect };
  const networkFailure = () => { throw new Error("network access attempted"); };
  try {
    global.fetch = networkFailure;
    http.request = networkFailure;
    https.request = networkFailure;
    net.connect = networkFailure;
    const built = await buildIndex(buildOptions(workspace, { generatedAt: "2026-07-11T10:00:00.000Z" }));
    assert.equal(built.summary.publishedMode, "offline-base");
  } finally {
    global.fetch = originals.fetch;
    http.request = originals.http;
    https.request = originals.https;
    net.connect = originals.connect;
  }
  try {
    const environment = {
      ...process.env,
      INSPIRATION_INDEX_PATH: workspace.indexPath,
      BOOKMARKS_PATH: workspace.bookmarksPath,
      MEDIA_CARDS_PATH: workspace.cardsPath,
      WEB_CLIPS_PATH: workspace.webClipsPath,
      MANUAL_NOTES_PATH: workspace.notesPath,
      METADATA_REVIEW_PATH: workspace.reviewPath,
      METADATA_REVIEW_LOCK_PATH: workspace.lockPath,
    };
    const buildJson = spawnSync("npm", ["run", "--silent", "index:build", "--", "--json"], {
      cwd: ROOT, env: environment, encoding: "utf8",
    });
    assert.equal(buildJson.status, 0, buildJson.stderr);
    assert.equal(JSON.parse(buildJson.stdout).written, 1);
    const buildHuman = spawnSync(process.execPath, ["tools/build-index.mjs"], {
      cwd: ROOT, env: environment, encoding: "utf8",
    });
    assert.equal(buildHuman.status, 0, buildHuman.stderr);
    assert.match(buildHuman.stdout, /Index published: 1 item/);
    const checkJson = spawnSync(process.execPath, ["tools/check-index.mjs", "--json"], {
      cwd: ROOT, env: environment, encoding: "utf8",
    });
    assert.equal(checkJson.status, 0, checkJson.stderr);
    assert.equal(JSON.parse(checkJson.stdout).items, 1);
    const checkHuman = spawnSync(process.execPath, ["tools/check-index.mjs"], {
      cwd: ROOT, env: environment, encoding: "utf8",
    });
    assert.equal(checkHuman.status, 0, checkHuman.stderr);
    assert.match(checkHuman.stdout, /Index valid: 1 item/);
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("double opt-in fails before importing the configured module", () => {
  const workspace = createWorkspace([bookmark("double-opt", "Double opt-in")]);
  const marker = path.join(workspace.directory, "imported.txt");
  try {
    const result = spawnSync(process.execPath, [
      "tools/build-index.mjs", "--enricher", path.join(INDEX_FIXTURES, "import-marker.mjs"),
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        ENRICHER_IMPORT_MARKER: marker,
        INSPIRATION_INDEX_PATH: workspace.indexPath,
        BOOKMARKS_PATH: workspace.bookmarksPath,
        MEDIA_CARDS_PATH: workspace.cardsPath,
        METADATA_REVIEW_PATH: workspace.reviewPath,
        METADATA_REVIEW_LOCK_PATH: workspace.lockPath,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires both/);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(workspace.indexPath), false);
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("all-success external enrichment publishes the complete staged batch", async () => {
  const workspace = createWorkspace([
    bookmark("empty-a", "", "empty-a", "empty-a"),
    bookmark("empty-b", "", "empty-b", "empty-b"),
  ]);
  try {
    const result = await buildIndex(buildOptions(workspace, {
      enricherPath: path.join(INDEX_FIXTURES, "enricher-success.mjs"),
      allowExternalEnrichment: true,
      generatedAt: "2026-07-11T10:00:00.000Z",
    }));
    assert.equal(result.summary.ok, true);
    assert.equal(result.summary.publishedMode, "external-complete");
    assert.equal(result.summary.enrichmentAttempted, 2);
    assert.equal(result.summary.enrichmentApplied, 2);
    assert.ok(result.index.items.every((item) => item.title === "Externally enriched title"));
    assert.ok(result.index.items.every((item) => item.tags[0] === "enriched"));
    assert.ok(result.index.items.every((item) => item.provenance.title[0] === "fixture-enricher"));
    validateIndex(JSON.parse(fs.readFileSync(workspace.indexPath, "utf8")));
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("external enrichment cannot forge manual-override provenance and preserves valid origins", async () => {
  const base = createIndexDocument(buildCatalog({
    bookmarksPayload: { bookmarks: [bookmark("external-provenance", "", "external-provenance", "external-provenance")] },
    cardsPayload: { cards: [] },
    generatedAt: "2026-07-11T10:00:00.000Z",
  }));
  const forged = await runExternalEnrichment(base, async () => ({
    patch: { title: "Forged review result" }, provenance: { title: "manual-override" },
  }));
  assert.equal(forged.ok, false);
  assert.equal(forged.failures[0].reason, "invalid_enrichment_patch");
  assert.deepEqual(forged.index, base);

  const valid = await runExternalEnrichment(base, async () => ({
    patch: { title: "External result" }, provenance: { title: "fixture-enricher" },
  }));
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.index.items[0].provenance.title, ["fixture-enricher"]);
  assert.deepEqual(valid.index.items[0].provenance.sourceType, ["bookmark"]);
});

test("mixed external failure discards every patch and publishes the complete offline base", async () => {
  const workspace = createWorkspace([
    bookmark("apply", "Apply enrichment"),
    bookmark("fail", "Fail enrichment"),
  ]);
  try {
    const result = await buildIndex(buildOptions(workspace, {
      enricherPath: path.join(INDEX_FIXTURES, "enricher-mixed.mjs"),
      allowExternalEnrichment: true,
      generatedAt: "2026-07-11T10:00:00.000Z",
    }));
    assert.equal(result.summary.ok, false);
    assert.equal(result.summary.publishedMode, "offline-base");
    assert.equal(result.summary.enrichmentFailed, 1);
    assert.equal(result.summary.enrichmentApplied, 0);
    assert.ok(result.index.items.every((item) => item.tags.length === 0));
    assert.ok(!JSON.stringify(result.summary).includes("PRIVATE_PROVIDER_RESPONSE"));
    const published = JSON.parse(fs.readFileSync(workspace.indexPath, "utf8"));
    assert.deepEqual(published.items, result.index.items);

    const cli = spawnSync(process.execPath, [
      "tools/build-index.mjs",
      "--enricher", path.join(INDEX_FIXTURES, "enricher-mixed.mjs"),
      "--allow-external-enrichment",
      "--json",
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        INSPIRATION_INDEX_PATH: workspace.indexPath,
        BOOKMARKS_PATH: workspace.bookmarksPath,
        MEDIA_CARDS_PATH: workspace.cardsPath,
        WEB_CLIPS_PATH: workspace.webClipsPath,
        MANUAL_NOTES_PATH: workspace.notesPath,
        METADATA_REVIEW_PATH: workspace.reviewPath,
        METADATA_REVIEW_LOCK_PATH: workspace.lockPath,
      },
      encoding: "utf8",
    });
    assert.equal(cli.status, 1, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).publishedMode, "offline-base");
    assert.ok(JSON.parse(fs.readFileSync(workspace.indexPath, "utf8")).items.every((item) => item.tags.length === 0));
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("external payload excludes private fields and local paths", async () => {
  const workspace = createWorkspace([bookmark("private", "", "private", "private")], {
    notes: { generatedAt: "2026-07-11T10:00:00.000Z", source: "visual-bookmarks-grid manual lightbox notes", notes: {} },
  });
  try {
    const result = await buildIndex(buildOptions(workspace, {
      enricherPath: path.join(INDEX_FIXTURES, "enricher-privacy.mjs"),
      allowExternalEnrichment: true,
      generatedAt: "2026-07-11T10:00:00.000Z",
    }));
    assert.equal(result.summary.ok, true);
    assert.equal(result.summary.enrichmentFailed, 0);
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("external payload omits signed, IP-literal, special-purpose, and internal media URLs without DNS", () => {
  const makeItem = (url) => ({
    id: "visual:v1:test", title: "", description: "", categories: [], styles: [], colors: [], interactions: [], visible: [], tags: [],
    media: { type: "photo", url, width: null, height: null },
  });
  const safe = "https://cdn.public-media.co.uk/image.webp";
  const safeWithRootDot = [
    "https://cdn.public-media.co.uk./image.webp",
    "https://cdn.public-media.co.uk%2e/image.webp",
  ];
  const blocked = [
    "https://cdn.public-media.co.uk/image.webp?signature=opaque&credential=opaque",
    "https://cdn.public-media.co.uk/image.webp#fragment",
    "https://opaque:opaque@cdn.public-media.co.uk/image.webp",
    "http://127.0.0.1/image.webp",
    "http://10.12.0.8/image.webp",
    "http://192.0.2.8/image.webp",
    "http://198.51.100.8/image.webp",
    "http://8.8.8.8/image.webp",
    "http://[::1]/image.webp",
    "http://[::2]/image.webp",
    "http://[4000::1]/image.webp",
    "http://[fd00::1]/image.webp",
    "http://[fec0::1]/image.webp",
    "http://[feff::1]/image.webp",
    "http://[2001:db8::8]/image.webp",
    "http://[2001:4860:4860::8888]/image.webp",
    "http://[64:ff9b::192.0.2.8]/image.webp",
    "http://[64:ff9b:1::8]/image.webp",
    "http://[100::8]/image.webp",
    "http://[100:0:0:1::8]/image.webp",
    "http://[2001:2::8]/image.webp",
    "http://[2002::8]/image.webp",
    "http://[2620:4f:8000::8]/image.webp",
    "http://[3fff::8]/image.webp",
    "http://[3fff:0fff::8]/image.webp",
    "http://[5f00::8]/image.webp",
    "http://[ff00::8]/image.webp",
    "http://localhost/image.webp",
    "https://printer.home.arpa/image.webp",
    "https://subdomain.invalid/image.webp",
    "https://preview.test/image.webp",
    "https://cdn.example/image.webp",
    "https://cdn.example.com/image.webp",
    "https://cdn.example.net/image.webp",
    "https://cdn.example.org/image.webp",
    "https://hidden-service.onion/image.webp",
    "https://resolver.arpa/image.webp",
    "https://ipv4only.arpa/image.webp",
    "https://1.0.0.10.in-addr.arpa/image.webp",
    "https://8.e.f.ip6.arpa/image.webp",
    "https://preview.internal/image.webp",
    "https://asset.local/image.webp",
    "https://home.arpa../image.webp",
    "https://home.arpa%2e%2e/image.webp",
    "https://sub.invalid../image.webp",
    "https://sub.invalid%2E%2e/image.webp",
    "https://localhost../image.webp",
    "https://localhost%2e%2e/image.webp",
    "https://127.0.0.1../image.webp",
    "https://127.0.0.1%2e%2e/image.webp",
    "https://10.0.0.1../image.webp",
    "https://10.0.0.1%2e%2e/image.webp",
    "https://a..public-media.co.uk/image.webp",
    "https://.public-media.co.uk/image.webp",
    "https://%2epublic-media.co.uk/image.webp",
    "https://.localhost/image.webp",
    "https://%2elocalhost/image.webp",
  ];
  assert.equal(privacyBoundedRecord(makeItem(safe)).media.url, safe);
  for (const url of safeWithRootDot) assert.equal(privacyBoundedRecord(makeItem(url)).media.url, url);
  for (const url of [
    "https://localhost-not-private.com/image.webp",
    "https://home.arpa-not-private.com/image.webp",
    "https://notexample.com/image.webp",
    "https://onion-ring.com/image.webp",
  ]) assert.equal(privacyBoundedRecord(makeItem(url)).media.url, url);
  for (const url of blocked) assert.equal(privacyBoundedRecord(makeItem(url)).media.url, "", url);
});

test("imported and external precedence preserves every Bet Two field contract", async () => {
  const imported = bookmark("imported", "Base title", "imported", "imported", {
    sourcePlatform: "Base source", authorName: "Base creator", authorHandle: "base-handle", authorAvatar: "https://example.com/avatar.webp",
    bookmarkedAt: "2026-07-01T10:00:00.000Z", collections: ["Base collection"], categories: ["Base category"], styles: ["Base style"],
    colors: ["Base color"], interactions: ["Base interaction"], visible: ["Base visible"], tags: ["Base tag"],
  });
  const empty = bookmark("external", "", "external", "external", {
    sourcePlatform: "", authorName: "", authorHandle: "", authorAvatar: "", categories: [], styles: [], colors: [], interactions: [], visible: [], tags: [],
  });
  const workspace = createWorkspace([imported, empty], {
    cards: { cards: [{
      mediaId: "imported-card", title: "Card title", description: "Card description", source: "Card source", creator: "Card creator",
      category: "Card category", style: "Card style", color: "Card color", interaction: "Card interaction", visibleText: "Card visible",
      collection: "Card collection", tags: ["Card tag"], media: { type: "photo", url: "assets/imported.webp" }, tweet: { id: "imported" },
    }] },
  });
  try {
    const result = await buildIndex(buildOptions(workspace, {
      enricherPath: "/configured/fixture.mjs", allowExternalEnrichment: true, generatedAt: "2026-07-11T10:00:00.000Z",
      enrich: async (record) => {
        if (!record.title) {
          return {
            patch: {
              title: "External title", description: "External description", categories: ["External category"], styles: ["External style"],
              colors: ["External color"], interactions: ["External interaction"], visible: ["External visible"], tags: ["External tag"],
            },
            provenance: {
              title: "fixture-enricher", description: "fixture-enricher", categories: "fixture-enricher", styles: "fixture-enricher",
              colors: "fixture-enricher", interactions: "fixture-enricher", visible: "fixture-enricher", tags: "fixture-enricher",
            },
          };
        }
        return { patch: {}, provenance: {} };
      },
    }));
    const importedItem = result.index.items.find((item) => item.sourceRecordId === "imported");
    const externalItem = result.index.items.find((item) => item.sourceRecordId === "external");
    assert.equal(importedItem.title, "Card title");
    assert.equal(importedItem.description, "Card description");
    assert.equal(importedItem.sourceName, "Base source");
    assert.equal(importedItem.creatorName, "Base creator");
    assert.equal(importedItem.creatorHandle, "base-handle");
    assert.equal(importedItem.creatorAvatarUrl, "https://example.com/avatar.webp");
    assert.deepEqual(importedItem.collections, ["Base collection"]);
    assert.deepEqual(importedItem.categories, ["Base category", "Card category"]);
    assert.deepEqual(importedItem.styles, ["Base style", "Card style"]);
    assert.deepEqual(importedItem.colors, ["Base color", "Card color"]);
    assert.deepEqual(importedItem.interactions, ["Base interaction", "Card interaction"]);
    assert.deepEqual(importedItem.visible, ["Base visible", "Card visible"]);
    assert.deepEqual(importedItem.tags, ["Base tag", "Card tag"]);
    for (const field of ["title", "description", "categories", "styles", "colors", "interactions", "visible", "tags"]) {
      assert.ok(externalItem[field].length > 0);
      assert.deepEqual(externalItem.provenance[field], ["fixture-enricher"]);
    }
    assert.equal(result.summary.enrichmentApplied, 1);
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("external timeouts stay live in an idle child, abort the record, and publish only the offline base", () => {
  const workspace = createWorkspace([bookmark("timeout", "Timeout fixture")]);
  const marker = path.join(workspace.directory, "aborted.txt");
  try {
    const child = spawnSync(process.execPath, ["-e", `
      const { buildIndex } = require(${JSON.stringify(path.join(ROOT, "lib", "catalog", "index-pipeline.js"))});
      buildIndex({
        rootDir: ${JSON.stringify(ROOT)},
        bookmarksPath: process.env.BOOKMARKS_PATH,
        cardsPath: process.env.MEDIA_CARDS_PATH,
        webClipsPath: process.env.WEB_CLIPS_PATH,
        notesPath: process.env.MANUAL_NOTES_PATH,
        indexPath: process.env.INSPIRATION_INDEX_PATH,
        enricherPath: ${JSON.stringify(path.join(INDEX_FIXTURES, "enricher-timeout.mjs"))},
        allowExternalEnrichment: true,
        timeoutMs: 25,
        generatedAt: "2026-07-11T10:00:00.000Z",
      }).then(({ summary }) => process.stdout.write(JSON.stringify(summary)));
    `], {
      cwd: ROOT,
      env: {
        ...process.env,
        ENRICHER_ABORT_MARKER: marker,
        INSPIRATION_INDEX_PATH: workspace.indexPath,
        BOOKMARKS_PATH: workspace.bookmarksPath,
        MEDIA_CARDS_PATH: workspace.cardsPath,
        WEB_CLIPS_PATH: workspace.webClipsPath,
        MANUAL_NOTES_PATH: workspace.notesPath,
        METADATA_REVIEW_PATH: workspace.reviewPath,
        METADATA_REVIEW_LOCK_PATH: workspace.lockPath,
      },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    const summary = JSON.parse(child.stdout);
    assert.equal(summary.ok, false);
    assert.equal(summary.failures[0].reason, "enrichment_timeout");
    assert.equal(summary.publishedMode, "offline-base");
    assert.equal(fs.readFileSync(marker, "utf8"), "aborted\n");
    assert.equal(JSON.parse(fs.readFileSync(workspace.indexPath, "utf8")).items[0].title, "Timeout fixture");
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("invalid overwrites roll back and failure summaries remain bounded and opaque", async () => {
  const records = Array.from({ length: 60 }, (_, index) => bookmark(`bounded-${index}`, `Record ${index}`));
  const catalog = buildCatalog({
    bookmarksPayload: { bookmarks: records }, cardsPayload: { cards: [] }, generatedAt: "2026-07-11T10:00:00.000Z",
  });
  const base = createIndexDocument(catalog);
  const invalid = await runExternalEnrichment(base, async () => ({
    patch: { title: "Overwrite" }, provenance: { title: "fixture-enricher" },
  }), { timeoutMs: 100 });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.applied, 0);
  assert.deepEqual(invalid.index.items, base.items);

  const bounded = await runExternalEnrichment(base, async () => {
    throw new Error("PRIVATE_PROVIDER_RESPONSE");
  }, { timeoutMs: 100 });
  assert.equal(bounded.failed, 60);
  assert.equal(bounded.failures.length, 50);
  assert.equal(bounded.failuresOmitted, 10);
  assert.ok(bounded.failures.every((failure) => /^visual:v1:[0-9a-f]{64}$/.test(failure.id)));
  assert.ok(!JSON.stringify(bounded).includes("PRIVATE_PROVIDER_RESPONSE"));
});

test("generated index is exactly ignored and remains outside static serving", () => {
  const ignored = spawnSync("git", ["check-ignore", "inspiration-index.json"], {
    cwd: ROOT, encoding: "utf8",
  });
  assert.equal(ignored.status, 0, ignored.stderr);
  assert.equal(ignored.stdout.trim(), "inspiration-index.json");
  const serverSource = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const staticBlock = serverSource.slice(
    serverSource.indexOf("const ALLOWED_STATIC_FILES"),
    serverSource.indexOf("const ALLOWED_CLIP_ASSET_EXTENSIONS")
  );
  assert.equal(staticBlock.includes("inspiration-index.json"), false);
});

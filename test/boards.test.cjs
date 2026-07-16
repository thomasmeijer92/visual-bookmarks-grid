const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");

const { buildCatalog, loadBootstrapCatalog } = require("../lib/catalog/bootstrap");
const { canonicalizeAbsoluteUrl, canonicalizeMediaUrl } = require("../lib/catalog/canonical");
const { createIndexDocument } = require("../lib/catalog/index-pipeline");
const {
  applyAcceptedPatches,
  reconcileReviewState,
  transition,
} = require("../lib/catalog/review-queue");
const browserLoader = require("../browser-loader");
const { CatalogResolverError, resolveCatalogSelectors } = require("../lib/catalog/resolver");
const {
  BoardError,
  addBoardItem,
  atomicWriteBoardDocument,
  createBoard,
  deleteBoard,
  exportBoard,
  getBoardDetail,
  listBoards,
  readBoardDocument,
  removeBoardItem,
  reorderBoardItems,
  updateBoard,
  updateCurationNote,
} = require("../lib/catalog/boards");

const ROOT = path.resolve(__dirname, "..");

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "visual-bookmarks-grid-boards-"));
  const boardsPath = path.join(root, "boards.json");
  return { root, boardsPath, lockPath: path.join(root, "boards.lock") };
}

function cleanup(files) {
  fs.rmSync(files.root, { recursive: true, force: true });
}

function fixtureCatalog() {
  return loadBootstrapCatalog({ rootDir: ROOT, generatedAt: "2026-07-13T10:00:00.000Z" });
}

function boardOptions(files, catalog, extra = {}) {
  return { boardsPath: files.boardsPath, lockPath: files.lockPath, catalog, now: "2026-07-13T10:00:00.000Z", ...extra };
}

test("resolver preserves request order, aliases, duplicate status, and opaque mismatches", () => {
  const catalog = fixtureCatalog();
  const first = catalog.items[0];
  const alias = catalog.resolverAliases.find((row) => row.catalogId === first.id);
  const result = resolveCatalogSelectors(catalog, {
    items: [
      {
        clientKey: "native",
        sourceType: alias.sourceType,
        sourceRecordId: alias.sourceRecordId,
        sourceUrl: alias.sourceUrl,
        primaryMediaUrl: alias.mediaUrl,
      },
      {
        clientKey: "same-record",
        sourceType: alias.sourceType,
        sourceRecordId: alias.sourceRecordId,
        primaryMediaUrl: alias.mediaUrl,
      },
      {
        clientKey: "wrong-media",
        sourceType: alias.sourceType,
        sourceRecordId: alias.sourceRecordId,
        primaryMediaUrl: "assets/sample-branding.svg",
      },
      {
        clientKey: "wrong-source",
        sourceType: alias.sourceType,
        sourceRecordId: alias.sourceRecordId,
        sourceUrl: "https://example.com/not-this-record",
        primaryMediaUrl: alias.mediaUrl,
      },
    ],
  });
  assert.deepEqual(result.items.map((entry) => entry.status), ["resolved", "duplicate", "primary_media_mismatch", "source_url_mismatch"]);
  assert.equal(result.items[0].catalogId, first.id);
  assert.equal(result.items[1].duplicateOfClientKey, "native");
  assert.equal("catalogId" in result.items[2], false);
  assert.equal("catalogId" in result.items[3], false);
});

test("resolver handles native ambiguity, media aliases, and image-zero mismatches without leaking candidates", () => {
  const catalog = fixtureCatalog();
  const row = structuredClone(catalog.resolverAliases[0]);
  const secondId = catalog.items.find((item) => item.id !== row.catalogId).id;
  const mediaAlias = "fixture-card-media-alias";
  row.mediaIdAliases = [...new Set([...row.mediaIdAliases, mediaAlias])].sort();
  const ambiguous = { ...structuredClone(row), catalogId: secondId };
  const ambiguousCatalog = { ...catalog, resolverAliases: [row, ambiguous, ...catalog.resolverAliases.slice(1)] };
  const results = resolveCatalogSelectors(ambiguousCatalog, { items: [
    { clientKey: "ambiguous", sourceType: row.sourceType, sourceRecordId: row.sourceRecordId, primaryMediaId: mediaAlias, primaryMediaUrl: row.mediaUrl },
  ] });
  assert.deepEqual(results.items, [{ clientKey: "ambiguous", status: "ambiguous" }]);
  assert.equal(JSON.stringify(results).includes(row.catalogId), false);

  const aliasResult = resolveCatalogSelectors({ ...catalog, resolverAliases: [row, ...catalog.resolverAliases.slice(1)] }, { items: [
    { clientKey: "media-alias", sourceType: row.sourceType, sourceRecordId: row.sourceRecordId, primaryMediaId: mediaAlias, primaryMediaUrl: row.mediaUrl },
  ] });
  assert.equal(aliasResult.items[0].catalogId, row.catalogId);

  const multiImage = buildCatalog({
    bookmarksPayload: { bookmarks: [{
      id: "multi-image-record",
      text: "Multi-image reference",
      url: "https://example.com/multi-image",
      images: [
        { id: "primary-image", type: "photo", url: "assets/primary-image.webp", width: 1200, height: 900 },
        { id: "secondary-image", type: "photo", url: "assets/secondary-image.webp", width: 1200, height: 900 },
      ],
    }] },
    cardsPayload: { cards: [] },
    generatedAt: "2026-07-13T10:00:00.000Z",
  });
  const mismatch = resolveCatalogSelectors(multiImage, { items: [{
    clientKey: "secondary-image",
    sourceType: "bookmark",
    sourceRecordId: "multi-image-record",
    primaryMediaId: "secondary-image",
    primaryMediaUrl: "assets/secondary-image.webp",
  }] });
  assert.deepEqual(mismatch.items, [{ clientKey: "secondary-image", status: "primary_media_mismatch" }]);
});

test("board state paths are exact ignored root artifacts", () => {
  for (const candidate of ["boards.json", "boards.json.tmp-check", "boards.lock", "boards.lock/owner-" + "a".repeat(64) + ".json", "boards.lock.tmp-check", "boards.lock.stale-check"]) {
    const result = spawnSync("git", ["check-ignore", "-q", candidate], { cwd: ROOT });
    assert.equal(result.status, 0, `${candidate} must be ignored`);
  }
  for (const candidate of ["nested/boards.json", "nested/boards.lock", "nested/boards.json.tmp-check", "nested/boards.lock.stale-check"]) {
    const result = spawnSync("git", ["check-ignore", "-q", candidate], { cwd: ROOT });
    assert.equal(result.status, 1, `${candidate} must not match root-only board ignores`);
  }
});

test("browser loader selects the same URL outcomes and preserves native hints without hashing", () => {
  const clips = [
    { id: "clip-native", canonicalUrl: "https://example.com/reference", sourceUrl: "https://example.com/captured", media: { url: "/assets/clips/example/image.webp" } },
    { canonicalUrl: "not a URL", sourceUrl: "https://example.com/raw", media: { url: "assets/clips/example/image.webp" } },
    { canonicalUrl: "not a URL", sourceUrl: "not a URL", media: { url: "assets/clips/example/image.webp" } },
  ];
  assert.equal(browserLoader.selectedWebClipSource(clips[0]), canonicalizeAbsoluteUrl(clips[0].canonicalUrl).display);
  assert.equal(browserLoader.selectedWebClipSource(clips[1]), canonicalizeAbsoluteUrl(clips[1].sourceUrl).display);
  assert.equal(browserLoader.selectedWebClipSource(clips[2]), "");
  const noNative = browserLoader.webClipRuntimeHints(clips[1]);
  assert.equal(noNative.sourceRecordId, "");
  const selector = browserLoader.resolverSelectorForRuntime({
    ...noNative,
    images: [{ url: "/assets/clips/example/image.webp" }],
  }, "web-clip-without-native-id");
  assert.deepEqual(selector, {
    clientKey: "web-clip-without-native-id",
    sourceType: "web-clip",
    sourceUrl: "https://example.com/raw",
    primaryMediaUrl: "/assets/clips/example/image.webp",
  });
  assert.equal(canonicalizeMediaUrl(selector.primaryMediaUrl).key, canonicalizeMediaUrl("assets/clips/example/image.webp").key);
  assert.equal(browserLoader.resolverSelectorForRuntime({ ...noNative, images: [{ url: "/assets/%25252e%25252e/private.webp" }] }, "invalid"), null);
});

test("browser and server reject the complete bounded local-media URL matrix before lookup", () => {
  const invalidMediaUrls = [
    "//assets.example/image.webp",
    "/other/image.webp",
    "/assets/../image.webp",
    "/assets/%2e%2e/image.webp",
    "/assets/%252e%252e/image.webp",
    "/assets/%25252e%25252e/image.webp",
    "/assets/clips%2fprivate/image.webp",
    "/assets/clips%252fprivate/image.webp",
    "/assets/clips%25252fprivate/image.webp",
    "/assets/clips%255cprivate/image.webp",
    "/assets/clips%25255cprivate/image.webp",
    "/assets/clips\\private/image.webp",
    "/assets/control\u0001.webp",
    "/assets/nul\u0000.webp",
    "/assets/%ZZ.webp",
    "/assets/%25252525252fprivate.webp",
  ];
  const catalog = fixtureCatalog();
  for (const primaryMediaUrl of invalidMediaUrls) {
    const runtime = {
      sourceType: "bookmark",
      sourceRecordId: "fixture-record",
      resolverSourceUrl: "https://example.com/reference",
      images: [{ url: primaryMediaUrl }],
    };
    assert.equal(browserLoader.resolverSelectorForRuntime(runtime, "invalid"), null, primaryMediaUrl);
    assert.throws(() => resolveCatalogSelectors(catalog, { items: [{
      clientKey: "invalid",
      sourceType: "bookmark",
      sourceRecordId: "fixture-record",
      sourceUrl: "https://example.com/reference",
      primaryMediaUrl,
    }] }), CatalogResolverError, primaryMediaUrl);
  }
});

test("resolver accepts no-native-id web clips only through the selected canonical URL pair", () => {
  const catalog = buildCatalog({
    bookmarksPayload: { bookmarks: [] },
    cardsPayload: { cards: [] },
    webClipsPayload: {
      clips: [{
        sourcePlatform: "Example",
        sourceUrl: "https://example.com/captured?from=clipper",
        canonicalUrl: "https://example.com/reference",
        title: "Root-relative clip",
        media: { type: "photo", url: "/assets/clips/web-example-001/image.webp", width: 1200, height: 900 },
      }],
    },
    generatedAt: "2026-07-13T10:00:00.000Z",
  });
  assert.equal(catalog.items.length, 1);
  const expected = catalog.items[0].id;
  const result = resolveCatalogSelectors(catalog, {
    items: [
      { clientKey: "root-relative", sourceType: "web-clip", sourceUrl: "https://example.com/reference", primaryMediaUrl: "/assets/clips/web-example-001/image.webp" },
      { clientKey: "repo-relative", sourceType: "web-clip", sourceUrl: "https://example.com/reference", primaryMediaUrl: "assets/clips/web-example-001/image.webp" },
      { clientKey: "raw-capture", sourceType: "web-clip", sourceUrl: "https://example.com/captured?from=clipper", primaryMediaUrl: "/assets/clips/web-example-001/image.webp" },
    ],
  });
  assert.equal(result.items[0].catalogId, expected);
  assert.deepEqual(result.items.slice(1), [
    { clientKey: "repo-relative", status: "duplicate", duplicateOfClientKey: "root-relative" },
    { clientKey: "raw-capture", status: "not_found" },
  ]);
  assert.throws(() => resolveCatalogSelectors(catalog, {
    items: [{ clientKey: "bad", sourceType: "web-clip", sourceUrl: "https://example.com/reference", primaryMediaUrl: "/assets/%25252e%25252e/private.webp" }],
  }), CatalogResolverError);
  const persisted = createIndexDocument(catalog);
  const persistedResult = resolveCatalogSelectors(persisted, {
    items: [{ clientKey: "persisted", sourceType: "web-clip", sourceUrl: "https://example.com/reference", primaryMediaUrl: "assets/clips/web-example-001/image.webp" }],
  });
  assert.equal(persistedResult.items[0].catalogId, expected);
});

test("resolver rejects over-limit, duplicate, and malformed selector requests before lookup", () => {
  const catalog = fixtureCatalog();
  const alias = catalog.resolverAliases[0];
  const selector = { clientKey: "same", sourceType: alias.sourceType, sourceRecordId: alias.sourceRecordId, primaryMediaUrl: alias.mediaUrl };
  assert.throws(() => resolveCatalogSelectors(catalog, { items: [selector, selector] }), CatalogResolverError);
  assert.throws(() => resolveCatalogSelectors(catalog, { items: Array.from({ length: 51 }, (_, index) => ({ ...selector, clientKey: `key-${index}` })) }), CatalogResolverError);
  const exactLimit = resolveCatalogSelectors(catalog, { items: Array.from({ length: 50 }, (_, index) => ({ ...selector, clientKey: `key-${index}` })) });
  assert.equal(exactLimit.items.length, 50);
  assert.equal(exactLimit.items[0].status, "resolved");
  assert.ok(exactLimit.items.slice(1).every((entry) => entry.status === "duplicate"));
  assert.throws(() => resolveCatalogSelectors(catalog, { items: [{ ...selector, sourceUrl: "//example.com" }] }), CatalogResolverError);
});

test("accepted review metadata and a saved board survive duplicate-owner rebuild transitions", () => {
  const files = workspace();
  const notesPath = path.join(files.root, "manual-media-notes.json");
  const reviewPath = path.join(files.root, "metadata-review.json");
  try {
    const bookmark = (id, title) => ({
      id,
      text: title,
      url: "https://example.com/stable-pair",
      images: [{ id: `${id}-media`, type: "photo", url: "assets/stable-pair.webp", width: 1200, height: 900 }],
    });
    const build = (records) => buildCatalog({
      bookmarksPayload: { bookmarks: records }, cardsPayload: { cards: [] }, generatedAt: "2026-07-13T10:00:00.000Z",
    });
    const low = bookmark("z-lower-owner", "Lower owner");
    const high = bookmark("a-higher-owner", "Higher owner");
    const initial = build([low]);
    const itemId = initial.items[0].id;
    const mediaId = initial.items[0].mediaId;
    const note = {
      mediaId, recordId: itemId, tweetId: "", tweetUrl: "", mediaUrl: "", titleAtEdit: "", creatorAtEdit: "",
      note: "Apply stable metadata", status: "needs_agent_review",
      createdAt: "2026-07-13T10:00:00.000Z", updatedAt: "2026-07-13T10:00:00.000Z",
    };
    fs.writeFileSync(notesPath, `${JSON.stringify({ generatedAt: "2026-07-13T10:00:00.000Z", source: "visual-bookmarks-grid manual lightbox notes", notes: { [mediaId]: note } })}\n`);
    const reviewOptions = { notesPath, reviewPath, catalog: initial };
    const review = reconcileReviewState(reviewOptions).document.entries[0];
    transition(review.id, "resolve", { patch: { tags: ["Accepted correction"] } }, { ...reviewOptions, now: "2026-07-13T10:01:00.000Z" });
    const acceptedInitial = applyAcceptedPatches(createIndexDocument(initial), reconcileReviewState(reviewOptions).document);
    const board = createBoard({ name: "Stable board", items: [{ itemId }] }, boardOptions(files, acceptedInitial));

    const withHigherBase = build([low, high]);
    const withHigherReview = reconcileReviewState({ ...reviewOptions, catalog: withHigherBase }).document;
    const withHigher = applyAcceptedPatches(createIndexDocument(withHigherBase), withHigherReview);
    assert.equal(withHigher.items[0].id, itemId);
    assert.deepEqual(withHigher.items[0].tags, ["Accepted correction"]);
    assert.equal(getBoardDetail(board.id, boardOptions(files, withHigher)).resolvedItems[0].status, "available");
    const addedResolution = resolveCatalogSelectors(withHigher, { items: [
      { clientKey: "higher-native", sourceType: "bookmark", sourceRecordId: high.id, primaryMediaUrl: high.images[0].url },
      { clientKey: "original-pair", sourceType: "bookmark", sourceUrl: low.url, primaryMediaUrl: low.images[0].url },
    ] });
    assert.equal(addedResolution.items[0].catalogId, itemId);
    assert.equal(addedResolution.items[1].status, "duplicate");

    const restoredBase = build([low]);
    const restoredReview = reconcileReviewState({ ...reviewOptions, catalog: restoredBase }).document;
    const restored = applyAcceptedPatches(createIndexDocument(restoredBase), restoredReview);
    assert.equal(restored.items[0].id, itemId);
    assert.deepEqual(restored.items[0].tags, ["Accepted correction"]);
    assert.equal(getBoardDetail(board.id, boardOptions(files, restored)).resolvedItems[0].status, "available");
    const removedResolution = resolveCatalogSelectors(restored, { items: [
      { clientKey: "original-pair", sourceType: "bookmark", sourceUrl: low.url, primaryMediaUrl: low.images[0].url },
      { clientKey: "removed-native", sourceType: "bookmark", sourceRecordId: high.id, primaryMediaUrl: high.images[0].url },
    ] });
    assert.equal(removedResolution.items[0].catalogId, itemId);
    assert.deepEqual(removedResolution.items[1], { clientKey: "removed-native", status: "not_found" });
  } finally {
    cleanup(files);
  }
});

test("boards keep ordered stored references while resolved detail and exports retain unavailable entries", () => {
  const files = workspace();
  try {
    const catalog = fixtureCatalog();
    const catalogBefore = JSON.stringify(catalog);
    const sourcePath = path.join(ROOT, "bookmarks-data.sample.json");
    const sourceBefore = fs.readFileSync(sourcePath);
    const [first, second] = catalog.items;
    const created = createBoard({
      name: "Reference board",
      brief: "A bounded test brief.",
      querySnapshot: { query: "reference", filters: {}, limit: 8 },
      items: [
        { itemId: first.id, curationNote: "First note", matchReasonsAtSave: ["title: reference"] },
        { itemId: second.id, matchReasonsAtSave: ["style: Minimal"] },
      ],
    }, boardOptions(files, catalog));
    assert.equal(created.items.length, 2);
    assert.equal(listBoards({}, boardOptions(files, catalog)).boards[0].availableCount, 2);
    updateBoard(created.id, { name: "Updated reference board", brief: "Updated brief" }, boardOptions(files, catalog));
    updateCurationNote(created.id, second.id, "Second note", boardOptions(files, catalog));
    reorderBoardItems(created.id, [second.id, first.id], boardOptions(files, catalog));
    const detail = getBoardDetail(created.id, boardOptions(files, catalog));
    assert.deepEqual(detail.resolvedItems.map((entry) => entry.itemId), [second.id, first.id]);
    assert.equal(detail.resolvedItems[0].curationNote, "Second note");
    const missingCatalog = { ...catalog, items: [first] };
    const missing = getBoardDetail(created.id, boardOptions(files, missingCatalog));
    assert.deepEqual(missing.resolvedItems.map((entry) => entry.status), ["unavailable", "available"]);
    assert.match(exportBoard(created.id, "markdown", boardOptions(files, missingCatalog)).content, /Unavailable reference/);
    assert.match(exportBoard(created.id, "json", boardOptions(files, missingCatalog)).content, /unavailable/);
    removeBoardItem(created.id, first.id, boardOptions(files, catalog));
    assert.equal(getBoardDetail(created.id, boardOptions(files, catalog)).board.items.length, 1);
    assert.deepEqual(deleteBoard(created.id, boardOptions(files, catalog)), { id: created.id, deleted: true });
    assert.equal(listBoards({}, boardOptions(files, catalog)).total, 0);
    assert.equal(JSON.stringify(catalog), catalogBefore);
    assert.deepEqual(fs.readFileSync(sourcePath), sourceBefore);
  } finally {
    cleanup(files);
  }
});

test("Markdown board exports escape untrusted text while retaining safe source destinations", () => {
  const files = workspace();
  try {
    const catalog = structuredClone(fixtureCatalog());
    const item = catalog.items[0];
    item.title = "Title [link](javascript:alert(1)) <script>& `code`";
    item.sourceUrl = "https://example.com/kept-(destination)?q=(value)";
    const board = createBoard({
      name: "Board [name] <tag> & *format*",
      brief: "Brief ![image](x) <iframe> & text",
      items: [{ itemId: item.id, matchReasonsAtSave: ["Reason [label](x) <b> & _style_"] }],
    }, boardOptions(files, catalog));
    const markdown = exportBoard(board.id, "markdown", boardOptions(files, catalog)).content;
    assert.ok(markdown.startsWith("# Board \\[name\\] &lt;tag&gt; &amp; \\*format\\*"));
    assert.ok(markdown.includes("Brief \\!\\[image\\]\\(x\\) &lt;iframe&gt; &amp; text"));
    assert.ok(markdown.includes("Title \\[link\\]\\(javascript:alert\\(1\\)\\) &lt;script&gt;&amp; \\`code\\`"));
    assert.ok(markdown.includes("Reason \\[label\\]\\(x\\) &lt;b&gt; &amp; \\_style\\_"));
    assert.equal(markdown.includes("<script>"), false);
    assert.equal(markdown.includes("[link](javascript:"), false);
    assert.match(markdown, /\[Source\]\(<https:\/\/example\.com\/kept-\(destination\)\?q=\(value\)>\)/);
  } finally {
    cleanup(files);
  }
});

test("board mutations reject missing and duplicate catalog ids without changing state", () => {
  const files = workspace();
  try {
    const catalog = fixtureCatalog();
    const [first] = catalog.items;
    assert.throws(() => createBoard({ name: "Invalid", items: [{ itemId: "visual:v1:" + "f".repeat(64) }] }, boardOptions(files, catalog)), BoardError);
    assert.equal(fs.existsSync(files.boardsPath), false);
    const created = createBoard({ name: "Valid", items: [{ itemId: first.id }] }, boardOptions(files, catalog));
    assert.throws(() => addBoardItem(created.id, { itemId: first.id }, boardOptions(files, catalog)), BoardError);
    assert.equal(readBoardDocument(files.boardsPath).boards[0].items.length, 1);
  } finally {
    cleanup(files);
  }
});

test("board locks are bounded and atomic failure boundaries preserve valid complete state", () => {
  const files = workspace();
  try {
    const catalog = fixtureCatalog();
    const [first] = catalog.items;
    const created = createBoard({ name: "Initial", items: [{ itemId: first.id }] }, boardOptions(files, catalog));
    const before = fs.readFileSync(files.boardsPath, "utf8");
    const document = readBoardDocument(files.boardsPath);
    document.boards[0].name = "Replacement";
    for (const hook of ["beforeTempWrite", "beforeTempFlush", "beforeRename"]) {
      assert.throws(() => atomicWriteBoardDocument(files.boardsPath, document, { [hook]: () => { throw new Error(hook); } }), BoardError);
      assert.equal(fs.readFileSync(files.boardsPath, "utf8"), before);
      assert.equal(fs.readdirSync(files.root).some((name) => name.startsWith("boards.json.tmp-")), false);
    }
    assert.throws(() => atomicWriteBoardDocument(files.boardsPath, document, { beforeDirectorySync: () => { throw new Error("fail after replace"); } }), BoardError);
    assert.equal(readBoardDocument(files.boardsPath).boards[0].name, "Replacement");
    updateBoard(created.id, { brief: "Release failure is bounded" }, {
      ...boardOptions(files, catalog),
      releaseLock: (lockPath, owner) => {
        require("../lib/catalog/boards").releaseBoardLock(lockPath, owner);
        throw new Error("release failed after ownership-safe release");
      },
    });
    assert.equal(readBoardDocument(files.boardsPath).boards[0].brief, "Release failure is bounded");
    fs.mkdirSync(files.lockPath);
    fs.writeFileSync(path.join(files.lockPath, `owner-${"a".repeat(64)}.json`), JSON.stringify({ schemaVersion: 1, pid: process.pid, createdAt: Date.now(), token: "a".repeat(64) }));
    assert.throws(() => updateBoard(created.id, { brief: "Blocked" }, boardOptions(files, catalog)), (error) => error instanceof BoardError && error.code === "boards_busy");
    fs.rmSync(files.lockPath, { recursive: true, force: true });
    fs.mkdirSync(files.lockPath);
    fs.writeFileSync(path.join(files.lockPath, "broken"), "broken");
    const stale = new Date(Date.now() - 61_000);
    fs.utimesSync(files.lockPath, stale, stale);
    updateBoard(created.id, { brief: "Recovered" }, boardOptions(files, catalog));
    assert.equal(readBoardDocument(files.boardsPath).boards[0].brief, "Recovered");
  } finally {
    cleanup(files);
  }
});

test("lock-free readers observe only complete old or new board documents during atomic replacement", async () => {
  const files = workspace();
  try {
    const catalog = fixtureCatalog();
    const created = createBoard({ name: "Old", items: [{ itemId: catalog.items[0].id }] }, boardOptions(files, catalog));
    const modulePath = path.join(ROOT, "lib/catalog/boards.js");
    const writer = spawn(process.execPath, ["-e", `
      const { atomicWriteBoardDocument, readBoardDocument } = require(${JSON.stringify(modulePath)});
      const target = ${JSON.stringify(files.boardsPath)};
      for (let index = 0; index < 80; index++) {
        const document = readBoardDocument(target);
        document.boards[0].name = index % 2 ? "Old" : "New";
        atomicWriteBoardDocument(target, document);
      }
    `], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    writer.stderr.on("data", (chunk) => { stderr += chunk; });
    const closed = new Promise((resolve) => writer.once("close", resolve));
    const observed = new Set();
    while (writer.exitCode === null) {
      const document = readBoardDocument(files.boardsPath);
      assert.equal(document.boards[0].id, created.id);
      assert.ok(["Old", "New"].includes(document.boards[0].name));
      observed.add(document.boards[0].name);
      await new Promise((resolve) => setImmediate(resolve));
    }
    const exitCode = await closed;
    assert.equal(exitCode, 0, stderr);
    assert.ok(observed.size >= 1);
  } finally {
    cleanup(files);
  }
});

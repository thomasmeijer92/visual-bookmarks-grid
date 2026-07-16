const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");

const { buildCatalog } = require("../lib/catalog/bootstrap");
const { buildIndex } = require("../lib/catalog/index-pipeline");
const { searchCatalog } = require("../lib/search");
const {
  ReviewQueueError,
  MAX_REVIEW_EVENTS,
  acquireLock,
  applyAcceptedPatches,
  listReviewEntries,
  mutateManualNote,
  releaseLock,
  reconcileReviewState,
  transition,
  validateManualNotesPayload,
  validateReviewDocument,
} = require("../lib/catalog/review-queue");

const ROOT = path.resolve(__dirname, "..");
const fixed = "2026-07-12T10:00:00.000Z";
const REVIEW_FIXTURES = path.join(__dirname, "fixtures", "review");
const readReviewFixture = (name) => fs.readFileSync(path.join(REVIEW_FIXTURES, name));

function startServer(environment) {
  return new Promise((resolve, reject) => {
    const reviewPath = environment.METADATA_REVIEW_PATH || path.join(os.tmpdir(), `review-server-${process.pid}-${Date.now()}.json`);
    const child = spawn(process.execPath, ["server.js"], {
      cwd: ROOT,
      env: {
        ...process.env,
        GRID_HOST: "127.0.0.1",
        GRID_PORT: "0",
        PORT: "0",
        METADATA_REVIEW_PATH: reviewPath,
        METADATA_REVIEW_LOCK_PATH: environment.METADATA_REVIEW_LOCK_PATH || reviewPath.replace(/\.json$/, ".lock"),
        ...environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const inspect = (chunk) => {
      output += chunk;
      const match = output.match(/Server running at http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) resolve({ child, output, port: Number(match[1]) });
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Server exited before startup (${code}): ${output}`)));
  });
}

function requestJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: pathname }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try { resolve({ status: response.statusCode, json: JSON.parse(body || "{}") }); } catch (error) { reject(error); }
      });
    });
    request.once("error", reject);
  });
}

function bookmark(id = "review-record", suffix = id) {
  return {
    id,
    text: "Imported interface title",
    url: `https://example.com/${suffix}`,
    images: [{ id: `${id}-media`, type: "photo", url: `assets/${suffix}.webp`, width: 1200, height: 900 }],
  };
}

function catalog(records = [bookmark()]) {
  return buildCatalog({ bookmarksPayload: { bookmarks: records }, cardsPayload: { cards: [] }, generatedAt: fixed });
}

function workspace() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "metadata-review-test-"));
  return {
    directory,
    notesPath: path.join(directory, "manual-media-notes.json"),
    reviewPath: path.join(directory, "metadata-review.json"),
    lockPath: path.join(directory, "metadata-review.lock"),
    bookmarksPath: path.join(directory, "bookmarks.json"),
    cardsPath: path.join(directory, "cards.json"),
    clipsPath: path.join(directory, "clips.json"),
    indexPath: path.join(directory, "inspiration-index.json"),
  };
}

function writeNotes(filePath, notes) {
  fs.writeFileSync(filePath, `${JSON.stringify({ generatedAt: fixed, source: "visual-bookmarks-grid manual lightbox notes", notes })}\n`);
}

function note(recordId, mediaId, text = "Needs a closer metadata pass", updatedAt = fixed) {
  return {
    mediaId, recordId, tweetId: "", tweetUrl: "", mediaUrl: "", titleAtEdit: "", creatorAtEdit: "",
    note: text, status: "needs_agent_review", createdAt: fixed, updatedAt,
  };
}

test("review reconciliation is deterministic, idempotent, and preserves accepted patches through edit, deletion, and restore", () => {
  const files = workspace();
  try {
    const source = catalog();
    const item = source.items[0];
    writeNotes(files.notesPath, { [item.mediaId]: note(item.id, item.mediaId) });
    const options = { notesPath: files.notesPath, reviewPath: files.reviewPath, catalog: source };
    const first = reconcileReviewState(options);
    assert.equal(first.changed, true);
    assert.equal(first.document.entries.length, 1);
    const entry = first.document.entries[0];
    assert.equal(entry.status, "needs_review");
    assert.equal(entry.events.length, 1);
    assert.match(entry.id, /^review:v1:[0-9a-f]{64}$/);

    const unchanged = reconcileReviewState(options);
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.document.entries[0].events.length, 1);

    transition(entry.id, "resolve", { patch: { title: "Accepted interface title", tags: [] } }, { ...options, now: "2026-07-12T10:01:00.000Z" });
    const resolved = JSON.parse(fs.readFileSync(files.reviewPath, "utf8")).entries[0];
    assert.equal(resolved.status, "resolved");
    assert.deepEqual(resolved.acceptedPatch.patch, { tags: [], title: "Accepted interface title" });

    writeNotes(files.notesPath, { [item.mediaId]: note(item.id, item.mediaId, "Edited review feedback") });
    const edited = reconcileReviewState(options).document.entries[0];
    assert.equal(edited.status, "needs_review");
    assert.equal(edited.events.at(-1).action, "reopen");
    assert.equal(edited.events.at(-1).at, fixed);
    assert.deepEqual(edited.acceptedPatch, resolved.acceptedPatch);

    writeNotes(files.notesPath, { [item.mediaId]: note(item.id, item.mediaId, "Edited again while pending") });
    const pendingEdit = reconcileReviewState(options).document.entries[0];
    assert.equal(pendingEdit.status, "needs_review");
    assert.equal(pendingEdit.events.at(-1).reason, "source_note_updated");
    assert.equal(pendingEdit.events.at(-1).at, fixed);
    assert.equal(pendingEdit.events.length, edited.events.length + 1);
    const pendingResave = reconcileReviewState(options).document.entries[0];
    assert.equal(pendingResave.events.length, pendingEdit.events.length);

    writeNotes(files.notesPath, {});
    const deleted = reconcileReviewState(options).document.entries[0];
    assert.equal(deleted.status, "dismissed");
    assert.equal(deleted.sourcePresent, false);
    assert.equal(deleted.events.at(-1).reason, "source_note_deleted");
    assert.deepEqual(deleted.acceptedPatch, resolved.acceptedPatch);

    writeNotes(files.notesPath, { [item.mediaId]: note(item.id, item.mediaId, "Restored review feedback") });
    const restored = reconcileReviewState(options).document.entries[0];
    assert.equal(restored.status, "needs_review");
    assert.equal(restored.sourcePresent, true);
    assert.deepEqual(restored.acceptedPatch, resolved.acceptedPatch);
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test("review history compaction preserves a legal ordered replay across the 999/1000/1001 note boundary", async () => {
  const files = workspace();
  let server;
  try {
    const source = catalog();
    const item = source.items[0];
    writeNotes(files.notesPath, { [item.mediaId]: note(item.id, item.mediaId, "Boundary source note") });
    const options = { notesPath: files.notesPath, reviewPath: files.reviewPath, lockPath: files.lockPath, catalog: source };
    const intake = reconcileReviewState(options).document.entries[0];
    const seeded = JSON.parse(fs.readFileSync(files.reviewPath, "utf8"));
    seeded.entries[0].events = Array.from({ length: 999 }, (_, index) => index === 0
      ? intake.events[0]
      : { at: fixed, action: "reopen", reason: "source_note_updated" });
    validateReviewDocument(seeded);
    fs.writeFileSync(files.reviewPath, `${JSON.stringify(seeded, null, 2)}\n`);

    const assertReplayable = (entry, message) => {
      assert.ok(entry.events.length <= MAX_REVIEW_EVENTS, message);
      assert.equal(entry.events[0].action, "intake", message);
      assert.equal(entry.events[0].reason, "source_note_saved", message);
      validateReviewDocument({ schemaVersion: 1, entries: [entry] });
    };

    let entry = reconcileReviewState(options).document.entries[0];
    assert.equal(entry.events.length, 999);
    assertReplayable(entry, "999 events must remain replayable");

    const firstUpdate = mutateManualNote({ mediaId: item.mediaId, note: "Boundary update at event 1000" }, options);
    entry = firstUpdate.review.entries[0];
    assert.equal(entry.events.length, 1000);
    assert.equal(entry.events.at(-1).reason, "source_note_updated");
    assertReplayable(entry, "1000 events must remain replayable");

    const secondUpdate = mutateManualNote({ mediaId: item.mediaId, note: "Boundary update requiring event 1001" }, options);
    entry = secondUpdate.review.entries[0];
    assert.equal(entry.events.length, 1000);
    assert.equal(entry.events.at(-1).reason, "source_note_updated");
    assert.equal(JSON.parse(fs.readFileSync(files.notesPath, "utf8")).notes[item.mediaId].note, "Boundary update requiring event 1001");
    assertReplayable(entry, "the 1001st event must compact before persistence");

    entry = transition(entry.id, "resolve", { patch: { title: "Compacted accepted title" } }, { ...options, now: "2026-07-12T10:01:00.000Z" });
    assert.equal(entry.status, "resolved");
    assert.deepEqual(entry.acceptedPatch.patch, { title: "Compacted accepted title" });
    assertReplayable(entry, "resolution after compaction must retain the accepted patch");

    for (const [index, text] of ["Repeated source update one", "Repeated source update two"].entries()) {
      entry = mutateManualNote({ mediaId: item.mediaId, note: text }, options).review.entries[0];
      assert.equal(entry.status, "needs_review");
      assert.equal(entry.sourcePresent, true);
      assert.equal(entry.events.at(-1).reason, "source_note_updated");
      assert.deepEqual(entry.acceptedPatch.patch, { title: "Compacted accepted title" });
      assertReplayable(entry, `repeated update ${index} must stay replayable`);

      entry = mutateManualNote({ mediaId: item.mediaId, note: "" }, options).review.entries[0];
      assert.equal(entry.status, "dismissed");
      assert.equal(entry.sourcePresent, false);
      assert.equal(entry.events.at(-1).reason, "source_note_deleted");
      assert.deepEqual(entry.acceptedPatch.patch, { title: "Compacted accepted title" });
      assertReplayable(entry, `repeated delete ${index} must stay replayable`);

      entry = mutateManualNote({ mediaId: item.mediaId, note: `${text} restored` }, options).review.entries[0];
      assert.equal(entry.status, "needs_review");
      assert.equal(entry.sourcePresent, true);
      assert.equal(entry.events.at(-1).reason, "source_note_updated");
      assert.deepEqual(entry.acceptedPatch.patch, { title: "Compacted accepted title" });
      assertReplayable(entry, `repeated restore ${index} must stay replayable`);
    }

    const persistedBeforeRestart = fs.readFileSync(files.reviewPath);
    const restarted = reconcileReviewState(options);
    assert.equal(restarted.changed, false);
    assert.deepEqual(fs.readFileSync(files.reviewPath), persistedBeforeRestart);
    assertReplayable(restarted.document.entries[0], "restart reconciliation must be idempotent");
    assert.equal(listReviewEntries({ limit: 1, offset: 0 }, options).entries[0].events.length, restarted.document.entries[0].events.length);

    fs.writeFileSync(files.bookmarksPath, `${JSON.stringify({ bookmarks: [bookmark()] })}\n`);
    fs.writeFileSync(files.cardsPath, `${JSON.stringify({ cards: [] })}\n`);
    fs.writeFileSync(files.clipsPath, `${JSON.stringify({ clips: [] })}\n`);
    const indexed = await buildIndex({
      rootDir: ROOT,
      bookmarksPath: files.bookmarksPath,
      cardsPath: files.cardsPath,
      webClipsPath: files.clipsPath,
      notesPath: files.notesPath,
      reviewPath: files.reviewPath,
      lockPath: files.lockPath,
      indexPath: files.indexPath,
      generatedAt: fixed,
    });
    assert.equal(indexed.index.items[0].title, "Compacted accepted title");
    assertReplayable(JSON.parse(fs.readFileSync(files.reviewPath, "utf8")).entries[0], "index reconciliation must keep the compacted history legal");

    server = await startServer({
      BOOKMARKS_PATH: files.bookmarksPath,
      MEDIA_CARDS_PATH: files.cardsPath,
      MANUAL_NOTES_PATH: files.notesPath,
      METADATA_REVIEW_PATH: files.reviewPath,
      METADATA_REVIEW_LOCK_PATH: files.lockPath,
      WEB_CLIPS_PATH: files.clipsPath,
      INSPIRATION_INDEX_PATH: files.indexPath,
    });
    const restartApi = await requestJson(server.port, "/api/review-queue?limit=1&offset=0");
    assert.equal(restartApi.status, 200);
    assertReplayable(restartApi.json.entries[0], "server startup reconciliation must keep the compacted history legal");
  } finally {
    server?.child.kill();
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test("verbatim pre-PR manual-note fixtures reconcile aliases without rewriting local files", async () => {
  const files = workspace();
  let server;
  try {
    const legacyBookmark = {
      id: "fixture-notes",
      text: "Legacy note target",
      url: "https://example.com/fixture-notes",
      images: [{ id: "fixture-notes-card", type: "photo", url: "assets/fixture-notes.webp" }],
    };
    const source = buildCatalog({ bookmarksPayload: { bookmarks: [legacyBookmark] }, cardsPayload: { cards: [] }, generatedAt: fixed });
    const original = readReviewFixture("manual-notes-pre-pr-base.json");
    fs.writeFileSync(files.notesPath, original);
    const options = { notesPath: files.notesPath, reviewPath: files.reviewPath, catalog: source };
    const reconciled = reconcileReviewState(options);
    assert.equal(reconciled.document.entries.length, 1);
    assert.equal(reconciled.document.entries[0].sourcePresent, true);
    assert.deepEqual(fs.readFileSync(files.notesPath), original);

    const arrayPayload = JSON.parse(readReviewFixture("manual-notes-legacy-array.json"));
    const normalizedArray = validateManualNotesPayload(arrayPayload);
    assert.equal(normalizedArray.entries[0].mapKey, undefined);
    assert.equal(normalizedArray.entries[0].recordId, "");
    assert.equal(normalizedArray.entries[0].status, "needs_agent_review");
    assert.equal(normalizedArray.entries[0].createdAt, "2026-02-03T10:00:00.000Z");

    const rootMap = readReviewFixture("manual-notes-legacy-root-map.json");
    fs.writeFileSync(files.notesPath, rootMap);
    fs.rmSync(files.reviewPath, { force: true });
    const rootMapReconciled = reconcileReviewState(options);
    assert.equal(rootMapReconciled.document.entries.length, 1);
    assert.deepEqual(fs.readFileSync(files.notesPath), rootMap);

    const reservedSelectors = readReviewFixture("manual-notes-root-reserved-selectors.json");
    fs.writeFileSync(files.notesPath, reservedSelectors);
    fs.rmSync(files.reviewPath, { force: true });
    const reservedRootMap = reconcileReviewState(options);
    assert.equal(reservedRootMap.document.entries.length, 1);
    assert.deepEqual(fs.readFileSync(files.notesPath), reservedSelectors);
    assert.equal(validateManualNotesPayload(JSON.parse(reservedSelectors)).storageKind, "root-map");
    assert.throws(
      () => validateManualNotesPayload({ notes: note("", "fixture-notes-card"), generatedAt: fixed }),
      (error) => error instanceof ReviewQueueError && error.code === "manual_notes_invalid"
    );
    assert.throws(
      () => validateManualNotesPayload({ notes: {}, malformed: note("", "fixture-notes-card") }),
      (error) => error instanceof ReviewQueueError && error.code === "manual_notes_invalid"
    );

    fs.writeFileSync(files.bookmarksPath, `${JSON.stringify({ bookmarks: [legacyBookmark] })}\n`);
    fs.writeFileSync(files.cardsPath, `${JSON.stringify({ cards: [] })}\n`);
    fs.rmSync(files.reviewPath, { force: true });
    fs.writeFileSync(files.notesPath, original);
    server = await startServer({
      BOOKMARKS_PATH: files.bookmarksPath,
      MEDIA_CARDS_PATH: files.cardsPath,
      MANUAL_NOTES_PATH: files.notesPath,
      METADATA_REVIEW_PATH: files.reviewPath,
      METADATA_REVIEW_LOCK_PATH: files.lockPath,
    });
    const startupReview = JSON.parse(fs.readFileSync(files.reviewPath, "utf8"));
    assert.equal(startupReview.entries.length, 1);
    assert.equal(startupReview.entries[0].recordId, source.items[0].id);
    assert.deepEqual(fs.readFileSync(files.notesPath), original);
  } finally {
    server?.child.kill();
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test("manual-note GET adapts every validated legacy shape without numeric array selectors", async () => {
  const files = workspace();
  let server;
  try {
    const legacyBookmark = {
      id: "fixture-notes",
      text: "Legacy note target",
      url: "https://example.com/fixture-notes",
      images: [{ id: "fixture-notes-card", type: "photo", url: "assets/fixture-notes.webp" }],
    };
    fs.writeFileSync(files.bookmarksPath, `${JSON.stringify({ bookmarks: [legacyBookmark] })}\n`);
    fs.writeFileSync(files.cardsPath, `${JSON.stringify({ cards: [] })}\n`);
    const environment = {
      BOOKMARKS_PATH: files.bookmarksPath,
      MEDIA_CARDS_PATH: files.cardsPath,
      MANUAL_NOTES_PATH: files.notesPath,
      METADATA_REVIEW_PATH: files.reviewPath,
      METADATA_REVIEW_LOCK_PATH: files.lockPath,
    };
    for (const fixture of [
      "manual-notes-pre-pr-base.json",
      "manual-notes-legacy-array.json",
      "manual-notes-legacy-root-map.json",
      "manual-notes-root-reserved-selectors.json",
    ]) {
      const original = readReviewFixture(fixture);
      fs.writeFileSync(files.notesPath, original);
      fs.rmSync(files.reviewPath, { force: true });
      server = await startServer(environment);
      const response = await requestJson(server.port, "/api/manual-notes");
      assert.equal(response.status, 200, fixture);
      assert.equal(response.json.notes?.["fixture-notes-card"]?.note.length > 0, true, fixture);
      assert.equal(Object.keys(response.json.notes).some((key) => /^\d+$/.test(key)), false, fixture);
      assert.deepEqual(fs.readFileSync(files.notesPath), original, fixture);
      server.child.kill();
      server = null;
    }

    fs.writeFileSync(files.notesPath, `${JSON.stringify({ notes: { broken: null } })}\n`);
    server = await startServer(environment);
    const invalid = await requestJson(server.port, "/api/manual-notes");
    assert.equal(invalid.status, 500);
    assert.deepEqual(invalid.json, { ok: false, error: "Manual notes are unavailable." });
  } finally {
    server?.child.kill();
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test("manual note mutation commits the note first and a later reconciliation recovers a failed queue write", () => {
  const files = workspace();
  try {
    const source = catalog();
    const item = source.items[0];
    const options = {
      notesPath: files.notesPath,
      reviewPath: files.reviewPath,
      catalog: source,
      reviewAtomicOptions: { beforeRename: () => { throw new Error("simulated review replace failure"); } },
    };
    assert.throws(() => mutateManualNote({ mediaId: item.mediaId, note: "Durable intake note" }, options), (error) =>
      error instanceof ReviewQueueError && error.noteSaved === true && error.code === "review_reconcile_pending"
    );
    const persisted = JSON.parse(fs.readFileSync(files.notesPath, "utf8"));
    assert.equal(persisted.notes[item.mediaId].note, "Durable intake note");
    assert.equal(persisted.notes[item.mediaId].recordId, item.id);
    assert.equal(fs.existsSync(files.reviewPath), false);

    const recovered = reconcileReviewState({ notesPath: files.notesPath, reviewPath: files.reviewPath, catalog: source });
    assert.equal(recovered.document.entries.length, 1);
    assert.equal(recovered.document.entries[0].events.length, 1);
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test("mutating one legacy array note preserves unrelated resolved and unresolved entries without numeric selectors", () => {
  const files = workspace();
  try {
    const records = [
      {
        id: "numeric-array-entry",
        text: "Numeric array target",
        url: "https://example.com/numeric-array-entry",
        images: [{ id: "0", type: "photo", url: "assets/numeric-array-entry.webp" }],
      },
      bookmark("array-target"),
      bookmark("array-survivor"),
    ];
    const source = catalog(records);
    const target = source.items.find((item) => item.sourceRecordId === "array-target");
    const survivor = source.items.find((item) => item.sourceRecordId === "array-survivor");
    const legacyNotes = {
      generatedAt: fixed,
      notes: [
        { note: "Array position zero must not select media zero.", updatedAt: fixed },
        { mediaId: target.mediaId, note: "Target legacy feedback", updatedAt: fixed },
        { mediaId: survivor.mediaId, note: "Surviving legacy feedback", updatedAt: fixed },
        { mediaId: "missing-array-media", note: "Still unresolved", updatedAt: fixed },
      ],
    };
    fs.writeFileSync(files.notesPath, `${JSON.stringify(legacyNotes)}\n`);
    const options = { notesPath: files.notesPath, reviewPath: files.reviewPath, catalog: source };
    const before = reconcileReviewState(options);
    assert.equal(before.document.entries.length, 2);
    assert.deepEqual(before.unresolved, { unresolved_legacy_note_alias: 2 });
    const survivorBefore = before.document.entries.find((entry) => entry.recordId === survivor.id);

    mutateManualNote({ mediaId: target.mediaId, note: "Updated target feedback" }, options);
    const persisted = JSON.parse(fs.readFileSync(files.notesPath, "utf8"));
    assert.ok(Array.isArray(persisted.notes));
    assert.equal(persisted.notes.length, 4);
    assert.equal(persisted.notes[0].note, "Array position zero must not select media zero.");
    assert.equal(persisted.notes[2].note, "Surviving legacy feedback");
    assert.equal(persisted.notes[3].note, "Still unresolved");

    const after = reconcileReviewState(options);
    assert.equal(after.document.entries.length, 2);
    assert.deepEqual(after.unresolved, before.unresolved);
    const survivorAfter = after.document.entries.find((entry) => entry.recordId === survivor.id);
    assert.deepEqual(survivorAfter, survivorBefore);
    assert.equal(after.document.entries.some((entry) => entry.mediaId === "0"), false);
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test("unresolved and ambiguous source notes preserve review state until a truly missing source is proven", () => {
  const files = workspace();
  try {
    const initial = catalog([bookmark("preserved-owner")]);
    const entry = initial.items[0];
    initial.resolverAliases[0].legacyNoteKeyAliases.push({ kind: "card", key: "legacy-preserve-selector" });
    fs.writeFileSync(files.notesPath, `${JSON.stringify({
      generatedAt: fixed,
      notes: { "legacy-preserve-selector": note("", "legacy-preserve-selector", "Keep this state stable") },
    })}\n`);
    const options = { notesPath: files.notesPath, reviewPath: files.reviewPath, catalog: initial };
    reconcileReviewState(options);
    const before = fs.readFileSync(files.reviewPath);

    const ambiguous = catalog([bookmark("preserved-owner"), bookmark("other-owner")]);
    ambiguous.resolverAliases.forEach((row) => row.legacyNoteKeyAliases.push({ kind: "card", key: "legacy-preserve-selector" }));
    const ambiguousResult = reconcileReviewState({ ...options, catalog: ambiguous });
    assert.equal(ambiguousResult.changed, false);
    assert.deepEqual(fs.readFileSync(files.reviewPath), before);
    assert.deepEqual(ambiguousResult.diagnostics, [{
      reason: "ambiguous_legacy_note_alias",
      candidateRecordIds: ambiguous.items.map((item) => item.id).sort(),
    }]);

    fs.writeFileSync(files.notesPath, `${JSON.stringify({
      generatedAt: fixed,
      notes: { "no-safe-association": note("", "no-safe-association", "Still present but unresolvable") },
    })}\n`);
    const unresolvedResult = reconcileReviewState(options);
    assert.equal(unresolvedResult.changed, false);
    assert.deepEqual(fs.readFileSync(files.reviewPath), before);
    assert.deepEqual(unresolvedResult.diagnostics, [{ reason: "unresolved_legacy_note_alias", candidateRecordIds: [] }]);

    writeNotes(files.notesPath, {});
    const deleted = reconcileReviewState(options).document.entries[0];
    assert.equal(deleted.sourcePresent, false);
    assert.equal(deleted.status, "dismissed");
    assert.equal(deleted.events.at(-1).reason, "source_note_deleted");
    assert.equal(entry.id, deleted.recordId);
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test("legacy duplicate mutations collapse logical targets across arrays, maps, and root maps", () => {
  const files = workspace();
  try {
    const source = catalog();
    const target = source.items[0];
    const shapes = [
      {
        name: "array",
        make: () => ({ generatedAt: fixed, notes: [
          { mediaId: "unrelated-first", note: "", updatedAt: fixed },
          { mediaId: target.mediaId, note: "Older target", updatedAt: fixed },
          { mediaId: target.mediaId, note: "Duplicate target", updatedAt: fixed },
          { mediaId: "unrelated-last", note: "", updatedAt: fixed },
        ] }),
        entries: (payload) => payload.notes,
      },
      {
        name: "notes-map",
        make: () => ({ generatedAt: fixed, notes: {
          before: { mediaId: "unrelated-first", note: "", updatedAt: fixed },
          "legacy-target-key": { mediaId: target.mediaId, note: "Older target", updatedAt: fixed },
          [target.mediaId]: { mediaId: target.mediaId, note: "Duplicate target", updatedAt: fixed },
          after: { mediaId: "unrelated-last", note: "", updatedAt: fixed },
        } }),
        entries: (payload) => Object.entries(payload.notes),
      },
      {
        name: "root-map",
        make: () => ({
          before: { mediaId: "unrelated-first", note: "", updatedAt: fixed },
          "legacy-target-key": { mediaId: target.mediaId, note: "Older target", updatedAt: fixed },
          [target.mediaId]: { mediaId: target.mediaId, note: "Duplicate target", updatedAt: fixed },
          after: { mediaId: "unrelated-last", note: "", updatedAt: fixed },
        }),
        entries: (payload) => Object.entries(payload),
      },
    ];
    for (const shape of shapes) {
      fs.writeFileSync(files.notesPath, `${JSON.stringify(shape.make())}\n`);
      fs.rmSync(files.reviewPath, { force: true });
      const options = { notesPath: files.notesPath, reviewPath: files.reviewPath, catalog: source };
      assert.equal(reconcileReviewState(options).document.entries.length, 1, shape.name);

      mutateManualNote({ mediaId: target.mediaId, note: "Collapsed target" }, options);
      const updated = JSON.parse(fs.readFileSync(files.notesPath, "utf8"));
      const updatedEntries = shape.entries(updated);
      const updatedValues = Array.isArray(updatedEntries[0]) ? updatedEntries.map(([, value]) => value) : updatedEntries;
      assert.equal(updatedValues.filter((value) => value.mediaId === target.mediaId).length, 1, shape.name);
      assert.equal(updatedValues.find((value) => value.mediaId === target.mediaId).note, "Collapsed target", shape.name);
      assert.deepEqual(updatedValues.filter((value) => value.mediaId.startsWith("unrelated")).map((value) => value.note), ["", ""], shape.name);
      assert.equal(reconcileReviewState(options).document.entries.length, 1, shape.name);

      mutateManualNote({ mediaId: target.mediaId, note: "" }, options);
      const deleted = JSON.parse(fs.readFileSync(files.notesPath, "utf8"));
      const deletedEntries = shape.entries(deleted);
      const deletedValues = Array.isArray(deletedEntries[0]) ? deletedEntries.map(([, value]) => value) : deletedEntries;
      assert.equal(deletedValues.some((value) => value.mediaId === target.mediaId), false, shape.name);
      const queue = reconcileReviewState(options).document.entries[0];
      assert.equal(queue.status, "dismissed", shape.name);
      assert.equal(queue.sourcePresent, false, shape.name);
    }
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test("source presence replays source events and permits a manual reopen after source deletion", () => {
  const files = workspace();
  try {
    const source = catalog();
    const item = source.items[0];
    writeNotes(files.notesPath, { [item.mediaId]: note(item.id, item.mediaId) });
    const options = { notesPath: files.notesPath, reviewPath: files.reviewPath, catalog: source };
    const entry = reconcileReviewState(options).document.entries[0];

    mutateManualNote({ mediaId: item.mediaId, note: "" }, options);
    const deleted = JSON.parse(fs.readFileSync(files.reviewPath, "utf8")).entries[0];
    assert.equal(deleted.status, "dismissed");
    assert.equal(deleted.sourcePresent, false);

    const reopened = transition(entry.id, "reopen", { reason: "Manual investigation" }, { ...options, now: "2026-07-12T10:02:00.000Z" });
    assert.equal(reopened.status, "needs_review");
    assert.equal(reopened.sourcePresent, false);
    assert.throws(() => transition(entry.id, "dismiss", { reason: "source_note_deleted" }, options), (error) =>
      error instanceof ReviewQueueError && error.code === "invalid_review_request"
    );
    const impossible = JSON.parse(fs.readFileSync(files.reviewPath, "utf8"));
    impossible.entries[0].sourcePresent = true;
    assert.throws(() => validateReviewDocument(impossible), (error) => error instanceof ReviewQueueError && error.code === "review_invalid_state");

    mutateManualNote({ mediaId: item.mediaId, note: "Restored source note" }, options);
    const restored = JSON.parse(fs.readFileSync(files.reviewPath, "utf8")).entries[0];
    assert.equal(restored.status, "needs_review");
    assert.equal(restored.sourcePresent, true);
    assert.equal(restored.events.at(-1).reason, "source_note_updated");
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test("a failed manual-note replace changes neither note nor review state", () => {
  const files = workspace();
  try {
    const source = catalog();
    const item = source.items[0];
    const options = {
      notesPath: files.notesPath,
      reviewPath: files.reviewPath,
      catalog: source,
      notesAtomicOptions: { beforeRename: () => { throw new Error("simulated note replace failure"); } },
    };
    assert.throws(() => mutateManualNote({ mediaId: item.mediaId, note: "Must not persist" }, options));
    assert.equal(fs.existsSync(files.notesPath), false);
    assert.equal(fs.existsSync(files.reviewPath), false);
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test("stale dead locks recover, live locks fail clearly, and invalid patches preserve the prior review file", () => {
  const files = workspace();
  try {
    const source = catalog();
    const item = source.items[0];
    writeNotes(files.notesPath, { [item.mediaId]: note(item.id, item.mediaId) });
    const options = { notesPath: files.notesPath, reviewPath: files.reviewPath, catalog: source };
    const lockPath = files.reviewPath.replace(/\.json$/, ".lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999999, createdAt: 0 }));
    const recovered = reconcileReviewState(options);
    assert.equal(recovered.document.entries.length, 1);
    assert.equal(fs.existsSync(lockPath), false);

    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    assert.throws(() => reconcileReviewState(options), (error) => error instanceof ReviewQueueError && error.statusCode === 503);
    fs.unlinkSync(lockPath);

    const before = fs.readFileSync(files.reviewPath);
    assert.throws(() => transition(recovered.document.entries[0].id, "resolve", { patch: { sourceUrl: "https://example.com/not-allowed" } }, options),
      (error) => error instanceof ReviewQueueError && error.code === "invalid_review_patch"
    );
    assert.deepEqual(fs.readFileSync(files.reviewPath), before);
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test("token-owned locks admit one contender and an old owner cannot release a replacement", () => {
  const files = workspace();
  try {
    const lockPath = files.reviewPath.replace(/\.json$/, ".lock");
    const original = acquireLock(lockPath, 0);
    const ownerPath = path.join(lockPath, `owner-${original.token}.json`);
    fs.writeFileSync(ownerPath, JSON.stringify({ ...original, pid: 99999999, createdAt: 0 }));
    const replacement = acquireLock(lockPath, 2 * 60 * 1000);
    assert.notEqual(replacement.token, original.token);
    assert.throws(() => acquireLock(lockPath, 2 * 60 * 1000), (error) => error instanceof ReviewQueueError && error.statusCode === 503);
    releaseLock(lockPath, original);
    assert.equal(fs.existsSync(path.join(lockPath, `owner-${replacement.token}.json`)), true);
    releaseLock(lockPath, replacement);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test("manual-note validation rejects malformed modern fields and preserves malformed sources", () => {
  const files = workspace();
  try {
    const source = catalog();
    const item = source.items[0];
    const oldAlias = `card-${item.mediaId}`;
    source.resolverAliases[0].mediaIdAliases = [oldAlias, item.mediaId].sort();
    writeNotes(files.notesPath, {
      [oldAlias]: note("", oldAlias, "Older alias feedback", "2026-07-12T09:00:00.000Z"),
      [item.mediaId]: note("", item.mediaId, "Newer canonical feedback", "2026-07-12T10:00:00.000Z"),
    });
    const options = { notesPath: files.notesPath, reviewPath: files.reviewPath, catalog: source };
    const first = reconcileReviewState(options).document.entries[0];
    assert.equal(first.sourceNoteFingerprint, require("../lib/catalog/canonical").sha256Canonical({ recordId: item.id, normalizedNoteText: "Newer canonical feedback" }));
    transition(first.id, "resolve", { patch: { title: "Kept correction" } }, { ...options, now: "2026-07-12T10:01:00.000Z" });
    writeNotes(files.notesPath, {
      [oldAlias]: note("", oldAlias, "Newest saved feedback", "2026-07-12T11:00:00.000Z"),
      [item.mediaId]: note("", item.mediaId, "Newer canonical feedback", "2026-07-12T10:00:00.000Z"),
    });
    const reopened = reconcileReviewState(options).document.entries[0];
    assert.equal(reopened.status, "needs_review");
    assert.equal(reopened.events.at(-1).reason, "source_note_updated");
    assert.deepEqual(reopened.acceptedPatch.patch, { title: "Kept correction" });

    const reviewBefore = fs.readFileSync(files.reviewPath);
    const malformed = { generatedAt: fixed, source: "visual-bookmarks-grid manual lightbox notes", notes: { [item.mediaId]: { ...note(item.id, item.mediaId), unexpected: true } } };
    fs.writeFileSync(files.notesPath, `${JSON.stringify(malformed)}\n`);
    assert.throws(() => reconcileReviewState(options), (error) => error instanceof ReviewQueueError && error.code === "manual_notes_invalid");
    assert.deepEqual(fs.readFileSync(files.reviewPath), reviewBefore);
    const notesBefore = fs.readFileSync(files.notesPath);
    assert.throws(() => mutateManualNote({ mediaId: item.mediaId, note: "" }, options), (error) => error instanceof ReviewQueueError && error.code === "manual_notes_invalid");
    assert.deepEqual(fs.readFileSync(files.notesPath), notesBefore);
    for (const invalid of [
      { ...note(item.id, item.mediaId), status: "resolved" },
      { ...note(item.id, item.mediaId), updatedAt: "2026-02-30T10:00:00.000Z" },
      { ...note(item.id, item.mediaId), createdAt: 123 },
      { ...note(item.id, item.mediaId), mediaId: "unsafe\u0000selector" },
    ]) {
      assert.throws(() => validateManualNotesPayload({ generatedAt: fixed, notes: { [item.mediaId]: invalid } }),
        (error) => error instanceof ReviewQueueError && error.code === "manual_notes_invalid");
    }
    assert.throws(() => validateManualNotesPayload({ generatedAt: fixed, notes: {}, unexpected: true }),
      (error) => error instanceof ReviewQueueError && error.code === "manual_notes_invalid");
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test("review candidates use the shared timestamp, alias-kind, then fingerprint winner contract", () => {
  const files = workspace();
  try {
    const source = catalog();
    const item = source.items[0];
    const row = source.resolverAliases[0];
    row.mediaId = "canonical-media";
    row.mediaIdAliases = ["canonical-media", "card-media"];
    fs.writeFileSync(files.notesPath, readReviewFixture("manual-notes-equal-time-canonical-card.json"));
    const canonicalWinner = reconcileReviewState({ notesPath: files.notesPath, reviewPath: files.reviewPath, catalog: source }).document.entries[0];
    assert.equal(canonicalWinner.sourceNoteFingerprint,
      require("../lib/catalog/canonical").sha256Canonical({ recordId: item.id, normalizedNoteText: "Canonical alias wins the equal-time tie." }));
    assert.equal(canonicalWinner.mediaId, item.mediaId);

    row.mediaId = item.mediaId;
    row.mediaIdAliases = [item.mediaId, "card-one", "card-two"];
    const options = { notesPath: files.notesPath, reviewPath: files.reviewPath, catalog: source };
    const fingerprints = ["Fingerprint tie one.", "Fingerprint tie two."]
      .map((text) => require("../lib/catalog/canonical").sha256Canonical({ recordId: item.id, normalizedNoteText: text }))
      .sort();
    fs.rmSync(files.reviewPath, { force: true });
    fs.writeFileSync(files.notesPath, readReviewFixture("manual-notes-fingerprint-tie-a.json"));
    const first = reconcileReviewState(options).document.entries[0];
    fs.rmSync(files.reviewPath, { force: true });
    fs.writeFileSync(files.notesPath, readReviewFixture("manual-notes-fingerprint-tie-b.json"));
    const second = reconcileReviewState(options).document.entries[0];
    assert.equal(first.sourceNoteFingerprint, fingerprints[0]);
    assert.equal(second.sourceNoteFingerprint, fingerprints[0]);
    assert.deepEqual(second, first);
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test("review state validation replays only legal histories and failed replacements preserve state", () => {
  const files = workspace();
  try {
    const source = catalog();
    const item = source.items[0];
    writeNotes(files.notesPath, { [item.mediaId]: note(item.id, item.mediaId) });
    const options = { notesPath: files.notesPath, reviewPath: files.reviewPath, catalog: source };
    const entry = reconcileReviewState(options).document.entries[0];
    transition(entry.id, "resolve", { patch: { title: "Accepted" } }, { ...options, now: "2026-07-12T10:01:00.000Z" });
    const valid = JSON.parse(fs.readFileSync(files.reviewPath, "utf8"));
    validateReviewDocument(valid);
    const impossible = structuredClone(valid);
    impossible.entries[0].events[0].reason = "wrong_reason";
    assert.throws(() => validateReviewDocument(impossible), (error) => error instanceof ReviewQueueError && error.code === "review_invalid_state");
    const patchBefore = fs.readFileSync(files.reviewPath);
    assert.throws(() => transition(entry.id, "reopen", { reason: "Follow up" }, { ...options, reviewAtomicOptions: { beforeRename: () => { throw new Error("rename failed"); } } }));
    assert.deepEqual(fs.readFileSync(files.reviewPath), patchBefore);
    assert.throws(() => transition(entry.id, "reopen", { reason: "x".repeat(241) }, options), (error) => error instanceof ReviewQueueError && error.code === "invalid_review_request");
    assert.deepEqual(fs.readFileSync(files.reviewPath), patchBefore);
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test("review CLI JSON stays machine-readable and bounded errors leave stdout empty", () => {
  const files = workspace();
  try {
    fs.writeFileSync(files.bookmarksPath, `${JSON.stringify({ bookmarks: [bookmark()] })}\n`);
    fs.writeFileSync(files.cardsPath, `${JSON.stringify({ cards: [] })}\n`);
    const environment = {
      ...process.env,
      BOOKMARKS_PATH: files.bookmarksPath,
      MEDIA_CARDS_PATH: files.cardsPath,
      MANUAL_NOTES_PATH: files.notesPath,
      METADATA_REVIEW_PATH: files.reviewPath,
      METADATA_REVIEW_LOCK_PATH: files.lockPath,
    };
    const listed = spawnSync("npm", ["run", "--silent", "review:list", "--", "--json"], { cwd: ROOT, encoding: "utf8", env: environment });
    assert.equal(listed.status, 0, listed.stderr);
    const listedJson = JSON.parse(listed.stdout);
    assert.equal(listedJson.ok, true);
    assert.equal(listedJson.diagnosticsOmitted, 0);
    const invalid = spawnSync("npm", ["run", "--silent", "review:list", "--", "--status", "invalid", "--json"], { cwd: ROOT, encoding: "utf8", env: environment });
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, "");
    assert.match(invalid.stderr, /Invalid review status/);
    assert.ok(!invalid.stderr.includes(files.directory));
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test("legacy aliases resolve only when exact and unambiguous", () => {
  const files = workspace();
  try {
    const records = [
      bookmark("same-source", "first-source"),
      bookmark("same-source", "second-source"),
    ];
    const cards = { cards: [{ mediaId: "card-media", title: "Card", media: { type: "photo", url: "assets/card.webp" }, tweet: { id: "same-source" } }] };
    const source = buildCatalog({ bookmarksPayload: { bookmarks: records }, cardsPayload: cards, generatedAt: fixed });
    writeNotes(files.notesPath, {
      "same-source:assets/card.webp": note("", "same-source:assets/card.webp", "Ambiguous legacy note"),
    });
    const options = { notesPath: files.notesPath, reviewPath: files.reviewPath, catalog: source };
    const result = reconcileReviewState(options);
    assert.equal(result.document.entries.length, 0);
    assert.deepEqual(result.unresolved, { ambiguous_legacy_note_alias: 1 });
    const listed = listReviewEntries({ limit: 1, offset: 0 }, options);
    assert.deepEqual(listed.unresolved, { ambiguous_legacy_note_alias: 1 });
    assert.deepEqual(listed.diagnostics, result.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      candidateRecordIdsOmitted: 0,
    })));
    assert.equal(listed.diagnosticsOmitted, 0);
    assert.equal(listed.diagnostics[0].candidateRecordIds.length > 1, true);
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test("review-list bounds diagnostics and ambiguous candidates independently of entries", async () => {
  const files = workspace();
  let server;
  try {
    const diagnosticCount = 125;
    const records = Array.from({ length: diagnosticCount }, (_, index) => ({
      id: `ambiguous-${index}`,
      text: `Ambiguous ${index}`,
      url: `https://example.com/ambiguous-${index}`,
      images: [{ id: "shared-media", type: "photo", url: `assets/ambiguous-${index}.webp`, width: 1200, height: 900 }],
    }));
    const source = catalog(records);
    const sharedSelector = source.resolverAliases[0].mediaId;
    assert.ok(source.resolverAliases.every((row) => row.mediaIdAliases.includes(sharedSelector)));
    writeNotes(files.notesPath, Object.fromEntries(Array.from({ length: diagnosticCount }, (_, index) => [
      `ambiguous-note-${index}`,
      note("", sharedSelector, `Ambiguous note ${index}`),
    ])));
    const options = { notesPath: files.notesPath, reviewPath: files.reviewPath, catalog: source };
    const listed = listReviewEntries({ limit: 1, offset: 0 }, options);
    assert.equal(listed.entries.length, 0);
    assert.equal(listed.diagnostics.length, 50);
    assert.equal(listed.diagnosticsOmitted, 75);
    assert.ok(listed.diagnostics.every((diagnostic) =>
      diagnostic.reason === "ambiguous_legacy_note_alias" &&
      diagnostic.candidateRecordIds.length === 50 &&
      diagnostic.candidateRecordIdsOmitted === 75
    ));
    assert.ok(Buffer.byteLength(JSON.stringify(listed)) < 256 * 1024);
    assert.deepEqual(listReviewEntries({ limit: 1, offset: 0 }, options), listed);

    fs.writeFileSync(files.bookmarksPath, `${JSON.stringify({ bookmarks: records })}\n`);
    fs.writeFileSync(files.cardsPath, `${JSON.stringify({ cards: [] })}\n`);
    server = await startServer({
      BOOKMARKS_PATH: files.bookmarksPath,
      MEDIA_CARDS_PATH: files.cardsPath,
      MANUAL_NOTES_PATH: files.notesPath,
      METADATA_REVIEW_PATH: files.reviewPath,
      METADATA_REVIEW_LOCK_PATH: files.lockPath,
    });
    const response = await requestJson(server.port, "/api/review-queue?limit=1");
    assert.equal(response.status, 200);
    assert.equal(response.json.entries.length, 0);
    assert.equal(response.json.diagnostics.length, 50);
    assert.equal(response.json.diagnosticsOmitted, 75);
    assert.ok(response.json.diagnostics.every((diagnostic) =>
      diagnostic.candidateRecordIds.length === 50 && diagnostic.candidateRecordIdsOmitted === 75
    ));
    assert.ok(Buffer.byteLength(JSON.stringify(response.json)) < 256 * 1024);
  } finally {
    server?.child.kill();
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test("manual-note mutations collapse every safely resolved selector for one record and retain unrelated unresolved entries", () => {
  const files = workspace();
  try {
    const source = catalog([bookmark("tweet-source", "tweet-source")]);
    const item = source.items[0];
    const legacyKey = "tweet-source:assets/tweet-source.webp";
    writeNotes(files.notesPath, {
      [legacyKey]: { tweetId: "tweet-source", mediaUrl: "assets/tweet-source.webp", note: "Legacy alias note", updatedAt: fixed },
      [item.mediaId]: note("", item.mediaId, "Canonical note", fixed),
      unrelated: { mediaId: "unresolved-media", note: "Leave this unresolved note alone", updatedAt: fixed },
    });
    const options = { notesPath: files.notesPath, reviewPath: files.reviewPath, lockPath: files.lockPath, catalog: source };

    mutateManualNote({ mediaId: item.mediaId, note: "Collapsed canonical update" }, options);
    let persisted = JSON.parse(fs.readFileSync(files.notesPath, "utf8")).notes;
    assert.deepEqual(Object.keys(persisted).sort(), [item.mediaId, "unrelated"].sort());
    assert.equal(persisted[item.mediaId].note, "Collapsed canonical update");
    assert.equal(persisted[item.mediaId].recordId, item.id);
    assert.equal(persisted.unrelated.note, "Leave this unresolved note alone");

    mutateManualNote({ mediaId: item.mediaId, note: "" }, options);
    persisted = JSON.parse(fs.readFileSync(files.notesPath, "utf8")).notes;
    assert.deepEqual(Object.keys(persisted), ["unrelated"]);
    assert.equal(persisted.unrelated.note, "Leave this unresolved note alone");
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test("manual-note mutation accepts the catalog media-id bound through 1024 bytes", () => {
  const files = workspace();
  try {
    const source = catalog();
    const options = { notesPath: files.notesPath, reviewPath: files.reviewPath, lockPath: files.lockPath, catalog: source };
    for (const length of [161, 1024]) {
      const mediaId = "m".repeat(length);
      const result = mutateManualNote({ mediaId, note: `Bounded note ${length}` }, options);
      assert.equal(result.entry.mediaId, mediaId);
      assert.equal(JSON.parse(fs.readFileSync(files.notesPath, "utf8")).notes[mediaId].note, `Bounded note ${length}`);
    }
    assert.throws(
      () => mutateManualNote({ mediaId: "m".repeat(1025), note: "Too long" }, options),
      (error) => error instanceof ReviewQueueError && error.code === "invalid_manual_note"
    );
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test("active accepted patches apply after index inputs, update provenance and search text, and leave source files unchanged", async () => {
  const files = workspace();
  try {
    fs.writeFileSync(files.bookmarksPath, `${JSON.stringify({ bookmarks: [bookmark()] })}\n`);
    fs.writeFileSync(files.cardsPath, `${JSON.stringify({ cards: [] })}\n`);
    fs.writeFileSync(files.clipsPath, `${JSON.stringify({ clips: [] })}\n`);
    const source = catalog();
    const item = source.items[0];
    writeNotes(files.notesPath, { [item.mediaId]: note(item.id, item.mediaId) });
    const sourcesBefore = [files.bookmarksPath, files.cardsPath, files.clipsPath, files.notesPath].map((file) => fs.readFileSync(file));
    const options = { rootDir: ROOT, bookmarksPath: files.bookmarksPath, cardsPath: files.cardsPath, webClipsPath: files.clipsPath, notesPath: files.notesPath, reviewPath: files.reviewPath, indexPath: files.indexPath, generatedAt: fixed };
    await buildIndex(options);
    const review = JSON.parse(fs.readFileSync(files.reviewPath, "utf8")).entries[0];
    transition(review.id, "resolve", { patch: { title: "", categories: ["Reference"] } }, { ...options, catalog: source, now: "2026-07-12T10:01:00.000Z" });
    const rebuilt = await buildIndex(options);
    const corrected = rebuilt.index.items[0];
    assert.equal(corrected.title, "");
    assert.deepEqual(corrected.categories, ["Reference"]);
    assert.deepEqual(corrected.provenance.title, ["manual-override"]);
    assert.equal(searchCatalog(rebuilt.index, { query: "reference" }).total, 1);
    [files.bookmarksPath, files.cardsPath, files.clipsPath, files.notesPath].forEach((file, index) => assert.deepEqual(fs.readFileSync(file), sourcesBefore[index]));
    const patchedAgain = applyAcceptedPatches(rebuilt.index, JSON.parse(fs.readFileSync(files.reviewPath, "utf8")));
    assert.deepEqual(patchedAgain.items[0], corrected);
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test("duplicate presentation-owner changes retain one review id, status, and accepted patch", () => {
  const files = workspace();
  try {
    const initial = catalog([bookmark("z-owner", "shared")]);
    const recordId = initial.items[0].id;
    const mediaId = initial.items[0].mediaId;
    writeNotes(files.notesPath, { [mediaId]: note(recordId, mediaId, "Stable duplicate feedback") });
    const options = { notesPath: files.notesPath, reviewPath: files.reviewPath, catalog: initial };
    const entry = reconcileReviewState(options).document.entries[0];
    transition(entry.id, "resolve", { patch: { tags: ["Stable correction"] } }, { ...options, now: "2026-07-12T10:01:00.000Z" });

    const withHigherOwner = catalog([bookmark("z-owner", "shared"), bookmark("a-owner", "shared")]);
    assert.equal(withHigherOwner.items[0].id, recordId);
    const reconciled = reconcileReviewState({ ...options, catalog: withHigherOwner });
    assert.equal(reconciled.document.entries.length, 1);
    assert.equal(reconciled.document.entries[0].id, entry.id);
    assert.equal(reconciled.document.entries[0].status, "resolved");
    assert.deepEqual(reconciled.document.entries[0].acceptedPatch.patch, { tags: ["Stable correction"] });
    assert.equal(reconciled.document.entries[0].events.at(-1).action, "resolve");
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test("review files are exactly ignored and never added to the static allowlist", () => {
  for (const filename of ["metadata-review.json", "metadata-review.lock", "metadata-review.lock.stale-dead-owner"]) {
    const result = spawnSync("git", ["check-ignore", filename], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), filename);
  }
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const staticBlock = server.slice(server.indexOf("const ALLOWED_STATIC_FILES"), server.indexOf("const ALLOWED_CLIP_ASSET_EXTENSIONS"));
  assert.equal(staticBlock.includes("metadata-review.json"), false);
  assert.equal(staticBlock.includes("metadata-review.lock"), false);
});

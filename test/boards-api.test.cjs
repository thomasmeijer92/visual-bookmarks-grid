const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadBootstrapCatalog } = require("../lib/catalog/bootstrap");

const ROOT = path.resolve(__dirname, "..");

function request(port, { pathname, method = "GET", body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
    const requestHeaders = { ...headers };
    if (payload !== null && !requestHeaders["Content-Type"]) requestHeaders["Content-Type"] = "application/json";
    if (payload !== null && !requestHeaders["Content-Length"]) requestHeaders["Content-Length"] = Buffer.byteLength(payload);
    const client = http.request({ host: "127.0.0.1", port, path: pathname, method, headers: requestHeaders }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: responseBody }));
    });
    client.on("error", reject);
    if (payload !== null) client.write(payload);
    client.end();
  });
}

async function startServer(root, { boardsPath = path.join(root, "boards.json"), includeBoardsLockPath = true, environment = {} } = {}) {
  const env = {
    ...process.env,
    GRID_HOST: "127.0.0.1",
    PORT: "0",
    GRID_PORT: "0",
    BOARDS_PATH: boardsPath,
    MANUAL_NOTES_PATH: path.join(root, "notes.json"),
    METADATA_REVIEW_PATH: path.join(root, "review.json"),
    METADATA_REVIEW_LOCK_PATH: path.join(root, "review.lock"),
    WEB_CLIPS_PATH: path.join(root, "clips.json"),
    INSPIRATION_INDEX_PATH: path.join(root, "index.json"),
    ...environment,
  };
  if (includeBoardsLockPath) env.BOARDS_LOCK_PATH = path.join(root, "boards.lock");
  else delete env.BOARDS_LOCK_PATH;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 5000);
    const append = (chunk) => {
      output += chunk;
      const match = output.match(/Server running at http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", reject);
  });
  return { child, port };
}

function runCli(args, env) {
  const childEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(childEnv)) if (value === undefined) delete childEnv[key];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("sample fixture mode fails closed without explicit catalog fixture paths", () => {
  const environment = { ...process.env, GRID_FIXTURE_MODE: "sample" };
  delete environment.BOOKMARKS_DATA_PATH;
  delete environment.MEDIA_CARDS_PATH;
  const result = spawnSync(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: environment,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Sample fixture mode requires BOOKMARKS_DATA_PATH and MEDIA_CARDS_PATH/);
});

test("sample fixture catalog APIs ignore hostile root exports", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "visual-bookmarks-grid-fixture-isolation-"));
  let server;
  const sentinel = "ROOT_EXPORT_SENTINEL_MUST_NOT_LEAK";
  try {
    fs.writeFileSync(path.join(root, "bookmarks-data.json"), `${JSON.stringify({
      bookmarks: [{ id: "ignored-root-export", text: sentinel, url: "https://example.invalid/sentinel", images: [] }],
    })}\n`);
    fs.writeFileSync(path.join(root, "media-cards-clean.json"), "{ invalid ignored root export");
    server = await startServer(root, {
      environment: {
        GRID_FIXTURE_MODE: "sample",
        GRID_CATALOG_ROOT: root,
        BOOKMARKS_DATA_PATH: path.join(ROOT, "bookmarks-data.sample.json"),
        MEDIA_CARDS_PATH: path.join(ROOT, "media-cards.sample.json"),
      },
    });
    const assertSampleOnly = (response) => {
      assert.equal(response.status, 200);
      assert.equal(response.body.includes(sentinel), false);
      assert.equal(response.body.includes("invalid ignored root export"), false);
    };

    const bookmarkStatic = await request(server.port, { pathname: "/bookmarks-data.json" });
    const cardsStatic = await request(server.port, { pathname: "/media-cards-clean.json" });
    assertSampleOnly(bookmarkStatic);
    assertSampleOnly(cardsStatic);
    assert.equal(JSON.parse(bookmarkStatic.body).bookmarks[0].id, "sample-interface-001");
    assert.equal(JSON.parse(cardsStatic.body).cards[0].mediaId, "sample-interface-001-01");

    const search = await request(server.port, {
      pathname: "/api/search",
      method: "POST",
      body: { query: "operations dashboard" },
    });
    assertSampleOnly(search);
    const itemId = JSON.parse(search.body).results[0].item.id;

    const item = await request(server.port, { pathname: `/api/items/${encodeURIComponent(itemId)}` });
    assertSampleOnly(item);
    const resolve = await request(server.port, {
      pathname: "/api/catalog/resolve",
      method: "POST",
      body: { items: [{
        clientKey: "fixture-item",
        sourceType: "bookmark",
        sourceRecordId: "sample-interface-001",
        sourceUrl: "https://example.com/samples/interface-dashboard",
        primaryMediaUrl: "assets/sample-interface.svg",
      }] },
    });
    assertSampleOnly(resolve);
    assert.equal(JSON.parse(resolve.body).items[0].catalogId, itemId);

    const boards = await request(server.port, { pathname: "/api/boards?limit=1" });
    const notes = await request(server.port, { pathname: "/api/manual-notes" });
    const reviews = await request(server.port, { pathname: "/api/review-queue?limit=1" });
    [boards, notes, reviews].forEach(assertSampleOnly);
  } finally {
    if (server) {
      server.child.kill("SIGTERM");
      await new Promise((resolve) => server.child.once("exit", resolve));
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolver and board routes enforce bounded loopback contracts without exposing aliases", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "visual-bookmarks-grid-boards-api-"));
  let server;
  try {
    server = await startServer(root);
    const resolve = await request(server.port, {
      pathname: "/api/catalog/resolve",
      method: "POST",
      body: {
        items: [{
          clientKey: "sample",
          sourceType: "bookmark",
          sourceRecordId: "sample-interface-001",
          sourceUrl: "https://example.com/samples/interface-dashboard",
          primaryMediaUrl: "assets/sample-interface.svg",
        }],
      },
    });
    assert.equal(resolve.status, 200);
    const resolved = JSON.parse(resolve.body);
    assert.equal(resolved.items[0].status, "resolved");
    const catalogId = resolved.items[0].catalogId;

    const exactSelectors = await request(server.port, {
      pathname: "/api/catalog/resolve",
      method: "POST",
      body: { items: Array.from({ length: 50 }, (_, index) => ({
        clientKey: `exact-${index}`,
        sourceType: "bookmark",
        sourceRecordId: "sample-interface-001",
        primaryMediaUrl: "assets/sample-interface.svg",
      })) },
    });
    assert.equal(exactSelectors.status, 200);
    assert.equal(JSON.parse(exactSelectors.body).items.length, 50);

    const resolveMinimum = JSON.stringify({ items: [] });
    const exactResolveBody = resolveMinimum + " ".repeat(32 * 1024 - Buffer.byteLength(resolveMinimum));
    assert.equal((await request(server.port, { pathname: "/api/catalog/resolve", method: "POST", body: exactResolveBody })).status, 200);
    assert.equal((await request(server.port, { pathname: "/api/catalog/resolve", method: "POST", body: `${exactResolveBody} ` })).status, 413);

    const created = await request(server.port, {
      pathname: "/api/boards",
      method: "POST",
      body: { name: "API board", brief: "Bounded API fixture.", querySnapshot: {}, items: [{ itemId: catalogId }] },
    });
    assert.equal(created.status, 201);
    const boardId = JSON.parse(created.body).board.id;

    const listed = await request(server.port, { pathname: "/api/boards?limit=1&offset=0" });
    assert.equal(listed.status, 200);
    assert.equal(JSON.parse(listed.body).boards[0].itemCount, 1);

    const detail = await request(server.port, { pathname: `/api/boards/${encodeURIComponent(boardId)}` });
    assert.equal(detail.status, 200);
    const detailPayload = JSON.parse(detail.body);
    assert.equal(detailPayload.resolvedItems[0].status, "available");
    assert.equal(JSON.stringify(detailPayload).includes("resolverAliases"), false);

    const patched = await request(server.port, {
      pathname: `/api/boards/${encodeURIComponent(boardId)}`,
      method: "PATCH",
      body: { action: "curation-note", itemId: catalogId, curationNote: "Checked through the API." },
    });
    assert.equal(patched.status, 200);
    for (const body of [
      { action: "remove", itemId: catalogId, name: "mixed fields" },
      { action: "curation-note", itemId: 7, curationNote: "wrong id type" },
      { action: "add", item: { itemId: 7 } },
      { action: "reorder", itemIds: [catalogId, 7] },
      { action: "unknown", itemId: catalogId },
    ]) {
      const invalidAction = await request(server.port, {
        pathname: `/api/boards/${encodeURIComponent(boardId)}`,
        method: "PATCH",
        body,
      });
      assert.equal(invalidAction.status, 400);
      assert.deepEqual(JSON.parse(invalidAction.body), { ok: false, error: "Board request is invalid." });
    }
    assert.equal((await request(server.port, { pathname: `/api/boards/${encodeURIComponent(boardId)}` })).status, 200);
    const exported = await request(server.port, { pathname: `/api/boards/${encodeURIComponent(boardId)}/export?format=markdown` });
    assert.equal(exported.status, 200);
    assert.match(JSON.parse(exported.body).content, /Checked through the API/);

    const invalidPagination = await request(server.port, { pathname: "/api/boards?limit=101" });
    assert.equal(invalidPagination.status, 400);
    const resolverMethod = await request(server.port, { pathname: "/api/catalog/resolve" });
    assert.equal(resolverMethod.status, 405);
    const oversized = await request(server.port, {
      pathname: "/api/catalog/resolve",
      method: "POST",
      body: "x".repeat(33 * 1024),
    });
    assert.equal(oversized.status, 413);
    const boardMinimum = "{}";
    const exactBoardBody = boardMinimum + " ".repeat(64 * 1024 - Buffer.byteLength(boardMinimum));
    assert.equal((await request(server.port, { pathname: "/api/boards", method: "POST", body: exactBoardBody })).status, 400);
    assert.equal((await request(server.port, { pathname: "/api/boards", method: "POST", body: `${exactBoardBody} ` })).status, 413);
    const forbiddenOrigin = await request(server.port, { pathname: "/api/boards", headers: { Origin: "https://example.invalid" } });
    assert.equal(forbiddenOrigin.status, 403);
    const sameOrigin = await request(server.port, { pathname: "/api/boards?limit=1", headers: { Origin: `http://127.0.0.1:${server.port}` } });
    assert.equal(sameOrigin.status, 200);
    const cors = await request(server.port, { pathname: "/api/boards", method: "OPTIONS" });
    assert.match(cors.headers["access-control-allow-methods"], /PATCH/);
    assert.match(cors.headers["access-control-allow-methods"], /DELETE/);

    for (const pathname of [
      "/api/boards/%",
      "/api/boards/%E0%A4%A",
      "/api/boards/%2525252525252525",
      "/api/boards/%2525252525252525/export?format=markdown",
    ]) {
      const malformed = await request(server.port, { pathname });
      assert.equal(malformed.status, 400, pathname);
      assert.deepEqual(JSON.parse(malformed.body), { ok: false, error: "Board request is invalid." });
    }
    assert.equal((await request(server.port, { pathname: "/api/boards?limit=1" })).status, 200);

    for (let layer = 1; layer <= 5; layer++) {
      const encodedSeparator = `%${"25".repeat(layer - 1)}2F`;
      for (const suffix of ["", "/export?format=markdown"]) {
        const malformed = await request(server.port, { pathname: `/api/boards/board${encodedSeparator}reference${suffix}` });
        assert.equal(malformed.status, 400, `layer ${layer} ${suffix || "detail"}`);
        assert.deepEqual(JSON.parse(malformed.body), { ok: false, error: "Board request is invalid." });
        assert.equal((await request(server.port, { pathname: "/api/boards?limit=1" })).status, 200);
      }
    }
    for (const encodedSeparator of ["%5C", "%25255C"]) {
      const malformed = await request(server.port, { pathname: `/api/boards/board${encodedSeparator}reference` });
      assert.equal(malformed.status, 400, encodedSeparator);
      assert.deepEqual(JSON.parse(malformed.body), { ok: false, error: "Board request is invalid." });
    }

    for (const pathname of [
      "/boards.json", "/boards.json.tmp-test", "/boards.lock", `/boards.lock/owner-${"a".repeat(64)}.json`,
      "/boards.lock.tmp-test", `/boards.lock.tmp-test/owner-${"b".repeat(64)}.json`,
      "/boards.lock.stale-test", `/boards.lock.stale-test/owner-${"c".repeat(64)}.json`,
    ]) {
      const staticResponse = await request(server.port, { pathname });
      assert.equal(staticResponse.status, 403, `${pathname} must remain private`);
    }
    assert.equal((await request(server.port, { pathname: `/api/boards/${encodeURIComponent(boardId)}`, method: "PUT", body: {} })).status, 405);
    const deleted = await request(server.port, { pathname: `/api/boards/${encodeURIComponent(boardId)}`, method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal((await request(server.port, { pathname: `/api/boards/${encodeURIComponent(boardId)}`, method: "DELETE" })).status, 404);

    const idsPath = path.join(root, "ids.json");
    fs.writeFileSync(idsPath, JSON.stringify([catalogId]));
    const cliMutation = runCli(["tools/board-create.mjs", "--name", "CLI board", "--items", idsPath], {
      BOARDS_PATH: path.join(root, "boards.json"),
      BOARDS_LOCK_PATH: path.join(root, "boards.lock"),
      INSPIRATION_INDEX_PATH: path.join(root, "index.json"),
    });
    const apiMutation = request(server.port, {
      pathname: "/api/boards",
      method: "POST",
      body: { name: "Server board", brief: "", querySnapshot: {}, items: [{ itemId: catalogId }] },
    });
    const [cliResult, apiResult] = await Promise.all([cliMutation, apiMutation]);
    assert.ok(cliResult.status === 0 || /Boards are busy/.test(cliResult.stderr));
    assert.ok(apiResult.status === 201 || apiResult.status === 503);
    const finalList = await request(server.port, { pathname: "/api/boards?limit=10" });
    const expectedMutations = Number(cliResult.status === 0) + Number(apiResult.status === 201);
    assert.equal(JSON.parse(finalList.body).total, expectedMutations);
  } finally {
    if (server?.child) server.child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("server and CLI share the BOARDS_PATH-derived lock when no board lock path is set", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "visual-bookmarks-grid-boards-derived-lock-"));
  const boardsPath = path.join(root, "state", "saved-boards.json");
  const lockPath = path.join(root, "state", "saved-boards.lock");
  let server;
  try {
    fs.mkdirSync(lockPath, { recursive: true });
    const token = "a".repeat(64);
    fs.writeFileSync(path.join(lockPath, `owner-${token}.json`), JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      createdAt: Date.now(),
      token,
    }));
    server = await startServer(root, { boardsPath, includeBoardsLockPath: false });
    const catalogId = loadBootstrapCatalog({ rootDir: ROOT, generatedAt: "2026-07-13T10:00:00.000Z" }).items[0].id;
    const idsPath = path.join(root, "ids.json");
    fs.writeFileSync(idsPath, JSON.stringify([catalogId]));
    const [cliResult, apiResult] = await Promise.all([
      runCli(["tools/board-create.mjs", "--name", "CLI lock fixture", "--items", idsPath], {
        BOARDS_PATH: boardsPath,
        BOARDS_LOCK_PATH: undefined,
      }),
      request(server.port, {
        pathname: "/api/boards",
        method: "POST",
        body: { name: "API lock fixture", brief: "", querySnapshot: {}, items: [{ itemId: catalogId }] },
      }),
    ]);
    assert.notEqual(cliResult.status, 0);
    assert.match(cliResult.stderr, /Boards are busy/);
    assert.equal(apiResult.status, 503);
    assert.deepEqual(JSON.parse(apiResult.body), { ok: false, error: "Boards are unavailable." });
    assert.equal(fs.existsSync(boardsPath), false);
  } finally {
    if (server?.child) server.child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("board CLI emits one JSON value on success and bounded stderr-only errors", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "visual-bookmarks-grid-board-cli-"));
  try {
    const catalogId = loadBootstrapCatalog({ rootDir: ROOT, generatedAt: "2026-07-13T10:00:00.000Z" }).items[0].id;
    const idsPath = path.join(root, "ids.json");
    fs.writeFileSync(idsPath, JSON.stringify([{ itemId: catalogId, matchReasonsAtSave: ["query: reference"] }]));
    const env = {
      BOARDS_PATH: path.join(root, "boards.json"),
      BOARDS_LOCK_PATH: path.join(root, "boards.lock"),
      INSPIRATION_INDEX_PATH: path.join(root, "missing-index.json"),
    };
    const created = await runCli(["tools/board-create.mjs", "--name", "CLI JSON board", "--items", idsPath, "--json"], env);
    assert.equal(created.status, 0, created.stderr);
    assert.equal(created.stderr, "");
    assert.equal(created.stdout.trim().split("\n").length, 1);
    const payload = JSON.parse(created.stdout);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.board.items[0].matchReasonsAtSave, ["query: reference"]);

    const exported = await runCli(["tools/board-export.mjs", "--id", payload.board.id, "--format", "json", "--json"], env);
    assert.equal(exported.status, 0, exported.stderr);
    assert.equal(JSON.parse(exported.stdout).format, "json");

    const failure = await runCli(["tools/board-create.mjs", "--name", "Invalid", "--items", path.join(root, "private-input.json"), "--json"], env);
    assert.notEqual(failure.status, 0);
    assert.equal(failure.stdout, "");
    assert.ok(failure.stderr.length < 300);
    assert.equal(failure.stderr.includes(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

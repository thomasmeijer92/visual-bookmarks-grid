const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const guardSource = path.join(__dirname, "root-review-artifact-guard.cjs");
const repositoryRoot = path.resolve(__dirname, "..");
const originalReview = Buffer.from('{"entries":["original"]}\n');

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "root-review-artifact-guard-"));
  const testDir = path.join(root, "test");
  fs.mkdirSync(testDir);
  const guardPath = path.join(testDir, "root-review-artifact-guard.cjs");
  fs.copyFileSync(guardSource, guardPath);
  return {
    root,
    guardPath,
    reviewPath: path.join(root, "metadata-review.json"),
    lockPath: path.join(root, "metadata-review.lock"),
  };
}

function runNode(files, source, options = {}) {
  const result = spawnSync(process.execPath, options.args || ["--require", files.guardPath, "-e", source], {
    cwd: files.root,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    stdio: options.stdio,
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
}

function runGuarded(files, source, options) {
  runNode(files, source, options);
}

function clean(files) {
  fs.rmSync(files.root, { recursive: true, force: true });
}

function setupReview(files) {
  fs.writeFileSync(files.reviewPath, originalReview);
}

function stableMetadata(stat) {
  return { mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid, mtimeMs: stat.mtimeMs };
}

function setupLockArtifacts(files) {
  const token = "a".repeat(64);
  const roots = [
    files.lockPath,
    `${files.lockPath}.tmp-123-456-${"b".repeat(16)}`,
    `${files.lockPath}.stale-${"c".repeat(64)}`,
  ];
  const owners = roots.map((lockPath, index) => {
    fs.mkdirSync(lockPath, { mode: 0o700 });
    const owner = path.join(lockPath, `owner-${index === 0 ? token : `${index}`.repeat(64)}.json`);
    fs.writeFileSync(owner, `${JSON.stringify({ schemaVersion: 1, pid: 1, createdAt: index, token })}\n`, { mode: 0o600 });
    return owner;
  });
  return { roots, owners };
}

test("the active barrier catches transient create/delete attempts before they reach the root", () => {
  const files = workspace();
  try {
    runGuarded(files, `
      const assert = require("node:assert/strict");
      const fs = require("node:fs");
      const blocked = (fn) => assert.throws(fn, (error) => error.code === "ERR_ROOT_REVIEW_ARTIFACT_WRITE");
      blocked(() => fs.writeFileSync("metadata-review.json.tmp-create-delete", "transient"));
      blocked(() => fs.unlinkSync("metadata-review.json.tmp-create-delete"));
      assert.equal(fs.existsSync("metadata-review.json.tmp-create-delete"), false);
    `);
  } finally {
    clean(files);
  }
});

test("the barrier normalizes direct strings, Buffers, file URLs, and relative paths", () => {
  const files = workspace();
  try {
    setupReview(files);
    runGuarded(files, `
      (async () => {
        const assert = require("node:assert/strict");
        const fs = require("node:fs");
        const fsp = require("node:fs/promises");
        const path = require("node:path");
        const { pathToFileURL } = require("node:url");
        const blocked = (fn) => assert.throws(fn, (error) => error.code === "ERR_ROOT_REVIEW_ARTIFACT_WRITE");
        const blockedAsync = (operation) => assert.rejects(operation, (error) => error.code === "ERR_ROOT_REVIEW_ARTIFACT_WRITE");
        const before = fs.readFileSync("metadata-review.json");
        const descriptor = fs.openSync("metadata-review.json", "r");
        fs.closeSync(descriptor);
        blocked(() => fs.writeFileSync(Buffer.from(path.resolve("metadata-review.json")), "changed"));
        await blockedAsync(fsp.appendFile(pathToFileURL(path.resolve("metadata-review.json")), "changed"));
        blocked(() => fs.truncateSync("./metadata-review.json", 0));
        assert.deepEqual(fs.readFileSync("metadata-review.json"), before);
      })().catch((error) => { process.nextTick(() => { throw error; }); });
    `);
    assert.deepEqual(fs.readFileSync(files.reviewPath), originalReview);
  } finally {
    clean(files);
  }
});

test("protected artifacts may be copied out but never used as copy destinations", () => {
  const files = workspace();
  const destination = path.join(os.tmpdir(), `root-review-copy-${process.pid}-${Date.now()}.json`);
  try {
    setupReview(files);
    fs.writeFileSync(path.join(files.root, "source.json"), "replacement\n");
    runGuarded(files, `
      (async () => {
        const assert = require("node:assert/strict");
        const fs = require("node:fs");
        const fsp = require("node:fs/promises");
        const destination = ${JSON.stringify(destination)};
        fs.copyFileSync("metadata-review.json", destination);
        assert.deepEqual(fs.readFileSync(destination), fs.readFileSync("metadata-review.json"));
        fs.cpSync("metadata-review.json", "copied-with-cp-sync.json");
        await new Promise((resolve, reject) => fs.cp("metadata-review.json", "copied-with-cp-callback.json", (error) => error ? reject(error) : resolve()));
        await fsp.cp("metadata-review.json", "copied-with-cp.json");
        assert.deepEqual(fs.readFileSync("copied-with-cp-sync.json"), fs.readFileSync("metadata-review.json"));
        assert.deepEqual(fs.readFileSync("copied-with-cp-callback.json"), fs.readFileSync("metadata-review.json"));
        assert.deepEqual(fs.readFileSync("copied-with-cp.json"), fs.readFileSync("metadata-review.json"));
        assert.throws(() => fs.copyFileSync("source.json", "metadata-review.json"), (error) => error.code === "ERR_ROOT_REVIEW_ARTIFACT_WRITE");
        await assert.rejects(fsp.copyFile("source.json", "metadata-review.json"), (error) => error.code === "ERR_ROOT_REVIEW_ARTIFACT_WRITE");
      })().catch((error) => { process.nextTick(() => { throw error; }); });
    `);
    assert.deepEqual(fs.readFileSync(destination), originalReview);
    assert.deepEqual(fs.readFileSync(files.reviewPath), originalReview);
  } finally {
    fs.rmSync(destination, { force: true });
    clean(files);
  }
});

test("recursive cp variants reject direct and dereferenced root artifact outputs before any copy or attempted restoration", () => {
  const files = workspace();
  try {
    setupReview(files);
    const incoming = path.join(files.root, "incoming");
    const ordinary = path.join(files.root, "ordinary");
    const nested = path.join(files.root, "nested");
    const cyclic = path.join(files.root, "cyclic");
    fs.mkdirSync(incoming);
    fs.writeFileSync(path.join(incoming, "metadata-review.json"), "replacement\n");
    fs.writeFileSync(path.join(incoming, "sidecar.txt"), "must not copy\n");
    fs.mkdirSync(ordinary);
    fs.writeFileSync(path.join(ordinary, "ordinary.txt"), "ordinary copy\n");
    fs.mkdirSync(path.join(nested, "inside"), { recursive: true });
    fs.writeFileSync(path.join(nested, "inside", "metadata-review.json"), "safe nested copy\n");
    fs.mkdirSync(cyclic);
    fs.symlinkSync(".", path.join(cyclic, "loop"), "dir");
    fs.writeFileSync(path.join(files.root, "review-backup.json"), originalReview);
    fs.symlinkSync(".", path.join(files.root, "root-alias"), "dir");
    fs.symlinkSync(".", path.join(files.root, "loop"), "dir");
    fs.symlinkSync("incoming", path.join(files.root, "incoming-dereferenced-link"), "dir");
    fs.symlinkSync("ordinary", path.join(files.root, "ordinary-dereferenced-link"), "dir");

    runGuarded(files, `
      (async () => {
        const assert = require("node:assert/strict");
        const fs = require("node:fs");
        const fsp = require("node:fs/promises");
        const blocked = (fn) => assert.throws(fn, (error) => error.code === "ERR_ROOT_REVIEW_ARTIFACT_WRITE");
        const callbackBlocked = (invoke) => new Promise((resolve, reject) => invoke((error) => {
          try { assert.equal(error && error.code, "ERR_ROOT_REVIEW_ARTIFACT_WRITE"); resolve(); } catch (failure) { reject(failure); }
        }));
        const before = fs.readFileSync("metadata-review.json");
        blocked(() => fs.cpSync("incoming", ".", { recursive: true }));
        await callbackBlocked((done) => fs.cp("incoming", ".", { recursive: true }, done));
        await assert.rejects(fsp.cp("incoming", ".", { recursive: true }), (error) => error.code === "ERR_ROOT_REVIEW_ARTIFACT_WRITE");
        blocked(() => fs.cpSync("incoming-dereferenced-link", ".", { recursive: true, dereference: true }));
        await callbackBlocked((done) => fs.cp("incoming-dereferenced-link", ".", { recursive: true, dereference: true }, done));
        await assert.rejects(fsp.cp("incoming-dereferenced-link", ".", { recursive: true, dereference: true }), (error) => error.code === "ERR_ROOT_REVIEW_ARTIFACT_WRITE");
        blocked(() => fs.cpSync("cyclic", ".", { recursive: true, dereference: true }));
        blocked(() => fs.cpSync("incoming", "root-alias", { recursive: true }));
        blocked(() => fs.copyFileSync("review-backup.json", "metadata-review.json"));
        assert.equal(fs.existsSync("sidecar.txt"), false);
        assert.deepEqual(fs.readFileSync("metadata-review.json"), before);

        fs.cpSync("ordinary", "ordinary-copy", { recursive: true });
        await new Promise((resolve, reject) => fs.cp("ordinary", "ordinary-callback-copy", { recursive: true }, (error) => error ? reject(error) : resolve()));
        await fsp.cp("ordinary", "ordinary-promise-copy", { recursive: true });
        fs.cpSync("ordinary-dereferenced-link", "ordinary-dereferenced-copy", { recursive: true, dereference: true });
        fs.cpSync("nested", ".", { recursive: true });
        assert.equal(fs.readFileSync("ordinary-copy/ordinary.txt", "utf8"), "ordinary copy\\n");
        assert.equal(fs.readFileSync("ordinary-callback-copy/ordinary.txt", "utf8"), "ordinary copy\\n");
        assert.equal(fs.readFileSync("ordinary-promise-copy/ordinary.txt", "utf8"), "ordinary copy\\n");
        assert.equal(fs.readFileSync("ordinary-dereferenced-copy/ordinary.txt", "utf8"), "ordinary copy\\n");
        assert.equal(fs.readFileSync("inside/metadata-review.json", "utf8"), "safe nested copy\\n");
      })().catch((error) => { process.nextTick(() => { throw error; }); });
    `);
    assert.deepEqual(fs.readFileSync(files.reviewPath), originalReview);
    assert.equal(fs.existsSync(path.join(files.root, "sidecar.txt")), false);
  } finally {
    clean(files);
  }
});

test("rename, link, and symlink block both protected sources and destinations", () => {
  const files = workspace();
  try {
    setupReview(files);
    fs.writeFileSync(path.join(files.root, "source.json"), "source\n");
    runGuarded(files, `
      const assert = require("node:assert/strict");
      const fs = require("node:fs");
      const blocked = (fn) => assert.throws(fn, (error) => error.code === "ERR_ROOT_REVIEW_ARTIFACT_WRITE");
      blocked(() => fs.renameSync("metadata-review.json", "moved.json"));
      blocked(() => fs.renameSync("source.json", "metadata-review.json"));
      blocked(() => fs.linkSync("metadata-review.json", "review-hardlink.json"));
      blocked(() => fs.linkSync("source.json", "metadata-review.json"));
      blocked(() => fs.symlinkSync("metadata-review.json", "review-symlink.json"));
      blocked(() => fs.symlinkSync("source.json", "metadata-review.json"));
    `);
    assert.deepEqual(fs.readFileSync(files.reviewPath), originalReview);
  } finally {
    clean(files);
  }
});

test("recursive removal and rename reject lexical and symlinked root ancestors before disposable cleanup can mutate artifacts", () => {
  const files = workspace();
  try {
    setupReview(files);
    fs.mkdirSync(path.join(files.root, "disposable"));
    fs.writeFileSync(path.join(files.root, "disposable", "cleanup.txt"), "cleanup\n");
    fs.mkdirSync(path.join(files.root, "source"));
    fs.writeFileSync(path.join(files.root, "source", "move.txt"), "move\n");
    fs.symlinkSync(".", path.join(files.root, "root-alias"), "dir");
    runGuarded(files, `
      (async () => {
        const assert = require("node:assert/strict");
        const fs = require("node:fs");
        const fsp = require("node:fs/promises");
        const blocked = (fn) => assert.throws(fn, (error) => error.code === "ERR_ROOT_REVIEW_ARTIFACT_WRITE");
        const callbackBlocked = (invoke) => new Promise((resolve, reject) => invoke((error) => {
          try { assert.equal(error && error.code, "ERR_ROOT_REVIEW_ARTIFACT_WRITE"); resolve(); } catch (failure) { reject(failure); }
        }));
        const before = fs.readFileSync("metadata-review.json");

        blocked(() => fs.rmSync(".", { recursive: true, force: true }));
        await callbackBlocked((done) => fs.rm(".", { recursive: true, force: true }, done));
        await assert.rejects(fsp.rm(".", { recursive: true, force: true }), (error) => error.code === "ERR_ROOT_REVIEW_ARTIFACT_WRITE");
        blocked(() => fs.rmdirSync(".", { recursive: true }));
        await callbackBlocked((done) => fs.rmdir(".", { recursive: true }, done));
        await assert.rejects(fsp.rmdir(".", { recursive: true }), (error) => error.code === "ERR_ROOT_REVIEW_ARTIFACT_WRITE");

        blocked(() => fs.renameSync(".", "moved-root"));
        await callbackBlocked((done) => fs.rename(".", "moved-root-callback", done));
        await assert.rejects(fsp.rename(".", "moved-root-promise"), (error) => error.code === "ERR_ROOT_REVIEW_ARTIFACT_WRITE");
        blocked(() => fs.renameSync("source", "."));
        await callbackBlocked((done) => fs.rename("source", ".", done));
        await assert.rejects(fsp.rename("source", "."), (error) => error.code === "ERR_ROOT_REVIEW_ARTIFACT_WRITE");
        blocked(() => fs.rmSync("root-alias", { recursive: true, force: true }));
        blocked(() => fs.renameSync("root-alias", "moved-alias"));

        fs.rmSync("disposable", { recursive: true, force: true });
        assert.equal(fs.existsSync("disposable"), false);
        assert.equal(fs.readFileSync("source/move.txt", "utf8"), "move\\n");
        assert.deepEqual(fs.readFileSync("metadata-review.json"), before);
      })().catch((error) => { process.nextTick(() => { throw error; }); });
    `);
    assert.deepEqual(fs.readFileSync(files.reviewPath), originalReview);
    assert.equal(fs.existsSync(path.join(files.root, "source", "move.txt")), true);
    assert.equal(fs.existsSync(path.join(files.root, "disposable")), false);
  } finally {
    clean(files);
  }
});

test("final symlink aliases block sync, callback, promise, and stream overwrite attempts", () => {
  const files = workspace();
  const alias = path.join(files.root, "transient-review-alias.json");
  try {
    setupReview(files);
    fs.symlinkSync("metadata-review.json", alias);
    runGuarded(files, `
      (async () => {
        const assert = require("node:assert/strict");
        const fs = require("node:fs");
        const fsp = require("node:fs/promises");
        const blocked = (fn) => assert.throws(fn, (error) => error.code === "ERR_ROOT_REVIEW_ARTIFACT_WRITE");
        const callbackBlocked = (invoke) => new Promise((resolve, reject) => invoke((error) => {
          try { assert.equal(error && error.code, "ERR_ROOT_REVIEW_ARTIFACT_WRITE"); resolve(); } catch (failure) { reject(failure); }
        }));
        const before = fs.readFileSync("metadata-review.json");
        blocked(() => fs.writeFileSync("transient-review-alias.json", "sync overwrite"));
        await callbackBlocked((done) => fs.appendFile("transient-review-alias.json", "callback overwrite", done));
        await assert.rejects(fsp.writeFile("transient-review-alias.json", "promise overwrite"), (error) => error.code === "ERR_ROOT_REVIEW_ARTIFACT_WRITE");
        blocked(() => fs.createWriteStream("transient-review-alias.json"));
        assert.deepEqual(fs.readFileSync("metadata-review.json"), before);
      })().catch((error) => { process.nextTick(() => { throw error; }); });
    `);
    assert.deepEqual(fs.readFileSync(files.reviewPath), originalReview);
    assert.equal(fs.readlinkSync(alias), "metadata-review.json");
  } finally {
    clean(files);
  }
});

test("pre-existing hardlink aliases and fd write APIs are blocked before bytes change", () => {
  const files = workspace();
  const alias = path.join(files.root, "review-hardlink.json");
  try {
    setupReview(files);
    fs.linkSync(files.reviewPath, alias);
    runGuarded(files, `
      const assert = require("node:assert/strict");
      const fs = require("node:fs");
      const blocked = (fn) => assert.throws(fn, (error) => error.code === "ERR_ROOT_REVIEW_ARTIFACT_WRITE");
      blocked(() => fs.writeFileSync("review-hardlink.json", "overwrite"));
      blocked(() => fs.appendFileSync("review-hardlink.json", "append"));
      blocked(() => fs.truncateSync("review-hardlink.json", 0));
      blocked(() => fs.createWriteStream("review-hardlink.json"));
    `);
    assert.deepEqual(fs.readFileSync(files.reviewPath), originalReview);
    assert.deepEqual(fs.readFileSync(alias), originalReview);
  } finally {
    clean(files);
  }
});

test("inherited writable descriptors block sync and callback mutations immediately", () => {
  const files = workspace();
  let descriptor;
  try {
    setupReview(files);
    descriptor = fs.openSync(files.reviewPath, "r+");
    runGuarded(files, `
      (async () => {
        const assert = require("node:assert/strict");
        const fs = require("node:fs");
        const blocked = (fn) => assert.throws(fn, (error) => error.code === "ERR_ROOT_REVIEW_ARTIFACT_WRITE");
        const callbackBlocked = (invoke) => new Promise((resolve, reject) => invoke((error) => {
          try { assert.equal(error && error.code, "ERR_ROOT_REVIEW_ARTIFACT_WRITE"); resolve(); } catch (failure) { reject(failure); }
        }));
        blocked(() => fs.ftruncateSync(3, 0));
        blocked(() => fs.writeSync(3, "sync"));
        blocked(() => fs.writevSync(3, [Buffer.from("syncv")]));
        blocked(() => fs.writeFileSync(3, "sync file"));
        blocked(() => fs.appendFileSync(3, "sync append"));
        blocked(() => fs.createWriteStream("unused-path", { fd: 3, autoClose: false }));
        await callbackBlocked((done) => fs.ftruncate(3, 0, done));
        await callbackBlocked((done) => fs.write(3, "callback", done));
        await callbackBlocked((done) => fs.writev(3, [Buffer.from("callbackv")], done));
        await callbackBlocked((done) => fs.writeFile(3, "callback file", done));
        await callbackBlocked((done) => fs.appendFile(3, "callback append", done));
      })().catch((error) => { process.nextTick(() => { throw error; }); });
    `, { stdio: ["ignore", "pipe", "pipe", descriptor] });
    assert.deepEqual(fs.readFileSync(files.reviewPath), originalReview);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    clean(files);
  }
});

test("descriptor metadata mutations are rejected before stable metadata or bytes change", () => {
  const files = workspace();
  let descriptor;
  const metadata = (stat) => ({ mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid, mtimeMs: stat.mtimeMs });
  try {
    setupReview(files);
    const before = metadata(fs.statSync(files.reviewPath));
    descriptor = fs.openSync(files.reviewPath, "r+");
    runGuarded(files, `
      (async () => {
        const assert = require("node:assert/strict");
        const fs = require("node:fs");
        const before = fs.fstatSync(3);
        const blocked = (fn) => assert.throws(fn, (error) => error.code === "ERR_ROOT_REVIEW_ARTIFACT_WRITE");
        const callbackBlocked = (invoke) => new Promise((resolve, reject) => invoke((error) => {
          try { assert.equal(error && error.code, "ERR_ROOT_REVIEW_ARTIFACT_WRITE"); resolve(); } catch (failure) { reject(failure); }
        }));
        blocked(() => fs.fchmodSync(3, 0o600));
        blocked(() => fs.futimesSync(3, before.atime, new Date(before.mtimeMs + 1000)));
        if (typeof fs.fchownSync === "function" && typeof process.getuid === "function" && typeof process.getgid === "function") {
          blocked(() => fs.fchownSync(3, process.getuid(), process.getgid()));
        }
        await callbackBlocked((done) => fs.fchmod(3, 0o600, done));
        await callbackBlocked((done) => fs.futimes(3, before.atime, new Date(before.mtimeMs + 1000), done));
        if (typeof fs.fchown === "function" && typeof process.getuid === "function" && typeof process.getgid === "function") {
          await callbackBlocked((done) => fs.fchown(3, process.getuid(), process.getgid(), done));
        }
        assert.equal(fs.readFileSync("metadata-review.json", "utf8"), ${JSON.stringify(originalReview.toString())});
      })().catch((error) => { process.nextTick(() => { throw error; }); });
    `, { stdio: ["ignore", "pipe", "pipe", descriptor] });
    assert.deepEqual(fs.readFileSync(files.reviewPath), originalReview);
    assert.deepEqual(metadata(fs.statSync(files.reviewPath)), before);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    clean(files);
  }
});

test("read-only promise handles remain readable while all reachable mutations are blocked", () => {
  const files = workspace();
  try {
    setupReview(files);
    runGuarded(files, `
      (async () => {
        const assert = require("node:assert/strict");
        const fsp = require("node:fs/promises");
        const handle = await fsp.open("metadata-review.json", "r");
        assert.equal((await handle.readFile()).toString(), ${JSON.stringify(originalReview.toString())});
        const blocked = (operation) => assert.rejects(operation, (error) => error.code === "ERR_ROOT_REVIEW_ARTIFACT_WRITE");
        await blocked(handle.write("write"));
        await blocked(handle.writev([Buffer.from("writev")]));
        await blocked(handle.truncate(0));
        await blocked(handle.writeFile("writeFile"));
        await blocked(handle.appendFile("appendFile"));
        await blocked(handle.chmod(0o600));
        await blocked(handle.utimes(new Date(), new Date()));
        if (typeof handle.chown === "function" && typeof process.getuid === "function" && typeof process.getgid === "function") {
          await blocked(handle.chown(process.getuid(), process.getgid()));
        }
        assert.throws(() => handle.createWriteStream(), (error) => error.code === "ERR_ROOT_REVIEW_ARTIFACT_WRITE");
        await handle.close();
      })().catch((error) => { process.nextTick(() => { throw error; }); });
    `);
    assert.deepEqual(fs.readFileSync(files.reviewPath), originalReview);
  } finally {
    clean(files);
  }
});

test("lock owner descendants are protected lexically and by preload inode across sync, callback, promise, stream, and handle APIs", () => {
  const files = workspace();
  try {
    setupReview(files);
    const artifacts = setupLockArtifacts(files);
    const hardlinkAlias = path.join(files.root, "preloaded-owner-hardlink.json");
    fs.linkSync(artifacts.owners[0], hardlinkAlias);
    fs.writeFileSync(path.join(files.root, "restore-owner.json"), "restore\n");
    const before = Object.fromEntries(artifacts.owners.map((owner) => [
      owner,
      { bytes: fs.readFileSync(owner).toString("base64"), metadata: stableMetadata(fs.statSync(owner)) },
    ]));

    runGuarded(files, `
      (async () => {
        const assert = require("node:assert/strict");
        const fs = require("node:fs");
        const fsp = require("node:fs/promises");
        const owners = ${JSON.stringify(artifacts.owners.map((owner) => path.relative(files.root, owner)))};
        const blocked = (fn) => assert.throws(fn, (error) => error.code === "ERR_ROOT_REVIEW_ARTIFACT_WRITE");
        const blockedAsync = (operation) => assert.rejects(operation, (error) => error.code === "ERR_ROOT_REVIEW_ARTIFACT_WRITE");
        const callbackBlocked = (invoke) => new Promise((resolve, reject) => invoke((error) => {
          try { assert.equal(error && error.code, "ERR_ROOT_REVIEW_ARTIFACT_WRITE"); resolve(); } catch (failure) { reject(failure); }
        }));

        for (const owner of owners) {
          const original = fs.readFileSync(owner, "utf8");
          assert.equal((await fsp.readFile(owner, "utf8")), original);
          blocked(() => fs.writeFileSync(owner, "overwrite"));
          blocked(() => fs.unlinkSync(owner));
          blocked(() => fs.renameSync("restore-owner.json", owner));
          blocked(() => fs.linkSync(owner, "owner-export.json"));
          blocked(() => fs.linkSync("restore-owner.json", owner));
          blocked(() => fs.createWriteStream(owner));
          blocked(() => fs.openSync(owner, "r+"));
          blocked(() => fs.chmodSync(owner, 0o600));
          const descriptor = fs.openSync(owner, "r");
          blocked(() => fs.writeSync(descriptor, "descriptor"));
          blocked(() => fs.createWriteStream("unused-path", { fd: descriptor, autoClose: false }));
          await callbackBlocked((done) => fs.appendFile(owner, "callback", done));
          await callbackBlocked((done) => fs.rename("restore-owner.json", owner, done));
          await callbackBlocked((done) => fs.chmod(owner, 0o600, done));
          await callbackBlocked((done) => fs.write(descriptor, "callback descriptor", done));
          fs.closeSync(descriptor);
          await blockedAsync(fsp.writeFile(owner, "promise"));
          await blockedAsync(fsp.unlink(owner));
          await blockedAsync(fsp.rename("restore-owner.json", owner));
          await blockedAsync(fsp.open(owner, "r+"));
          const handle = await fsp.open(owner, "r");
          assert.equal((await handle.readFile()).toString(), original);
          await blockedAsync(handle.write("handle"));
          await blockedAsync(handle.utimes(new Date(), new Date()));
          assert.throws(() => handle.createWriteStream(), (error) => error.code === "ERR_ROOT_REVIEW_ARTIFACT_WRITE");
          await handle.close();
        }

        blocked(() => fs.writeFileSync("preloaded-owner-hardlink.json", "inode overwrite"));
        fs.mkdirSync("unrelated.tmp-123");
        fs.writeFileSync("unrelated.tmp-123/owner.json", "safe\\n");
        assert.equal(fs.readFileSync("unrelated.tmp-123/owner.json", "utf8"), "safe\\n");
      })().catch((error) => { process.nextTick(() => { throw error; }); });
    `);

    for (const owner of artifacts.owners) {
      assert.deepEqual(
        { bytes: fs.readFileSync(owner).toString("base64"), metadata: stableMetadata(fs.statSync(owner)) },
        before[owner]
      );
    }
  } finally {
    clean(files);
  }
});

test("temporary review artifacts are ignored by exact Git patterns", () => {
  const files = workspace();
  try {
    const ignoreLines = fs.readFileSync(path.join(repositoryRoot, ".gitignore"), "utf8").trim().split(/\r?\n/);
    for (const pattern of [
      "/manual-media-notes.json", "/manual-media-notes.json.tmp-*",
      "/web-clips.json", "/web-clips.json.tmp-*",
      "/inspiration-index.json", "/inspiration-index.json.tmp-*",
      "/metadata-review.json", "/metadata-review.json.tmp-*",
      "/metadata-review.lock", "/metadata-review.lock.tmp-*", "/metadata-review.lock.stale-*",
    ]) assert.equal(ignoreLines.includes(pattern), true, pattern);
    assert.equal(ignoreLines.includes("manual-media-notes.json.tmp-*"), false);
    assert.equal(ignoreLines.includes("web-clips.json.tmp-*"), false);
    assert.equal(ignoreLines.includes("metadata-review.lock.tmp-*"), false);

    fs.copyFileSync(path.join(repositoryRoot, ".gitignore"), path.join(files.root, ".gitignore"));
    const initialized = spawnSync("git", ["init", "--quiet"], { cwd: files.root, encoding: "utf8" });
    assert.equal(initialized.status, 0, initialized.stderr);
    const ignored = (name) => {
      const result = spawnSync("git", ["check-ignore", "--quiet", "--", name], {
        cwd: files.root,
        encoding: "utf8",
      });
      assert.ok(result.status === 0 || result.status === 1, result.stderr);
      return result.status === 0;
    };

    for (const name of [
      "manual-media-notes.json", "manual-media-notes.json.tmp-public-fixture",
      "web-clips.json", "web-clips.json.tmp-public-fixture",
      "inspiration-index.json", "inspiration-index.json.tmp-public-fixture",
      "metadata-review.json", "metadata-review.json.tmp-public-fixture",
      "metadata-review.lock", "metadata-review.lock/owner-a.json",
      "metadata-review.lock.tmp-public-fixture/owner-a.json",
      "metadata-review.lock.stale-public-fixture/owner-a.json",
    ]) assert.equal(ignored(name), true, name);
    assert.equal(ignored("metadata-review.json.tmp"), false);
    assert.equal(ignored("web-clips.json.123.tmp"), false);
    assert.equal(ignored("metadata-review.lock.tmp/owner-a.json"), false);
    assert.equal(ignored("test/manual-media-notes.json.tmp-public-fixture"), false);
    assert.equal(ignored("test/web-clips.json.tmp-public-fixture"), false);
    assert.equal(ignored("test/inspiration-index.json.tmp-public-fixture"), false);
    assert.equal(ignored("test/metadata-review.json"), false);
    assert.equal(ignored("test/metadata-review.json.tmp-public-fixture"), false);
    assert.equal(ignored("docs/metadata-review.lock"), false);
    assert.equal(ignored("docs/metadata-review.lock.stale-public-fixture"), false);
  } finally {
    clean(files);
  }
});

test("NODE_OPTIONS carries the barrier into child processes", () => {
  const files = workspace();
  try {
    setupReview(files);
    runNode(files, `
      const assert = require("node:assert/strict");
      const { spawnSync } = require("node:child_process");
      const child = spawnSync(process.execPath, ["-e", \`
        const fs = require("node:fs");
        try { fs.writeFileSync("metadata-review.json", "child mutation"); } catch (error) {
          if (error.code === "ERR_ROOT_REVIEW_ARTIFACT_WRITE") process.exit(0);
        }
        process.exit(1);
      \`], { cwd: process.cwd(), env: process.env, encoding: "utf8" });
      assert.equal(child.status, 0, child.stderr);
    `, { env: { NODE_OPTIONS: `--require=${files.guardPath}` } });
    assert.deepEqual(fs.readFileSync(files.reviewPath), originalReview);
  } finally {
    clean(files);
  }
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  LOCK_STALE_MS,
  acquireLocalStateLock,
  lockOwnerFile,
  releaseLocalStateLock,
} = require("../lib/catalog/local-state-lock");

const lockErrors = {
  busy: () => Object.assign(new Error("busy"), { code: "busy" }),
  failed: () => Object.assign(new Error("failed"), { code: "failed" }),
};

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-state-lock-"));
  return { root, lockPath: path.join(root, "state.lock") };
}

function acquire(lockPath, options = {}) {
  return acquireLocalStateLock(lockPath, { errors: lockErrors, ...options });
}

function writeOwner(lockPath, owner) {
  fs.mkdirSync(lockPath);
  fs.writeFileSync(lockOwnerFile(lockPath, owner.token), JSON.stringify(owner));
}

test("shared locks keep fresh live and malformed owners busy and recover dead or malformed stale owners once", () => {
  const files = workspace();
  try {
    const live = { schemaVersion: 1, pid: process.pid, createdAt: 0, token: "a".repeat(64) };
    writeOwner(files.lockPath, live);
    assert.throws(() => acquire(files.lockPath, { now: LOCK_STALE_MS + 1 }), (error) => error.code === "busy");
    fs.rmSync(files.lockPath, { recursive: true });

    fs.mkdirSync(files.lockPath);
    assert.throws(() => acquire(files.lockPath, { now: Date.now() }), (error) => error.code === "busy");
    fs.rmSync(files.lockPath, { recursive: true });

    fs.mkdirSync(files.lockPath);
    fs.writeFileSync(path.join(files.lockPath, "malformed-owner"), "invalid");
    assert.throws(() => acquire(files.lockPath, { now: Date.now() }), (error) => error.code === "busy");
    const old = new Date(Date.now() - LOCK_STALE_MS - 1000);
    fs.utimesSync(files.lockPath, old, old);
    const malformedRecovery = acquire(files.lockPath);
    releaseLocalStateLock(files.lockPath, malformedRecovery);

    const dead = { schemaVersion: 1, pid: 99999999, createdAt: 0, token: "b".repeat(64) };
    writeOwner(files.lockPath, dead);
    const deadRecovery = acquire(files.lockPath, { now: LOCK_STALE_MS + 1 });
    releaseLocalStateLock(files.lockPath, deadRecovery);
    assert.equal(fs.existsSync(files.lockPath), false);
  } finally {
    fs.rmSync(files.root, { recursive: true, force: true });
  }
});

test("stale claims preserve a replacement and owner release never removes a successor", () => {
  const files = workspace();
  try {
    const stale = { schemaVersion: 1, pid: 99999999, createdAt: 0, token: "c".repeat(64) };
    const replacement = { schemaVersion: 1, pid: process.pid, createdAt: LOCK_STALE_MS + 1, token: "d".repeat(64) };
    writeOwner(files.lockPath, stale);
    assert.throws(() => acquire(files.lockPath, {
      now: LOCK_STALE_MS + 1,
      beforeStaleClaim: () => {
        fs.rmSync(files.lockPath, { recursive: true });
        writeOwner(files.lockPath, replacement);
      },
    }), (error) => error.code === "busy");
    assert.equal(fs.existsSync(lockOwnerFile(files.lockPath, replacement.token)), true);

    fs.rmSync(files.lockPath, { recursive: true });
    const original = acquire(files.lockPath, { now: 0 });
    fs.writeFileSync(lockOwnerFile(files.lockPath, original.token), JSON.stringify({ ...original, pid: 99999999, createdAt: 0 }));
    const successor = acquire(files.lockPath, { now: LOCK_STALE_MS + 1 });
    releaseLocalStateLock(files.lockPath, original);
    assert.equal(fs.existsSync(lockOwnerFile(files.lockPath, successor.token)), true);
    releaseLocalStateLock(files.lockPath, successor);
  } finally {
    fs.rmSync(files.root, { recursive: true, force: true });
  }
});

test("malformed lock names are treated as opaque data and cannot escape the lock directory", () => {
  const files = workspace();
  try {
    const sentinel = path.join(files.root, "sentinel");
    fs.writeFileSync(sentinel, "keep");
    fs.mkdirSync(files.lockPath);
    fs.writeFileSync(path.join(files.lockPath, "owner-..%2fsentinel.json"), "invalid");
    const old = new Date(Date.now() - LOCK_STALE_MS - 1000);
    fs.utimesSync(files.lockPath, old, old);
    const owner = acquire(files.lockPath);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");
    assert.match(fs.readdirSync(files.root).find((name) => name.startsWith("state.lock.stale-")), /^state\.lock\.stale-[0-9a-f]{64}$/);
    releaseLocalStateLock(files.lockPath, owner);
  } finally {
    fs.rmSync(files.root, { recursive: true, force: true });
  }
});

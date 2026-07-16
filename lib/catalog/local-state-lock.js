const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { sha256Canonical } = require("./canonical");

const LOCK_STALE_MS = 60 * 1000;
const TOKEN = /^[0-9a-f]{64}$/;

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function createLockOwner(now) {
  return { schemaVersion: 1, pid: process.pid, createdAt: now, token: crypto.randomBytes(32).toString("hex") };
}

function lockOwnerFile(lockPath, token) {
  return path.join(lockPath, `owner-${token}.json`);
}

function opaqueLockToken(parts) {
  return sha256Canonical(parts);
}

function statIdentity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs];
}

function sameStatIdentity(left, right) {
  return Boolean(left && right && statIdentity(left).every((value, index) => value === statIdentity(right)[index]));
}

function readLocalStateLock(lockPath) {
  let stat;
  try { stat = fs.lstatSync(lockPath); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isDirectory()) {
    let payload = null;
    try { payload = JSON.parse(fs.readFileSync(lockPath, "utf8")); } catch {}
    const token = typeof payload?.token === "string" && TOKEN.test(payload.token)
      ? payload.token
      : opaqueLockToken(["local-state-lock-file-v1", ...statIdentity(stat)]);
    return { legacy: true, payload, stat, token };
  }
  try {
    const names = fs.readdirSync(lockPath).sort();
    if (names.length !== 1 || !/^owner-[0-9a-f]{64}\.json$/.test(names[0])) {
      return { malformed: true, stat, token: opaqueLockToken(["local-state-lock-directory-v1", ...statIdentity(stat), names]) };
    }
    const payload = JSON.parse(fs.readFileSync(path.join(lockPath, names[0]), "utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.schemaVersion !== 1 ||
      !Number.isInteger(payload.pid) || !Number.isFinite(payload.createdAt) || !TOKEN.test(payload.token) ||
      names[0] !== `owner-${payload.token}.json`) {
      return { malformed: true, stat, token: opaqueLockToken(["local-state-lock-owner-v1", ...statIdentity(stat), names]) };
    }
    return { payload, stat, token: payload.token };
  } catch {
    return { malformed: true, stat, token: opaqueLockToken(["local-state-lock-unreadable-v1", ...statIdentity(stat)]) };
  }
}

function staleLock(lock, now) {
  const createdAt = Number(lock?.payload?.createdAt);
  const age = now - (Number.isFinite(createdAt) ? createdAt : lock.stat.mtimeMs);
  return age > LOCK_STALE_MS && !processIsRunning(lock?.payload?.pid);
}

function prepareLock(lockPath, owner) {
  const tempPath = `${lockPath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
  fs.mkdirSync(tempPath, { mode: 0o700 });
  try {
    fs.writeFileSync(lockOwnerFile(tempPath, owner.token), JSON.stringify(owner), { encoding: "utf8", flag: "wx", mode: 0o600 });
    return tempPath;
  } catch (error) {
    try { fs.rmSync(tempPath, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

function installPreparedLock(tempPath, lockPath, owner, errors) {
  try {
    fs.mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes(error.code)) return false;
    throw errors.failed();
  }
  try {
    fs.renameSync(lockOwnerFile(tempPath, owner.token), lockOwnerFile(lockPath, owner.token));
    return true;
  } catch {
    try { fs.unlinkSync(lockOwnerFile(lockPath, owner.token)); } catch {}
    try { fs.rmdirSync(lockPath); } catch {}
    throw errors.failed();
  } finally {
    try { fs.rmSync(tempPath, { recursive: true, force: true }); } catch {}
  }
}

function sameObservedLock(expected, actual) {
  return Boolean(expected && actual && expected.token === actual.token && sameStatIdentity(expected.stat, actual.stat));
}

function acquireLocalStateLock(lockPath, options = {}) {
  const errors = options.errors;
  if (!errors?.busy || !errors?.failed) throw new TypeError("Local-state lock errors are required.");
  const now = options.now ?? Date.now();
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch { throw errors.failed(); }
  const owner = createLockOwner(now);
  let tempPath;
  try { tempPath = prepareLock(lockPath, owner); } catch { throw errors.failed(); }
  if (installPreparedLock(tempPath, lockPath, owner, errors)) return owner;

  let current;
  try { current = readLocalStateLock(lockPath); } catch { throw errors.failed(); }
  if (!current || !staleLock(current, now)) throw errors.busy();
  if (options.beforeStaleClaim) options.beforeStaleClaim(current);
  let latest;
  try { latest = readLocalStateLock(lockPath); } catch { throw errors.busy(); }
  if (!sameObservedLock(current, latest)) throw errors.busy();

  const claimPath = `${lockPath}.stale-${current.token}`;
  try { fs.renameSync(lockPath, claimPath); } catch { throw errors.busy(); }
  let claimed;
  try { claimed = readLocalStateLock(claimPath); } catch { throw errors.busy(); }
  if (!sameObservedLock(current, claimed)) throw errors.busy();

  try { tempPath = prepareLock(lockPath, owner); } catch { throw errors.failed(); }
  if (installPreparedLock(tempPath, lockPath, owner, errors)) return owner;
  throw errors.busy();
}

function releaseLocalStateLock(lockPath, owner) {
  if (!owner?.token || !TOKEN.test(owner.token)) return;
  let current;
  try { current = readLocalStateLock(lockPath); } catch { return; }
  if (!current?.payload || current.payload.token !== owner.token) return;
  try { fs.unlinkSync(lockOwnerFile(lockPath, owner.token)); } catch { return; }
  try { fs.rmdirSync(lockPath); } catch {}
}

module.exports = {
  LOCK_STALE_MS,
  acquireLocalStateLock,
  lockOwnerFile,
  readLocalStateLock,
  releaseLocalStateLock,
  sameObservedLock,
};

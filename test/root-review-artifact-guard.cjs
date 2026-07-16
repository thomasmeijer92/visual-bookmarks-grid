const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { fileURLToPath, URL } = require("node:url");

const rootDir = path.resolve(__dirname, "..");
const realRootDir = fs.realpathSync.native(rootDir);
const MAX_RECURSIVE_COPY_DIRECTORIES = 10000;
const artifactName = (name) => name === "metadata-review.json" ||
  name.startsWith("metadata-review.json.tmp-") ||
  name === "metadata-review.lock" ||
  name.startsWith("metadata-review.lock.tmp-") ||
  name.startsWith("metadata-review.lock.stale-") ||
  name === "boards.json" ||
  name.startsWith("boards.json.tmp-") ||
  name === "boards.lock" ||
  name.startsWith("boards.lock.tmp-") ||
  name.startsWith("boards.lock.stale-") ||
  name === "web-clips.json" ||
  name.startsWith("web-clips.json.tmp-") ||
  name === "manual-media-notes.json" ||
  name.startsWith("manual-media-notes.json.tmp-") ||
  name === "inspiration-index.json" ||
  name.startsWith("inspiration-index.json.tmp-");

function filePath(value, base) {
  try {
    if (Buffer.isBuffer(value)) value = value.toString();
    else if (value instanceof URL) value = fileURLToPath(value);
    return typeof value === "string" ? path.resolve(base || process.cwd(), value) : null;
  } catch {
    return null;
  }
}

function inode(stat) {
  return `${stat.dev}:${stat.ino}`;
}

const protectedInodes = new Map();
function rootArtifact(candidate) {
  if (!candidate || !containsPath(realRootDir, candidate)) return null;
  const relative = path.relative(realRootDir, candidate);
  const [name] = relative.split(path.sep);
  return artifactName(name) ? path.join(realRootDir, name) : null;
}

function recordProtectedInodes(filePath, artifact, visited = new Set()) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return; }
  const key = inode(stat);
  if (visited.has(key)) return;
  visited.add(key);
  protectedInodes.set(key, artifact);
  if (!stat.isDirectory()) return;
  try {
    for (const name of fs.readdirSync(filePath)) recordProtectedInodes(path.join(filePath, name), artifact, visited);
  } catch {
    // A disappearing owner record is still covered lexically by its private root.
  }
}

for (const name of fs.readdirSync(rootDir).filter(artifactName)) {
  const artifact = path.join(realRootDir, name);
  recordProtectedInodes(artifact, artifact);
}

function normalizedPath(value) {
  const resolved = filePath(value);
  if (!resolved) return null;
  try {
    return path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved));
  } catch {
    return resolved;
  }
}

function protectedPath(value, visited = new Set()) {
  const resolved = filePath(value);
  if (!resolved || visited.has(resolved)) return null;
  visited.add(resolved);

  for (const candidate of [resolved, normalizedPath(resolved)]) {
    const lexical = rootArtifact(candidate);
    if (lexical) return lexical;
  }

  try {
    const canonical = fs.realpathSync.native(resolved);
    const protectedCanonical = rootArtifact(canonical);
    if (protectedCanonical) return protectedCanonical;
  } catch {
    // A final dangling symlink still has a target worth checking below.
  }

  try {
    const known = protectedInodes.get(inode(fs.statSync(resolved)));
    if (known) return known;
  } catch {
    // The path need not exist for lexical paths to be protected.
  }

  try {
    if (!fs.lstatSync(resolved).isSymbolicLink()) return null;
    const parent = normalizedPath(path.dirname(resolved)) || path.dirname(resolved);
    return protectedPath(path.resolve(parent, fs.readlinkSync(resolved)), visited);
  } catch {
    return null;
  }
}

function protectedDescriptor(value) {
  if (!Number.isInteger(value)) return null;
  try {
    return protectedInodes.get(inode(fs.fstatSync(value))) || null;
  } catch {
    return null;
  }
}

function protectedTarget(value) {
  return protectedPath(value) || protectedDescriptor(value) ||
    (value && Number.isInteger(value.fd) ? protectedDescriptor(value.fd) : null);
}

function violation(target) {
  const error = new Error(`Repository review artifact writes are blocked during tests: ${target}`);
  error.code = "ERR_ROOT_REVIEW_ARTIFACT_WRITE";
  error.path = target;
  return error;
}

function blockedTarget(args, indexes) {
  if (typeof indexes === "function") return indexes(args);
  for (const index of indexes) {
    const target = protectedTarget(args[index]);
    if (target) return target;
  }
  return null;
}

function symlinkTarget(args) {
  const destination = filePath(args[1]);
  const target = filePath(args[0], destination && path.dirname(destination));
  return protectedPath(target) || protectedTarget(args[1]);
}

function protectedArtifactWithinDirectory(value) {
  const resolved = filePath(value);
  if (!resolved) return null;
  try {
    return fs.realpathSync.native(resolved) === realRootDir ? path.join(realRootDir, "metadata-review.json") : null;
  } catch {
    return resolved === realRootDir ? path.join(realRootDir, "metadata-review.json") : null;
  }
}

function containsPath(ancestor, candidate) {
  const relative = path.relative(ancestor, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function protectedArtifactAncestor(value) {
  const resolved = filePath(value);
  if (!resolved) return null;
  const candidates = [resolved, normalizedPath(resolved)];
  try { candidates.push(fs.realpathSync.native(resolved)); } catch {}
  if (candidates.some((candidate) => candidate && containsPath(candidate, realRootDir))) {
    return path.join(realRootDir, "metadata-review.json");
  }
  return null;
}

function recursiveRemovalTarget(args) {
  const target = protectedTarget(args[0]);
  if (target) return target;
  return args[1]?.recursive === true ? protectedArtifactAncestor(args[0]) : null;
}

function renameTarget(args) {
  for (const value of [args[0], args[1]]) {
    const target = protectedTarget(value) || protectedArtifactAncestor(value);
    if (target) return target;
  }
  return null;
}

function copyStat(value, dereference) {
  return dereference ? fs.statSync(value) : fs.lstatSync(value);
}

function recursiveCopyTarget(args) {
  const directTarget = protectedTarget(args[1]);
  if (directTarget) return directTarget;
  const options = args[2];
  if (!options || options.recursive !== true) return null;

  const source = filePath(args[0]);
  const destination = filePath(args[1]);
  if (!source || !destination) return null;
  const dereference = options.dereference === true;
  let rootStat;
  try {
    rootStat = copyStat(source, dereference);
  } catch {
    return dereference ? protectedArtifactWithinDirectory(destination) : null;
  }
  if (!rootStat.isDirectory()) return null;

  const pending = [[source, destination, rootStat, new Set()]];
  let inspectedDirectories = 0;
  while (pending.length > 0) {
    const [sourceDirectory, destinationDirectory, directoryStat, ancestors] = pending.pop();
    const directoryInode = inode(directoryStat);
    if (ancestors.has(directoryInode)) {
      const target = protectedArtifactWithinDirectory(destinationDirectory);
      if (target) return target;
      continue;
    }
    if (inspectedDirectories >= MAX_RECURSIVE_COPY_DIRECTORIES) {
      return protectedArtifactWithinDirectory(destinationDirectory) ||
        pending.map(([, candidate]) => protectedArtifactWithinDirectory(candidate)).find(Boolean) || null;
    }
    inspectedDirectories++;

    let names;
    try {
      names = fs.readdirSync(sourceDirectory).sort();
    } catch {
      const target = protectedArtifactWithinDirectory(destinationDirectory);
      if (target) return target;
      // Let fs.cp* report unreadable source directories through its normal API.
      continue;
    }
    const nextAncestors = new Set(ancestors).add(directoryInode);
    for (const name of names) {
      const sourceEntry = path.join(sourceDirectory, name);
      const destinationEntry = path.join(destinationDirectory, name);
      const target = protectedPath(destinationEntry);
      if (target) return target;
      try {
        const entryStat = copyStat(sourceEntry, dereference);
        if (!entryStat.isDirectory()) continue;
        if (nextAncestors.has(inode(entryStat))) {
          const cycleTarget = protectedArtifactWithinDirectory(destinationEntry);
          if (cycleTarget) return cycleTarget;
          continue;
        }
        pending.push([sourceEntry, destinationEntry, entryStat, nextAncestors]);
      } catch {
        // An uninspectable dereferenced target is safe only when it cannot map into the root.
        const unresolvedTarget = dereference && protectedArtifactWithinDirectory(destinationEntry);
        if (unresolvedTarget) return unresolvedTarget;
      }
    }
  }
  return null;
}

function writeFlags(flags) {
  if (typeof flags === "string") return /[wa+]/.test(flags);
  if (typeof flags === "number") {
    const { O_ACCMODE, O_WRONLY, O_RDWR, O_APPEND, O_CREAT, O_TRUNC } = fs.constants;
    return (flags & O_ACCMODE) === O_WRONLY || (flags & O_ACCMODE) === O_RDWR ||
      Boolean(flags & (O_APPEND | O_CREAT | O_TRUNC));
  }
  return false;
}

function patchSync(method, indexes, predicate = () => true) {
  const original = fs[method];
  if (typeof original !== "function") return;
  fs[method] = function guardedSync(...args) {
    const target = predicate(args) && blockedTarget(args, indexes);
    if (target) throw violation(target);
    return original.apply(this, args);
  };
}

function patchCallback(method, indexes, predicate = () => true) {
  const original = fs[method];
  if (typeof original !== "function") return;
  fs[method] = function guardedCallback(...args) {
    const target = predicate(args) && blockedTarget(args, indexes);
    if (!target) return original.apply(this, args);
    const callback = [...args].reverse().find((value) => typeof value === "function");
    const error = violation(target);
    if (!callback) throw error;
    process.nextTick(callback, error);
  };
}

function patchPromise(method, indexes, predicate = () => true) {
  const original = fsp[method];
  if (typeof original !== "function") return;
  fsp[method] = function guardedPromise(...args) {
    const target = predicate(args) && blockedTarget(args, indexes);
    if (target) return Promise.reject(violation(target));
    return original.apply(this, args);
  };
}

for (const method of [
  "writeFileSync", "appendFileSync", "mkdirSync", "unlinkSync",
  "mkdtempSync", "truncateSync", "chmodSync", "chownSync", "utimesSync", "lchmodSync",
  "lchownSync", "lutimesSync",
]) patchSync(method, [0]);
for (const method of ["writeSync", "writevSync", "ftruncateSync", "fchmodSync", "fchownSync", "futimesSync"]) patchSync(method, [0]);
for (const method of ["rmSync", "rmdirSync"]) patchSync(method, recursiveRemovalTarget);
patchSync("renameSync", renameTarget);
patchSync("linkSync", [0, 1]);
patchSync("symlinkSync", symlinkTarget);
patchSync("copyFileSync", [1]);
patchSync("cpSync", recursiveCopyTarget);
patchSync("openSync", [0], (args) => writeFlags(args[1]));

for (const method of [
  "writeFile", "appendFile", "mkdir", "unlink", "mkdtemp", "truncate",
  "chmod", "chown", "utimes", "lchmod", "lchown", "lutimes",
]) patchCallback(method, [0]);
for (const method of ["write", "writev", "ftruncate", "fchmod", "fchown", "futimes"]) patchCallback(method, [0]);
for (const method of ["rm", "rmdir"]) patchCallback(method, recursiveRemovalTarget);
patchCallback("rename", renameTarget);
patchCallback("link", [0, 1]);
patchCallback("symlink", symlinkTarget);
patchCallback("copyFile", [1]);
patchCallback("cp", recursiveCopyTarget);
patchCallback("open", [0], (args) => writeFlags(args[1]));

for (const method of [
  "writeFile", "appendFile", "mkdir", "unlink", "mkdtemp", "truncate",
  "chmod", "chown", "utimes", "lchmod", "lchown", "lutimes",
]) patchPromise(method, [0]);
for (const method of ["fchmod", "fchown", "futimes"]) patchPromise(method, [0]);
for (const method of ["rm", "rmdir"]) patchPromise(method, recursiveRemovalTarget);
patchPromise("rename", renameTarget);
patchPromise("link", [0, 1]);
patchPromise("symlink", symlinkTarget);
patchPromise("copyFile", [1]);
patchPromise("cp", recursiveCopyTarget);

const createWriteStream = fs.createWriteStream;
fs.createWriteStream = function guardedCreateWriteStream(file, options) {
  const target = protectedTarget(file) || protectedTarget(options && options.fd);
  if (target) throw violation(target);
  return createWriteStream.apply(this, arguments);
};

const guardedFileHandlePrototypes = new WeakSet();
function guardFileHandle(handle) {
  const prototype = handle && Object.getPrototypeOf(handle);
  if (!prototype || guardedFileHandlePrototypes.has(prototype)) return handle;
  guardedFileHandlePrototypes.add(prototype);
  for (const method of ["write", "writev", "truncate", "writeFile", "appendFile", "chmod", "chown", "utimes"]) {
    const original = prototype[method];
    if (typeof original !== "function") continue;
    prototype[method] = function guardedFileHandleMutation(...args) {
      const target = protectedDescriptor(this.fd);
      if (target) return Promise.reject(violation(target));
      return original.apply(this, args);
    };
  }
  const originalCreateWriteStream = prototype.createWriteStream;
  if (typeof originalCreateWriteStream === "function") {
    prototype.createWriteStream = function guardedFileHandleCreateWriteStream(...args) {
      const target = protectedDescriptor(this.fd);
      if (target) throw violation(target);
      return originalCreateWriteStream.apply(this, args);
    };
  }
  return handle;
}

const open = fsp.open;
fsp.open = function guardedOpen(...args) {
  const target = writeFlags(args[1]) && protectedTarget(args[0]);
  if (target) return Promise.reject(violation(target));
  return open.apply(this, args).then(guardFileHandle);
};

function snapshotPath(filePath) {
  const stat = fs.lstatSync(filePath);
  const metadata = {
    mode: stat.mode & 0o7777,
    uid: stat.uid,
    gid: stat.gid,
    mtimeMs: stat.mtimeMs,
  };
  if (stat.isDirectory()) {
    return {
      type: "directory",
      metadata,
      entries: fs.readdirSync(filePath).sort().map((name) => [name, snapshotPath(path.join(filePath, name))]),
    };
  }
  if (stat.isSymbolicLink()) return { type: "symlink", metadata, target: fs.readlinkSync(filePath) };
  return { type: "file", metadata, bytes: fs.readFileSync(filePath).toString("base64") };
}

function snapshot() {
  return Object.fromEntries(fs.readdirSync(rootDir)
    .filter(artifactName)
    .sort()
    .map((name) => [name, snapshotPath(path.join(rootDir, name))]));
}

const before = snapshot();

process.on("exit", () => {
  const after = snapshot();
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    process.exitCode = 1;
    process.stderr.write("Repository review artifacts changed during the test run.\n");
  }
});

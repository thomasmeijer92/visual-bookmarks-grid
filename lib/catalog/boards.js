const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { cleanString, compareStrings } = require("./canonical");
const { validTimestamp } = require("./bootstrap");
const {
  LOCK_STALE_MS,
  acquireLocalStateLock,
  releaseLocalStateLock,
} = require("./local-state-lock");

const BOARD_SCHEMA_VERSION = 1;
const MAX_BOARDS = 1000;
const MAX_BOARD_ITEMS = 100;
const MAX_NAME_LENGTH = 120;
const MAX_BRIEF_LENGTH = 4000;
const MAX_NOTE_LENGTH = 1000;
const MAX_MATCH_REASONS = 12;
const MAX_MATCH_REASON_LENGTH = 240;
const MAX_QUERY_SNAPSHOT_LENGTH = 16 * 1024;
const BOARD_ID = /^board:v1:[0-9a-f]{32}$/;

class BoardError extends Error {
  constructor(message, code = "boards_failed", statusCode = 400) {
    super(message);
    this.name = "BoardError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  const keys = Object.keys(value).sort(compareStrings);
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function boardPaths(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, "..", ".."));
  const boardsPath = path.resolve(options.boardsPath || process.env.BOARDS_PATH || path.join(rootDir, "boards.json"));
  return {
    rootDir,
    boardsPath,
    lockPath: path.resolve(options.lockPath || process.env.BOARDS_LOCK_PATH || `${boardsPath.replace(/\.json$/i, "")}.lock`),
  };
}

function emptyBoardDocument() {
  return { schemaVersion: BOARD_SCHEMA_VERSION, boards: [] };
}

function invalidBoardState() {
  return new BoardError("Board state is invalid.", "boards_invalid_state", 500);
}

function cleanBoardString(value, field, max, { allowEmpty = true } = {}) {
  try { return cleanString(value, { field, max, allowEmpty }); } catch { throw new BoardError("Board request is invalid.", "invalid_board_request"); }
}

function validateSnapshot(value, { request = false } = {}) {
  if (!isPlainObject(value)) {
    if (request) throw new BoardError("Board request is invalid.", "invalid_board_request");
    throw invalidBoardState();
  }
  const seen = new Set();
  let count = 0;
  const validateValue = (current, depth) => {
    if (depth > 8 || ++count > 500) throw new Error("too complex");
    if (current === null || typeof current === "boolean") return;
    if (typeof current === "string") {
      if (current.length > 4000 || /[\u0000-\u001f\u007f-\u009f]/.test(current)) throw new Error("invalid string");
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error("invalid number");
      return;
    }
    if (Array.isArray(current)) {
      if (current.length > 100) throw new Error("too many values");
      if (seen.has(current)) throw new Error("cycle");
      seen.add(current);
      current.forEach((entry) => validateValue(entry, depth + 1));
      seen.delete(current);
      return;
    }
    if (!isPlainObject(current) || seen.has(current) || Object.keys(current).length > 100) throw new Error("invalid object");
    seen.add(current);
    Object.keys(current).forEach((key) => {
      if (!key || key.length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(key)) throw new Error("invalid key");
      validateValue(current[key], depth + 1);
    });
    seen.delete(current);
  };
  try {
    validateValue(value, 0);
    const serialized = JSON.stringify(value);
    if (serialized.length > MAX_QUERY_SNAPSHOT_LENGTH) throw new Error("too large");
    return structuredClone(value);
  } catch {
    if (request) throw new BoardError("Board request is invalid.", "invalid_board_request");
    throw invalidBoardState();
  }
}

function validateBoardItem(raw, { request = false } = {}) {
  const fail = () => {
    if (request) throw new BoardError("Board request is invalid.", "invalid_board_request");
    throw invalidBoardState();
  };
  if (!isPlainObject(raw) || !exactKeys(raw, ["curationNote", "itemId", "matchReasonsAtSave"])) fail();
  if (typeof raw.itemId !== "string" || !/^visual:v1:[0-9a-f]{64}$/.test(raw.itemId)) fail();
  let curationNote;
  try {
    curationNote = cleanString(raw.curationNote, { field: "curationNote", max: MAX_NOTE_LENGTH });
    if (curationNote !== raw.curationNote) fail();
  } catch { fail(); }
  if (!Array.isArray(raw.matchReasonsAtSave) || raw.matchReasonsAtSave.length > MAX_MATCH_REASONS) fail();
  const reasons = [];
  for (const reason of raw.matchReasonsAtSave) {
    try {
      const clean = cleanString(reason, { field: "match reason", max: MAX_MATCH_REASON_LENGTH, allowEmpty: false });
      if (clean !== reason || reasons.includes(clean)) fail();
      reasons.push(clean);
    } catch { fail(); }
  }
  return { itemId: raw.itemId, curationNote, matchReasonsAtSave: reasons };
}

function validateBoard(raw) {
  if (!isPlainObject(raw) || !exactKeys(raw, ["brief", "createdAt", "id", "items", "name", "querySnapshot", "updatedAt"])) throw invalidBoardState();
  if (typeof raw.id !== "string" || !BOARD_ID.test(raw.id) ||
    typeof raw.createdAt !== "string" || validTimestamp(raw.createdAt) !== raw.createdAt ||
    typeof raw.updatedAt !== "string" || validTimestamp(raw.updatedAt) !== raw.updatedAt ||
    !Array.isArray(raw.items) || raw.items.length > MAX_BOARD_ITEMS) throw invalidBoardState();
  let name;
  let brief;
  try {
    name = cleanString(raw.name, { field: "name", max: MAX_NAME_LENGTH, allowEmpty: false });
    brief = cleanString(raw.brief, { field: "brief", max: MAX_BRIEF_LENGTH });
    if (name !== raw.name || brief !== raw.brief) throw new Error("not canonical");
  } catch { throw invalidBoardState(); }
  const seen = new Set();
  const items = raw.items.map((item) => {
    const normalized = validateBoardItem(item);
    if (seen.has(normalized.itemId)) throw invalidBoardState();
    seen.add(normalized.itemId);
    return normalized;
  });
  return {
    id: raw.id,
    name,
    brief,
    querySnapshot: validateSnapshot(raw.querySnapshot),
    items,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function validateBoardDocument(raw) {
  if (!isPlainObject(raw) || !exactKeys(raw, ["boards", "schemaVersion"]) || raw.schemaVersion !== BOARD_SCHEMA_VERSION ||
    !Array.isArray(raw.boards) || raw.boards.length > MAX_BOARDS) throw invalidBoardState();
  const boardIds = new Set();
  const boards = raw.boards.map((board) => {
    const normalized = validateBoard(board);
    if (boardIds.has(normalized.id)) throw invalidBoardState();
    boardIds.add(normalized.id);
    return normalized;
  });
  return { schemaVersion: BOARD_SCHEMA_VERSION, boards };
}

function readBoardDocument(filePath) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch (error) {
    if (error?.code === "ENOENT") return emptyBoardDocument();
    if (error instanceof SyntaxError) throw new BoardError("Board state is invalid.", "boards_invalid_json", 500);
    throw new BoardError("Board state could not be read.", "boards_read_failed", 500);
  }
  return validateBoardDocument(parsed);
}

function acquireBoardLock(lockPath, now = Date.now()) {
  return acquireLocalStateLock(lockPath, {
    now,
    errors: {
      busy: () => new BoardError("Boards are busy.", "boards_busy", 503),
      failed: () => new BoardError("Boards are unavailable.", "boards_lock_failed", 503),
    },
  });
}

function releaseBoardLock(lockPath, owner) {
  releaseLocalStateLock(lockPath, owner);
}

function atomicWriteBoardDocument(filePath, payload, options = {}) {
  const target = path.resolve(filePath);
  const serialized = `${JSON.stringify(validateBoardDocument(payload), null, 2)}\n`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let tempPath = "";
  let descriptor = null;
  let replaced = false;
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      tempPath = `${target}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
      try { descriptor = fs.openSync(tempPath, "wx", 0o600); break; } catch (error) {
        if (error?.code !== "EEXIST" || attempt === 7) throw error;
      }
    }
    if (options.beforeTempWrite) options.beforeTempWrite(tempPath, target);
    fs.writeFileSync(descriptor, serialized, "utf8");
    if (options.beforeTempFlush) options.beforeTempFlush(tempPath, target);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    if (options.beforeRename) options.beforeRename(tempPath, target);
    fs.renameSync(tempPath, target);
    replaced = true;
    if (options.beforeDirectorySync) options.beforeDirectorySync(path.dirname(target));
    let directoryDescriptor = null;
    try {
      directoryDescriptor = fs.openSync(path.dirname(target), "r");
      fs.fsyncSync(directoryDescriptor);
    } finally {
      if (directoryDescriptor !== null) fs.closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== null) try { fs.closeSync(descriptor); } catch {}
    if (!replaced && tempPath) try { fs.unlinkSync(tempPath); } catch {}
    if (error instanceof BoardError) throw error;
    throw new BoardError("Board state could not be written.", "boards_write_failed", 500);
  }
}

function withBoardLock(options, operation) {
  const paths = boardPaths(options);
  let owner;
  try {
    owner = acquireBoardLock(paths.lockPath, options.lockNow || Date.now());
  } catch (error) {
    if (error instanceof BoardError) throw error;
    throw new BoardError("Boards are unavailable.", "boards_lock_failed", 503);
  }
  try {
    return operation(paths);
  } finally {
    try { (options.releaseLock || releaseBoardLock)(paths.lockPath, owner); } catch {}
  }
}

function catalogIds(catalog) {
  return new Set(Array.isArray(catalog?.items) ? catalog.items.map((item) => item.id) : []);
}

function requestItem(raw) {
  if (!isPlainObject(raw) || !Object.keys(raw).every((key) => ["itemId", "curationNote", "matchReasonsAtSave"].includes(key))) {
    throw new BoardError("Board request is invalid.", "invalid_board_request");
  }
  return validateBoardItem({
    itemId: raw.itemId,
    curationNote: raw.curationNote === undefined ? "" : raw.curationNote,
    matchReasonsAtSave: raw.matchReasonsAtSave === undefined ? [] : raw.matchReasonsAtSave,
  }, { request: true });
}

function invalidBoardRequest() {
  throw new BoardError("Board request is invalid.", "invalid_board_request");
}

function updateInput(raw) {
  if (!isPlainObject(raw) || Object.keys(raw).length === 0 || !Object.keys(raw).every((key) => ["name", "brief", "querySnapshot"].includes(key))) {
    invalidBoardRequest();
  }
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(raw, "name")) patch.name = cleanBoardString(raw.name, "name", MAX_NAME_LENGTH, { allowEmpty: false });
  if (Object.prototype.hasOwnProperty.call(raw, "brief")) patch.brief = cleanBoardString(raw.brief, "brief", MAX_BRIEF_LENGTH);
  if (Object.prototype.hasOwnProperty.call(raw, "querySnapshot")) patch.querySnapshot = validateSnapshot(raw.querySnapshot, { request: true });
  return patch;
}

function validateBoardMutationRequest(raw) {
  if (!isPlainObject(raw)) invalidBoardRequest();
  if (!Object.prototype.hasOwnProperty.call(raw, "action")) return { action: "update", patch: updateInput(raw) };
  if (typeof raw.action !== "string") invalidBoardRequest();

  if (raw.action === "add") {
    if (!exactKeys(raw, ["action", "item"])) invalidBoardRequest();
    return { action: "add", item: requestItem(raw.item) };
  }
  if (raw.action === "remove") {
    if (!exactKeys(raw, ["action", "itemId"]) || typeof raw.itemId !== "string") invalidBoardRequest();
    return { action: "remove", itemId: raw.itemId };
  }
  if (raw.action === "reorder") {
    if (!exactKeys(raw, ["action", "itemIds"]) || !Array.isArray(raw.itemIds) || raw.itemIds.some((itemId) => typeof itemId !== "string")) {
      invalidBoardRequest();
    }
    return { action: "reorder", itemIds: raw.itemIds };
  }
  if (raw.action === "curation-note") {
    if (!exactKeys(raw, ["action", "curationNote", "itemId"]) || typeof raw.itemId !== "string" || typeof raw.curationNote !== "string") {
      invalidBoardRequest();
    }
    return { action: "curation-note", itemId: raw.itemId, curationNote: raw.curationNote };
  }
  invalidBoardRequest();
}

function createInput(input, catalog) {
  if (!isPlainObject(input) || !Object.keys(input).every((key) => ["name", "brief", "querySnapshot", "items"].includes(key))) {
    throw new BoardError("Board request is invalid.", "invalid_board_request");
  }
  const name = cleanBoardString(input.name, "name", MAX_NAME_LENGTH, { allowEmpty: false });
  const brief = cleanBoardString(input.brief === undefined ? "" : input.brief, "brief", MAX_BRIEF_LENGTH);
  const querySnapshot = validateSnapshot(input.querySnapshot === undefined ? {} : input.querySnapshot, { request: true });
  if (!Array.isArray(input.items) || input.items.length > MAX_BOARD_ITEMS) throw new BoardError("Board request is invalid.", "invalid_board_request");
  const availableIds = catalogIds(catalog);
  const itemIds = new Set();
  const items = input.items.map((item) => {
    const normalized = typeof item === "string" ? requestItem({ itemId: item }) : requestItem(item);
    if (itemIds.has(normalized.itemId) || !availableIds.has(normalized.itemId)) throw new BoardError("Board request is invalid.", "invalid_board_request");
    itemIds.add(normalized.itemId);
    return normalized;
  });
  return { name, brief, querySnapshot, items };
}

function boardId() {
  return `board:v1:${crypto.randomBytes(16).toString("hex")}`;
}

function currentTime(options) {
  return options.now || new Date().toISOString();
}

function findBoard(document, id) {
  if (typeof id !== "string" || !BOARD_ID.test(id)) throw new BoardError("Board not found.", "board_not_found", 404);
  const board = document.boards.find((candidate) => candidate.id === id);
  if (!board) throw new BoardError("Board not found.", "board_not_found", 404);
  return board;
}

function createBoard(input, options = {}) {
  return withBoardLock(options, ({ boardsPath }) => {
    const document = readBoardDocument(boardsPath);
    const prepared = createInput(input, options.catalog || options.loadCatalog?.());
    const now = currentTime(options);
    const board = { id: boardId(), ...prepared, createdAt: now, updatedAt: now };
    document.boards.push(board);
    atomicWriteBoardDocument(boardsPath, document, options.atomicOptions);
    return structuredClone(board);
  });
}

function listBoards(request = {}, options = {}) {
  const document = readBoardDocument(boardPaths(options).boardsPath);
  const rawLimit = request.limit === undefined ? 20 : Number(request.limit);
  const rawOffset = request.offset === undefined ? 0 : Number(request.offset);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100 || !Number.isInteger(rawOffset) || rawOffset < 0) {
    throw new BoardError("Board list request is invalid.", "invalid_board_list");
  }
  const available = catalogIds(options.catalog || options.loadCatalog?.());
  const boards = [...document.boards]
    .sort((left, right) => compareStrings(right.updatedAt, left.updatedAt) || compareStrings(left.id, right.id));
  return {
    ok: true,
    total: boards.length,
    limit: rawLimit,
    offset: rawOffset,
    boards: boards.slice(rawOffset, rawOffset + rawLimit).map((board) => ({
      id: board.id,
      name: board.name,
      brief: board.brief,
      createdAt: board.createdAt,
      updatedAt: board.updatedAt,
      itemCount: board.items.length,
      availableCount: board.items.filter((item) => available.has(item.itemId)).length,
      unavailableCount: board.items.filter((item) => !available.has(item.itemId)).length,
    })),
  };
}

function resolveBoard(board, catalog) {
  const items = new Map((catalog?.items || []).map((item) => [item.id, item]));
  return {
    board: structuredClone(board),
    resolvedItems: board.items.map((entry) => {
      const item = items.get(entry.itemId) || null;
      return {
        itemId: entry.itemId,
        status: item ? "available" : "unavailable",
        item: item ? structuredClone(item) : null,
        curationNote: entry.curationNote,
        matchReasonsAtSave: [...entry.matchReasonsAtSave],
      };
    }),
  };
}

function getBoardDetail(id, options = {}) {
  const document = readBoardDocument(boardPaths(options).boardsPath);
  return { ok: true, ...resolveBoard(findBoard(document, id), options.catalog || options.loadCatalog?.()) };
}

function updateBoard(id, patch, options = {}) {
  return withBoardLock(options, ({ boardsPath }) => {
    const prepared = updateInput(patch);
    const document = readBoardDocument(boardsPath);
    const board = findBoard(document, id);
    if (Object.prototype.hasOwnProperty.call(prepared, "name")) board.name = prepared.name;
    if (Object.prototype.hasOwnProperty.call(prepared, "brief")) board.brief = prepared.brief;
    if (Object.prototype.hasOwnProperty.call(prepared, "querySnapshot")) board.querySnapshot = prepared.querySnapshot;
    board.updatedAt = currentTime(options);
    atomicWriteBoardDocument(boardsPath, document, options.atomicOptions);
    return structuredClone(board);
  });
}

function addBoardItem(id, rawItem, options = {}) {
  return withBoardLock(options, ({ boardsPath }) => {
    const document = readBoardDocument(boardsPath);
    const board = findBoard(document, id);
    const item = requestItem(rawItem);
    const available = catalogIds(options.catalog || options.loadCatalog?.());
    if (!available.has(item.itemId) || board.items.length >= MAX_BOARD_ITEMS || board.items.some((entry) => entry.itemId === item.itemId)) {
      throw new BoardError("Board request is invalid.", "invalid_board_request");
    }
    board.items.push(item);
    board.updatedAt = currentTime(options);
    atomicWriteBoardDocument(boardsPath, document, options.atomicOptions);
    return structuredClone(board);
  });
}

function removeBoardItem(id, itemId, options = {}) {
  return withBoardLock(options, ({ boardsPath }) => {
    const document = readBoardDocument(boardsPath);
    const board = findBoard(document, id);
    const index = board.items.findIndex((item) => item.itemId === itemId);
    if (index === -1) throw new BoardError("Board item not found.", "board_item_not_found", 404);
    board.items.splice(index, 1);
    board.updatedAt = currentTime(options);
    atomicWriteBoardDocument(boardsPath, document, options.atomicOptions);
    return structuredClone(board);
  });
}

function reorderBoardItems(id, itemIds, options = {}) {
  return withBoardLock(options, ({ boardsPath }) => {
    const document = readBoardDocument(boardsPath);
    const board = findBoard(document, id);
    if (!Array.isArray(itemIds) || itemIds.length !== board.items.length || new Set(itemIds).size !== itemIds.length ||
      itemIds.some((itemId) => typeof itemId !== "string") || itemIds.some((itemId) => !board.items.some((item) => item.itemId === itemId))) {
      throw new BoardError("Board request is invalid.", "invalid_board_request");
    }
    const entries = new Map(board.items.map((item) => [item.itemId, item]));
    board.items = itemIds.map((itemId) => entries.get(itemId));
    board.updatedAt = currentTime(options);
    atomicWriteBoardDocument(boardsPath, document, options.atomicOptions);
    return structuredClone(board);
  });
}

function updateCurationNote(id, itemId, curationNote, options = {}) {
  return withBoardLock(options, ({ boardsPath }) => {
    const document = readBoardDocument(boardsPath);
    const board = findBoard(document, id);
    const item = board.items.find((entry) => entry.itemId === itemId);
    if (!item) throw new BoardError("Board item not found.", "board_item_not_found", 404);
    item.curationNote = cleanBoardString(curationNote, "curationNote", MAX_NOTE_LENGTH);
    board.updatedAt = currentTime(options);
    atomicWriteBoardDocument(boardsPath, document, options.atomicOptions);
    return structuredClone(board);
  });
}

function deleteBoard(id, options = {}) {
  return withBoardLock(options, ({ boardsPath }) => {
    const document = readBoardDocument(boardsPath);
    const board = findBoard(document, id);
    document.boards = document.boards.filter((candidate) => candidate.id !== board.id);
    atomicWriteBoardDocument(boardsPath, document, options.atomicOptions);
    return { id: board.id, deleted: true };
  });
}

function markdownLine(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function markdownText(value) {
  return markdownLine(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_{}\[\]()#+\-.!|~])/g, "\\$1");
}

function markdownDestination(value) {
  try {
    const parsed = new URL(markdownLine(value));
    if (!(["http:", "https:"].includes(parsed.protocol)) || !parsed.hostname || parsed.username || parsed.password) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function exportBoard(id, format, options = {}) {
  if (format !== "json" && format !== "markdown") throw new BoardError("Board export format is invalid.", "invalid_board_export");
  const detail = getBoardDetail(id, options);
  if (format === "json") return { format, content: JSON.stringify(detail) };
  const lines = [`# ${markdownText(detail.board.name)}`];
  if (detail.board.brief) lines.push("", markdownText(detail.board.brief));
  detail.resolvedItems.forEach((entry, index) => {
    if (entry.status === "unavailable") {
      lines.push("", `${index + 1}. Unavailable reference (${markdownText(entry.itemId)})`);
      return;
    }
    const note = entry.curationNote || entry.matchReasonsAtSave[0] || "";
    lines.push("", `${index + 1}. ${markdownText(entry.item.title) || "Untitled reference"}`);
    if (note) lines.push(`   ${markdownText(note)}`);
    const destination = markdownDestination(entry.item.sourceUrl);
    if (destination) lines.push(`   [Source](<${destination}>)`);
  });
  const content = lines.join("\n");
  if (content.length > 200 * 1024) throw new BoardError("Board export is too large.", "board_export_too_large", 500);
  return { format, content };
}

module.exports = {
  BOARD_SCHEMA_VERSION,
  BoardError,
  LOCK_STALE_MS,
  addBoardItem,
  acquireBoardLock,
  atomicWriteBoardDocument,
  boardPaths,
  createBoard,
  deleteBoard,
  exportBoard,
  getBoardDetail,
  listBoards,
  readBoardDocument,
  releaseBoardLock,
  removeBoardItem,
  reorderBoardItems,
  resolveBoard,
  updateBoard,
  updateCurationNote,
  validateBoardMutationRequest,
  validateBoardDocument,
};

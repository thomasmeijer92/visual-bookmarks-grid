const fs = require("fs");
const path = require("path");
const { loadCatalog } = require("../lib/catalog/loader");
const {
  BoardError,
  addBoardItem,
  createBoard,
  deleteBoard,
  exportBoard,
  getBoardDetail,
  listBoards,
  removeBoardItem,
  reorderBoardItems,
  updateBoard,
  updateCurationNote,
} = require("../lib/catalog/boards");

const ROOT = path.resolve(__dirname, "..");
const terminalSafe = (value) => String(value).replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f]/g, (character) =>
  `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
);
const catalogOptions = () => ({ rootDir: ROOT, catalog: loadCatalog({ rootDir: ROOT }) });

function parse(args, allowed) {
  const result = { json: false };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--json") result.json = true;
    else if (flag === "--help" || flag === "-h") result.help = true;
    else if (allowed.has(flag)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
      result[flag.slice(2)] = value;
    } else throw new Error(`Unknown argument: ${flag}.`);
  }
  return result;
}

function parseJsonFile(filePath, label) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { throw new Error(`${label} must contain valid JSON.`); }
}

function output(value, json, human) {
  process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${human(value)}\n`);
}

function usage(command) {
  const commands = {
    create: "npm run --silent board:create -- --name \"Board name\" --brief \"Brief\" --items ids.json [--query query.json] [--json]",
    list: "npm run --silent board:list -- [--limit 20] [--offset 0] [--json]",
    show: "npm run --silent board:show -- --id board-id [--json]",
    update: "npm run --silent board:update -- --id board-id [--name \"Name\"] [--brief \"Brief\"] [--query query.json] [--json]",
    delete: "npm run --silent board:delete -- --id board-id [--json]",
    add: "npm run --silent board:add -- --id board-id --item catalog-id [--note \"Note\"] [--json]",
    remove: "npm run --silent board:remove -- --id board-id --item catalog-id [--json]",
    reorder: "npm run --silent board:reorder -- --id board-id --items ids.json [--json]",
    note: "npm run --silent board:note -- --id board-id --item catalog-id --note \"Note\" [--json]",
    export: "npm run --silent board:export -- --id board-id --format markdown [--json]",
  };
  return commands[command];
}

function commandInputItems(filePath) {
  const parsed = parseJsonFile(filePath, "Items file");
  const items = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(items)) throw new Error("Items file must contain an array or an object with items.");
  return items;
}

function run(command) {
  try {
    const args = process.argv.slice(2);
    if (command === "create") {
      const values = parse(args, new Set(["--name", "--brief", "--items", "--query"]));
      if (values.help) return process.stdout.write(`${usage(command)}\n`);
      if (!values.name || !values.items) throw new Error("--name and --items are required.");
      const board = createBoard({
        name: values.name,
        brief: values.brief || "",
        items: commandInputItems(values.items),
        querySnapshot: values.query ? parseJsonFile(values.query, "Query file") : {},
      }, catalogOptions());
      return output({ ok: true, board }, values.json, (value) => `Created board ${value.board.id}.`);
    }
    if (command === "list") {
      const values = parse(args, new Set(["--limit", "--offset"]));
      if (values.help) return process.stdout.write(`${usage(command)}\n`);
      const result = listBoards({ limit: values.limit, offset: values.offset }, catalogOptions());
      return output(result, values.json, (value) => `Boards: ${value.total} (${value.boards.length} shown).`);
    }
    if (command === "show") {
      const values = parse(args, new Set(["--id"]));
      if (values.help) return process.stdout.write(`${usage(command)}\n`);
      if (!values.id) throw new Error("--id is required.");
      const result = getBoardDetail(values.id, catalogOptions());
      return output(result, values.json, (value) => `Board ${value.board.name}: ${value.resolvedItems.length} items.`);
    }
    if (command === "update") {
      const values = parse(args, new Set(["--id", "--name", "--brief", "--query"]));
      if (values.help) return process.stdout.write(`${usage(command)}\n`);
      if (!values.id) throw new Error("--id is required.");
      const patch = {};
      if (values.name !== undefined) patch.name = values.name;
      if (values.brief !== undefined) patch.brief = values.brief;
      if (values.query) patch.querySnapshot = parseJsonFile(values.query, "Query file");
      const board = updateBoard(values.id, patch, catalogOptions());
      return output({ ok: true, board }, values.json, (value) => `Updated board ${value.board.id}.`);
    }
    if (command === "delete") {
      const values = parse(args, new Set(["--id"]));
      if (values.help) return process.stdout.write(`${usage(command)}\n`);
      if (!values.id) throw new Error("--id is required.");
      const result = deleteBoard(values.id, catalogOptions());
      return output({ ok: true, ...result }, values.json, (value) => `Deleted board ${value.id}.`);
    }
    if (command === "add") {
      const values = parse(args, new Set(["--id", "--item", "--note"]));
      if (values.help) return process.stdout.write(`${usage(command)}\n`);
      if (!values.id || !values.item) throw new Error("--id and --item are required.");
      const board = addBoardItem(values.id, { itemId: values.item, curationNote: values.note || "" }, catalogOptions());
      return output({ ok: true, board }, values.json, (value) => `Added item to ${value.board.id}.`);
    }
    if (command === "remove") {
      const values = parse(args, new Set(["--id", "--item"]));
      if (values.help) return process.stdout.write(`${usage(command)}\n`);
      if (!values.id || !values.item) throw new Error("--id and --item are required.");
      const board = removeBoardItem(values.id, values.item, catalogOptions());
      return output({ ok: true, board }, values.json, (value) => `Removed item from ${value.board.id}.`);
    }
    if (command === "reorder") {
      const values = parse(args, new Set(["--id", "--items"]));
      if (values.help) return process.stdout.write(`${usage(command)}\n`);
      if (!values.id || !values.items) throw new Error("--id and --items are required.");
      const board = reorderBoardItems(values.id, commandInputItems(values.items), catalogOptions());
      return output({ ok: true, board }, values.json, (value) => `Reordered board ${value.board.id}.`);
    }
    if (command === "note") {
      const values = parse(args, new Set(["--id", "--item", "--note"]));
      if (values.help) return process.stdout.write(`${usage(command)}\n`);
      if (!values.id || !values.item || values.note === undefined) throw new Error("--id, --item, and --note are required.");
      const board = updateCurationNote(values.id, values.item, values.note, catalogOptions());
      return output({ ok: true, board }, values.json, (value) => `Updated curation note on ${value.board.id}.`);
    }
    if (command === "export") {
      const values = parse(args, new Set(["--id", "--format"]));
      if (values.help) return process.stdout.write(`${usage(command)}\n`);
      if (!values.id || !values.format) throw new Error("--id and --format are required.");
      const result = exportBoard(values.id, values.format, catalogOptions());
      return output(result, values.json, (value) => value.content);
    }
    throw new Error("Unknown board command.");
  } catch (error) {
    const message = error instanceof BoardError || error instanceof Error ? error.message : "Board command failed.";
    process.stderr.write(`Board command failed: ${terminalSafe(message)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { run };

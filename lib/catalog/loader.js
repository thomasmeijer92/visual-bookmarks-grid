const fs = require("fs");
const path = require("path");
const { CatalogValidationError, loadBootstrapCatalog } = require("./bootstrap");
const { IndexValidationError, validateIndex } = require("./index-schema");

function indexUnavailable(message, code) {
  return new CatalogValidationError(message, code);
}

function readIndex(indexPath, readFileSync) {
  let contents;
  try {
    contents = readFileSync(indexPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw indexUnavailable("Generated inspiration index could not be read.", "catalog_index_read_failed");
  }

  let index;
  try {
    index = JSON.parse(contents);
  } catch {
    throw indexUnavailable("Generated inspiration index is invalid.", "catalog_index_invalid_json");
  }
  try {
    const validation = validateIndex(index);
    index.diagnostics = {
      mode: "index",
      validation,
      sources: {
        bookmarks: "index",
        metadataCards: "index",
        webClips: "index",
        manualNotes: "index",
      },
      skipped: [],
    };
    return index;
  } catch (error) {
    if (error instanceof IndexValidationError) {
      throw indexUnavailable("Generated inspiration index is invalid.", "catalog_index_invalid");
    }
    throw error;
  }
}

function loadCatalog(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, "..", ".."));
  const indexPath = path.resolve(
    options.indexPath || process.env.INSPIRATION_INDEX_PATH || path.join(rootDir, "inspiration-index.json")
  );
  const readFileSync = options.readFileSync || fs.readFileSync;
  const index = readIndex(indexPath, readFileSync);
  if (index) return index;
  const catalog = loadBootstrapCatalog({ ...options, rootDir, readFileSync });
  catalog.diagnostics.mode = "bootstrap";
  return catalog;
}

module.exports = {
  loadCatalog,
  readIndex,
};

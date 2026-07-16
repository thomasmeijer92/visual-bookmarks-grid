const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const boardHistory = fs.readFileSync(path.join(ROOT, "board-history.js"), "utf8");
const boardRepair = fs.readFileSync(path.join(ROOT, "board-repair.js"), "utf8");

test("board dialog markup exposes modal, busy, validation, and curation status relationships", () => {
  assert.match(html, /<script src="board-history\.js"><\/script>/);
  assert.match(html, /<script src="board-repair\.js"><\/script>/);
  assert.match(html, /id="board-modal"[^>]*hidden[^>]*inert[^>]*aria-hidden="true"/);
  assert.match(html, /id="board-form"[^>]*aria-modal="true"[^>]*aria-describedby="board-dialog-status"[^>]*aria-busy="false"[^>]*novalidate/);
  assert.match(html, /id="board-name-input"[^>]*aria-describedby="board-dialog-status"[^>]*aria-invalid="false"/);
  assert.match(html, /id="board-brief-input"[^>]*aria-describedby="board-dialog-status"[^>]*aria-invalid="false"/);
  assert.match(html, /id="board-curation-form"[^>]*aria-busy="false"/);
  assert.match(html, /id="board-curation-input"[^>]*aria-describedby="board-curation-status"/);
  assert.match(html, /id="board-unavailable-repairs"[^>]*aria-labelledby="board-unavailable-repairs-title"[^>]*hidden/);
  assert.match(html, /id="board-unavailable-repairs-list"[^>]*aria-label="Unavailable references in board order"/);
});

test("board dialog behavior preserves background state, traps focus, and saves bounded context reasons", () => {
  assert.match(app, /document\.body\.children/);
  assert.match(app, /hadInert: element\.hasAttribute\("inert"\)/);
  assert.match(app, /hadAriaHidden: element\.hasAttribute\("aria-hidden"\)/);
  assert.match(app, /restoreBoardModalBackground\(\)/);
  assert.match(app, /trapFocusWithin\(event, boardForm\)/);
  assert.match(app, /boardState\.previousFocus\?\.focus/);
  assert.match(app, /matchReasonsAtSave: candidates\.get\(itemId\)\?\.matchReasonsAtSave \|\| \[\]/);
  assert.match(app, /slice\(0, 12\)/);
  assert.match(app, /slice\(0, 240\)/);
  assert.match(app, /window\.addEventListener\("popstate"/);
  assert.match(app, /BoardHistory\.reconcileBoardHistory/);
  assert.match(app, /navigationGeneration/);
  assert.match(app, /window\.location\.search === search/);
  assert.match(app, /BoardRepair\.renderUnavailableRepairs/);
  assert.match(app, /mutateBoardItem\(itemId, action/);
  assert.match(app, /restoreBoardRepairFocus/);
  assert.match(boardHistory, /updateHistory: false/);
  assert.match(boardRepair, /button\.type = "button"/);
  assert.match(boardRepair, /Reference \$\{index \+ 1\} of \$\{total\}, unavailable/);
});

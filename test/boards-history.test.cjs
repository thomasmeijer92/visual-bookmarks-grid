const assert = require("node:assert/strict");
const test = require("node:test");

const { boardIdFromSearch, reconcileBoardHistory } = require("../board-history");

test("board history reconciliation follows Back and Forward locations without writing history", async () => {
  assert.equal(boardIdFromSearch("?query=dark&board=board%3Av1%3Aabc"), "board:v1:abc");
  assert.equal(boardIdFromSearch("?query=dark"), "");

  const calls = [];
  assert.equal(await reconcileBoardHistory({
    search: "?board=board%3Av1%3Aabc",
    activeBoardId: "",
    openBoard: async (id, { updateHistory }) => calls.push({ type: "open", id, updateHistory }),
    closeBoard: async (options) => calls.push({ type: "close", options }),
  }), "opened");
  assert.deepEqual(calls, [{ type: "open", id: "board:v1:abc", updateHistory: false }]);

  assert.equal(await reconcileBoardHistory({
    search: "?query=dark",
    activeBoardId: "board:v1:abc",
    openBoard: async () => assert.fail("a closed location must not load a board"),
    closeBoard: async (options) => calls.push({ type: "close", options }),
  }), "closed");
  assert.deepEqual(calls.at(-1), { type: "close", options: { updateHistory: false, restoreFocus: false } });

  assert.equal(await reconcileBoardHistory({
    search: "?board=board%3Av1%3Aabc",
    activeBoardId: "board:v1:abc",
    openBoard: async () => assert.fail("the active board must not reload"),
    closeBoard: async () => assert.fail("the active board must not close"),
  }), "unchanged");

  assert.equal(await reconcileBoardHistory({
    search: "?board=board%3Av1%3Amissing",
    activeBoardId: "board:v1:abc",
    openBoard: async () => false,
    closeBoard: async (options) => calls.push({ type: "close-after-failed-open", options }),
  }), "closed");
  assert.deepEqual(calls.at(-1), {
    type: "close-after-failed-open",
    options: { updateHistory: false, restoreFocus: false },
  });
});

test("overlapping Forward then Back reconciliation cannot apply the stale board load", async () => {
  let locationSearch = "?board=board%3Av1%3Aalpha";
  let releaseLoad;
  const loadComplete = new Promise((resolve) => { releaseLoad = resolve; });
  const applied = [];
  const closed = [];
  let generation = 0;
  const current = (search, requestGeneration) => () => generation === requestGeneration && locationSearch === search;

  const forwardGeneration = ++generation;
  const forward = reconcileBoardHistory({
    search: locationSearch,
    activeBoardId: "",
    openBoard: async (id, { isCurrent }) => {
      await loadComplete;
      if (!isCurrent()) return undefined;
      applied.push(id);
      return true;
    },
    closeBoard: async (options) => closed.push(options),
    isCurrent: current(locationSearch, forwardGeneration),
  });

  await Promise.resolve();
  locationSearch = "";
  const backGeneration = ++generation;
  const back = reconcileBoardHistory({
    search: locationSearch,
    activeBoardId: "",
    openBoard: async () => assert.fail("Back must not open a board"),
    closeBoard: async (options) => closed.push(options),
    isCurrent: current(locationSearch, backGeneration),
  });

  releaseLoad();
  assert.equal(await back, "unchanged");
  assert.equal(await forward, "stale");
  assert.deepEqual(applied, []);
  assert.deepEqual(closed, []);
});

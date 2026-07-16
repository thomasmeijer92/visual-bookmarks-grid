(function registerBoardHistory(root, factory) {
  const history = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = history;
  if (root) root.BoardHistory = history;
}(typeof globalThis === "undefined" ? undefined : globalThis, function createBoardHistory() {
  "use strict";

  function boardIdFromSearch(search) {
    return new URLSearchParams(search || "").get("board") || "";
  }

  async function reconcileBoardHistory({ search, activeBoardId, openBoard, closeBoard, isCurrent = () => true }) {
    if (!isCurrent()) return "stale";
    const boardId = boardIdFromSearch(search);
    if (boardId === activeBoardId) return "unchanged";
    if (boardId) {
      const opened = await openBoard(boardId, { updateHistory: false, isCurrent });
      if (!isCurrent()) return "stale";
      if (opened === false) {
        await closeBoard({ updateHistory: false, restoreFocus: false });
        return "closed";
      }
      return "opened";
    }
    await closeBoard({ updateHistory: false, restoreFocus: false });
    return "closed";
  }

  return { boardIdFromSearch, reconcileBoardHistory };
}));

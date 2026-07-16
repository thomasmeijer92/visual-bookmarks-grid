(function registerBoardRepair(root, factory) {
  const repair = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = repair;
  if (root) root.BoardRepair = repair;
}(typeof globalThis === "undefined" ? undefined : globalThis, function createBoardRepair() {
  "use strict";

  function unavailableEntries(resolvedItems) {
    return (Array.isArray(resolvedItems) ? resolvedItems : [])
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry?.status === "unavailable" && typeof entry.itemId === "string" && entry.itemId);
  }

  function itemIdsAfterAction(resolvedItems, itemId, action) {
    const itemIds = (Array.isArray(resolvedItems) ? resolvedItems : []).map((entry) => entry?.itemId);
    const index = itemIds.indexOf(itemId);
    if (index < 0) return null;
    if (action === "remove") return itemIds.filter((candidate) => candidate !== itemId);
    const nextIndex = action === "earlier" ? index - 1 : action === "later" ? index + 1 : -1;
    if (nextIndex < 0 || nextIndex >= itemIds.length) return null;
    [itemIds[index], itemIds[nextIndex]] = [itemIds[nextIndex], itemIds[index]];
    return itemIds;
  }

  function actionButton(document, label, action, itemId, disabled, onAction) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "board-repair-action";
    button.textContent = label;
    button.disabled = Boolean(disabled);
    button.setAttribute("aria-label", `${label} unavailable reference`);
    button.dataset.boardRepairAction = action;
    button.dataset.boardRepairItemId = itemId;
    button.addEventListener("click", () => onAction(itemId, action, button));
    return button;
  }

  function renderUnavailableRepairs({ document, section, list, summary, resolvedItems, busy = false, onAction }) {
    if (!section || !list || !summary) return;
    list.replaceChildren();
    const entries = unavailableEntries(resolvedItems);
    section.hidden = entries.length === 0;
    if (entries.length === 0) return;

    const total = resolvedItems.length;
    summary.textContent = `${entries.length} unavailable ${entries.length === 1 ? "reference" : "references"}.`;
    list.setAttribute("aria-busy", String(Boolean(busy)));
    for (const { entry, index } of entries) {
      const item = document.createElement("li");
      item.className = "board-repair-item";
      item.setAttribute("aria-label", `Reference ${index + 1} of ${total}, unavailable`);

      const copy = document.createElement("p");
      copy.className = "board-repair-copy";
      copy.textContent = `Reference ${index + 1} of ${total} is unavailable.`;
      item.appendChild(copy);

      const actions = document.createElement("div");
      actions.className = "board-repair-actions";
      actions.append(
        actionButton(document, "Move earlier", "earlier", entry.itemId, busy || index === 0, onAction),
        actionButton(document, "Move later", "later", entry.itemId, busy || index === total - 1, onAction),
        actionButton(document, "Remove", "remove", entry.itemId, busy, onAction)
      );
      item.appendChild(actions);
      list.appendChild(item);
    }
  }

  return { unavailableEntries, itemIdsAfterAction, renderUnavailableRepairs };
}));

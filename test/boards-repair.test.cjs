const assert = require("node:assert/strict");
const test = require("node:test");

const { itemIdsAfterAction, renderUnavailableRepairs, unavailableEntries } = require("../board-repair");

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.type = "";
  }

  append(...children) { children.forEach((child) => this.appendChild(child)); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) || null; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  click() { this.listeners.get("click")?.({ currentTarget: this }); }
}

const fakeDocument = { createElement: (tagName) => new FakeElement(tagName) };

function descendants(element) {
  return element.children.flatMap((child) => [child, ...descendants(child)]);
}

test("unavailable board repair list preserves board order and exposes native repair buttons", () => {
  const section = new FakeElement("section");
  const list = new FakeElement("ol");
  const summary = new FakeElement("p");
  const entries = [
    { itemId: "available-before", status: "available" },
    { itemId: "unavailable-middle", status: "unavailable" },
    { itemId: "available-after", status: "available" },
  ];
  const calls = [];
  renderUnavailableRepairs({
    document: fakeDocument,
    section,
    list,
    summary,
    resolvedItems: entries,
    onAction: (itemId, action, button) => calls.push({ itemId, action, button }),
  });

  assert.equal(section.hidden, false);
  assert.equal(summary.textContent, "1 unavailable reference.");
  assert.equal(list.getAttribute("aria-busy"), "false");
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].getAttribute("aria-label"), "Reference 2 of 3, unavailable");
  const buttons = descendants(list).filter((element) => element.tagName === "BUTTON");
  assert.deepEqual(buttons.map((button) => [button.textContent, button.type, button.disabled]), [
    ["Move earlier", "button", false],
    ["Move later", "button", false],
    ["Remove", "button", false],
  ]);
  assert.ok(buttons.every((button) => button.getAttribute("aria-label")?.includes("unavailable reference")));

  // Native buttons receive keyboard activation as a click, so this exercises the same handlers.
  buttons[0].click();
  buttons[2].click();
  assert.deepEqual(calls.map(({ itemId, action }) => ({ itemId, action })), [
    { itemId: "unavailable-middle", action: "earlier" },
    { itemId: "unavailable-middle", action: "remove" },
  ]);
  assert.deepEqual(itemIdsAfterAction(entries, "unavailable-middle", "earlier"), ["unavailable-middle", "available-before", "available-after"]);
  assert.deepEqual(itemIdsAfterAction(entries, "unavailable-middle", "remove"), ["available-before", "available-after"]);
  assert.deepEqual(unavailableEntries(entries).map(({ index }) => index), [1]);
});

test("unavailable repair buttons honor board edges and hide when no repair is needed", () => {
  const section = new FakeElement("section");
  const list = new FakeElement("ol");
  const summary = new FakeElement("p");
  renderUnavailableRepairs({
    document: fakeDocument,
    section,
    list,
    summary,
    resolvedItems: [{ itemId: "first", status: "unavailable" }, { itemId: "last", status: "unavailable" }],
    onAction: () => assert.fail("disabled controls must not be activated by this regression"),
  });
  const buttons = descendants(list).filter((element) => element.tagName === "BUTTON");
  assert.equal(buttons[0].disabled, true);
  assert.equal(buttons[4].disabled, true);
  assert.equal(itemIdsAfterAction([{ itemId: "only", status: "unavailable" }], "only", "earlier"), null);
  assert.equal(itemIdsAfterAction([{ itemId: "only", status: "unavailable" }], "only", "later"), null);

  renderUnavailableRepairs({ document: fakeDocument, section, list, summary, resolvedItems: [], onAction: () => {} });
  assert.equal(section.hidden, true);
  assert.equal(list.children.length, 0);
});

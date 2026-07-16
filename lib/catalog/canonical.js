const crypto = require("crypto");
const {
  canonicalizeAbsoluteUrl,
  canonicalizeLocalAssetUrl,
  canonicalizeMediaUrl,
} = require("../../url-contract");

const UNSAFE_HUMAN_CONTROL = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/;

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasUnsafeTerminalControl(value) {
  return typeof value === "string" && UNSAFE_HUMAN_CONTROL.test(value);
}

function cleanString(value, { field = "value", max = 10000, allowEmpty = true } = {}) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new TypeError(`${field} must be a string.`);
  if (hasUnsafeTerminalControl(value)) throw new TypeError(`${field} contains unsafe control characters.`);
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!allowEmpty && !normalized) throw new TypeError(`${field} must not be empty.`);
  if (normalized.length > max) throw new TypeError(`${field} is too long.`);
  return normalized;
}

function boundedRawString(value, { field = "value", max = 10000, allowEmpty = true } = {}) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new TypeError(`${field} must be a string.`);
  if (!allowEmpty && !value) throw new TypeError(`${field} must not be empty.`);
  if (value.length > max) throw new TypeError(`${field} is too long.`);
  return value;
}

function comparisonKey(value) {
  return cleanString(value).toLowerCase();
}

function normalizeList(value, { field = "value", maxItems = 500, maxLength = 1000 } = {}) {
  if (value === null || value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.length > maxItems) throw new TypeError(`${field} has too many values.`);

  const byKey = new Map();
  for (const member of values) {
    if (typeof member !== "string") throw new TypeError(`${field} values must be strings.`);
    const display = cleanString(member, { field, max: maxLength });
    if (!display) continue;
    const key = display.toLowerCase();
    const previous = byKey.get(key);
    if (!previous || compareStrings(display, previous) < 0) byKey.set(key, display);
  }

  return [...byKey.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      compareStrings(leftKey, rightKey) || compareStrings(leftValue, rightValue)
    )
    .map(([, display]) => display);
}

function canonicalJson(value) {
  const seen = new Set();

  function serialize(current) {
    if (current === null) return "null";
    if (typeof current === "string") return JSON.stringify(current);
    if (typeof current === "boolean") return current ? "true" : "false";
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError("Canonical JSON only accepts finite numbers.");
      return Object.is(current, -0) ? "0" : JSON.stringify(current);
    }
    if (typeof current !== "object") throw new TypeError("Value is outside the JSON domain.");
    if (seen.has(current)) throw new TypeError("Canonical JSON does not accept cycles.");
    seen.add(current);

    let output;
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(current, index)) {
          throw new TypeError("Canonical JSON does not accept sparse arrays.");
        }
      }
      output = `[${current.map(serialize).join(",")}]`;
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("Canonical JSON only accepts plain objects.");
      }
      const keys = Object.keys(current).sort(compareStrings);
      output = `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(current[key])}`).join(",")}}`;
    }

    seen.delete(current);
    return output;
  }

  return serialize(value);
}

function sha256Canonical(value) {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

module.exports = {
  canonicalJson,
  canonicalizeAbsoluteUrl,
  canonicalizeLocalAssetUrl,
  canonicalizeMediaUrl,
  boundedRawString,
  cleanString,
  compareStrings,
  comparisonKey,
  hasUnsafeTerminalControl,
  normalizeList,
  sha256Canonical,
};

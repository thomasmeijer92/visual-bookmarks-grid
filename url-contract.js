(function registerCatalogUrlContract(root, factory) {
  const contract = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = contract;
  if (root) root.CatalogUrlContract = contract;
}(typeof globalThis === "undefined" ? undefined : globalThis, function createCatalogUrlContract() {
  "use strict";

  const ASCII_TRIM = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g;
  const CONTROL_OR_DEL = /[\u0000-\u001f\u007f]/;
  const MALFORMED_PERCENT = /%(?![0-9a-fA-F]{2})/;

  const trimAscii = (value) => typeof value === "string" ? value.replace(ASCII_TRIM, "") : "";

  function canonicalizeAbsoluteUrl(value) {
    if (typeof value !== "string") return { ok: false, error: "invalid_type" };
    const display = trimAscii(value);
    if (!display || CONTROL_OR_DEL.test(display)) return { ok: false, error: "invalid_url" };
    try {
      const parsed = new URL(display);
      if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        !parsed.hostname || parsed.username || parsed.password
      ) return { ok: false, error: "invalid_url" };
      parsed.hash = "";
      return { ok: true, display, key: `web:${parsed.href}` };
    } catch {
      return { ok: false, error: "invalid_url" };
    }
  }

  function validateDecodedSegment(segment, isFirstMeaningful) {
    if (MALFORMED_PERCENT.test(segment)) return "malformed_percent_escape";
    if (segment === "..") return "path_traversal";
    if (segment.includes("/") || segment.includes("\\")) return "encoded_separator";
    if (CONTROL_OR_DEL.test(segment)) return "invalid_character";
    if (isFirstMeaningful && segment !== "." && segment.includes(":")) return "invalid_scheme";
    return "";
  }

  function decodeLocalSegment(rawSegment, isFirstMeaningful) {
    let segment = rawSegment;
    for (let pass = 0; pass < 4; pass++) {
      const invalid = validateDecodedSegment(segment, isFirstMeaningful);
      if (invalid) return { ok: false, error: invalid };
      let decoded;
      try { decoded = decodeURIComponent(segment); } catch { return { ok: false, error: "malformed_percent_escape" }; }
      if (decoded === segment) return { ok: true, value: segment };
      segment = decoded;
    }
    const invalid = validateDecodedSegment(segment, isFirstMeaningful);
    if (invalid) return { ok: false, error: invalid };
    try {
      if (decodeURIComponent(segment) !== segment) return { ok: false, error: "decode_depth_exceeded" };
    } catch {
      return { ok: false, error: "malformed_percent_escape" };
    }
    return { ok: true, value: segment };
  }

  function canonicalizeLocalAssetUrl(value) {
    if (typeof value !== "string") return { ok: false, error: "invalid_type" };
    const display = trimAscii(value);
    if (!display || display.startsWith("//") || display.includes("\\") || CONTROL_OR_DEL.test(display)) {
      return { ok: false, error: "invalid_local_url" };
    }
    const pathEnd = display.search(/[?#]/);
    const rawPath = pathEnd === -1 ? display : display.slice(0, pathEnd);
    const rawSegments = rawPath.split("/");
    const decodedSegments = [];
    let foundMeaningful = false;
    for (const rawSegment of rawSegments) {
      const isFirstMeaningful = !foundMeaningful && rawSegment !== "" && rawSegment !== ".";
      const decoded = decodeLocalSegment(rawSegment, isFirstMeaningful);
      if (!decoded.ok) return decoded;
      decodedSegments.push(decoded.value);
      if (decoded.value !== "" && decoded.value !== ".") foundMeaningful = true;
    }
    try {
      const original = new URL(display, "https://local.invalid/");
      if (original.origin !== "https://local.invalid") return { ok: false, error: "invalid_local_url" };
      const rebuilt = new URL("https://local.invalid/");
      rebuilt.pathname = decodedSegments.join("/");
      if (!rebuilt.pathname.startsWith("/assets/") || rebuilt.pathname === "/assets/") {
        return { ok: false, error: "invalid_asset_root" };
      }
      return { ok: true, display, key: `local:${rebuilt.pathname.slice(1)}${original.search}` };
    } catch {
      return { ok: false, error: "invalid_local_url" };
    }
  }

  function canonicalizeMediaUrl(value) {
    const absolute = canonicalizeAbsoluteUrl(value);
    return absolute.ok ? absolute : canonicalizeLocalAssetUrl(value);
  }

  return { trimAscii, canonicalizeAbsoluteUrl, canonicalizeLocalAssetUrl, canonicalizeMediaUrl };
}));

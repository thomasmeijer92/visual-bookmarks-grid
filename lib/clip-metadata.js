const path = require("path");

function cleanString(value, maxLength = 4000) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()
    .slice(0, maxLength);
}

function normalizeClipUrl(rawUrl) {
  let value = cleanString(rawUrl, 2000);
  if (!value) throw new Error("Missing URL.");
  const hasExplicitScheme = /^[a-z][a-z\d+.-]*:/i.test(value);
  const isHostWithPort = /^(?:localhost|127\.0\.0\.1|\[[0-9a-f:]+\]|(?:[a-z0-9-]+\.)+[a-z0-9-]+):\d+(?:[/?#]|$)/i.test(value);
  if (!hasExplicitScheme || isHostWithPort) {
    const localProtocol = /^(?:localhost|127\.0\.0\.1|\[[0-9a-f:]+\])(?::|\/|$)/i.test(value) ? "http" : "https";
    value = `${localProtocol}://${value}`;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs can be clipped.");
  }

  url.hash = "";
  return url.toString();
}

function normalizeOptionalHttpUrl(rawUrl, baseUrl) {
  const value = cleanString(rawUrl, 2000);
  if (!value) return "";

  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function decodeNumericEntity(match, value, radix) {
  const codePoint = Number.parseInt(value, radix);
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
  return String.fromCodePoint(codePoint);
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (match, code) => decodeNumericEntity(match, code, 10))
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => decodeNumericEntity(match, code, 16))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(value) {
  return decodeHtml(String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function parseAttributes(tag) {
  const attrs = {};
  const attrPattern = /([^\s"'=<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = attrPattern.exec(tag))) {
    const name = match[1].toLowerCase();
    if (!name || name === "meta" || name === "link" || name === "img" || name === "script") continue;
    attrs[name] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function absoluteHttpUrl(value, baseUrl) {
  const clean = cleanString(decodeHtml(value), 2000);
  if (!clean) return "";
  try {
    const url = new URL(clean, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function firstString(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const result = firstString(entry);
      if (result) return result;
    }
    return "";
  }
  if (typeof value === "object") {
    return firstString(value.name || value.url || value.contentUrl || value["@id"]);
  }
  return "";
}

function imageUrlFromJsonValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const result = imageUrlFromJsonValue(entry);
      if (result) return result;
    }
    return "";
  }
  if (typeof value === "object") {
    return firstString(value.url || value.contentUrl || value.image || value.logo);
  }
  return "";
}

function collectJsonLdHints(html) {
  const hints = {};
  const scriptPattern = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptPattern.exec(html))) {
    let parsed;
    try {
      parsed = JSON.parse(decodeHtml(match[1]).trim());
    } catch {
      continue;
    }

    const visit = (value, depth = 0) => {
      if (!value || depth > 7) return;
      if (Array.isArray(value)) {
        for (const entry of value) visit(entry, depth + 1);
        return;
      }
      if (typeof value !== "object") return;

      if (!hints.authorName && value.author) hints.authorName = firstString(value.author);
      if (!hints.avatarUrl && value.author) hints.avatarUrl = imageUrlFromJsonValue(value.author.image || value.author.logo);
      if (!hints.publisherLogo && value.publisher) hints.publisherLogo = imageUrlFromJsonValue(value.publisher.logo || value.publisher.image);
      if (!hints.imageUrl && value.image) hints.imageUrl = imageUrlFromJsonValue(value.image);

      for (const entry of Object.values(value)) visit(entry, depth + 1);
    };

    visit(parsed);
  }
  return hints;
}

function extractPageMetadata(html, finalUrl) {
  const meta = {};
  const links = [];
  const images = [];
  let match;

  const metaPattern = /<meta\b[^>]*>/gi;
  while ((match = metaPattern.exec(html))) {
    const attrs = parseAttributes(match[0]);
    const key = (attrs.property || attrs.name || attrs.itemprop || "").toLowerCase();
    if (!key || !attrs.content || meta[key]) continue;
    meta[key] = cleanString(attrs.content, 4000);
  }

  const linkPattern = /<link\b[^>]*>/gi;
  while ((match = linkPattern.exec(html))) {
    const attrs = parseAttributes(match[0]);
    if (!attrs.href) continue;
    links.push({
      rel: cleanString(attrs.rel).toLowerCase(),
      href: absoluteHttpUrl(attrs.href, finalUrl),
    });
  }

  const imagePattern = /<img\b[^>]*>/gi;
  while ((match = imagePattern.exec(html))) {
    const attrs = parseAttributes(match[0]);
    const src = attrs.src || attrs["data-src"] || attrs["data-lazy-src"];
    const url = absoluteHttpUrl(src, finalUrl);
    if (url) images.push(url);
  }

  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const jsonLd = collectJsonLdHints(html);
  const canonical = links.find((link) => /\bcanonical\b/.test(link.rel))?.href || finalUrl;
  const url = new URL(canonical);
  const host = url.hostname.replace(/^www\./, "");
  const favicon = (
    links.find((link) => /\bapple-touch-icon\b/.test(link.rel)) ||
    links.find((link) => /\bicon\b/.test(link.rel))
  )?.href || `${url.origin}/favicon.ico`;
  const title = meta["og:title"] || meta["twitter:title"] || stripTags(titleMatch?.[1]) || host;
  const siteName = meta["og:site_name"] || meta["application-name"] || host;
  const author = meta.author || meta["article:author"] || meta["twitter:creator"] || jsonLd.authorName || siteName;
  const avatarSource = absoluteHttpUrl(jsonLd.avatarUrl || jsonLd.publisherLogo || "", finalUrl) || favicon;

  return {
    canonicalUrl: canonical,
    host,
    siteName,
    title: cleanString(title, 240),
    description: cleanString(meta["og:description"] || meta["twitter:description"] || meta.description, 600),
    author: cleanString(author.replace(/^@/, ""), 180),
    imageSourceUrl: absoluteHttpUrl(meta["og:image"] || meta["twitter:image"] || jsonLd.imageUrl || images[0] || "", finalUrl),
    avatarSourceUrl: avatarSource,
    avatarKind: avatarSource === favicon ? "favicon" : "avatar",
    faviconUrl: favicon,
  };
}

function extensionForAsset(contentType, sourceUrl, fallback = ".jpg") {
  const cleanType = contentType.split(";")[0].trim().toLowerCase();
  const fromType = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "image/svg+xml": ".svg",
    "image/x-icon": ".ico",
    "image/vnd.microsoft.icon": ".ico",
  }[cleanType];
  if (fromType) return fromType;

  try {
    const ext = path.extname(new URL(sourceUrl).pathname).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".svg", ".ico"].includes(ext)) {
      return ext === ".jpeg" ? ".jpg" : ext;
    }
  } catch {
    // Fall through to fallback.
  }

  return fallback;
}

function dimensionsFromImage(buffer, contentType) {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (buffer.length >= 24 && (type === "image/png" || buffer.toString("ascii", 1, 4) === "PNG")) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && (type === "image/gif" || buffer.toString("ascii", 0, 3) === "GIF")) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length >= 12 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length - 9) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  if (buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      };
    }
  }
  return { width: 1200, height: 900 };
}

function sourcePlatformForHost(host, siteName) {
  const cleanHost = String(host || "").toLowerCase();
  if (cleanHost.includes("dribbble.com")) return "Dribbble";
  if (cleanHost.includes("pinterest.")) return "Pinterest";
  if (cleanHost.includes("behance.net")) return "Behance";
  if (cleanHost.includes("arena.com") || cleanHost.includes("are.na")) return "Are.na";
  if (cleanHost.includes("mobbin.com")) return "Mobbin";
  return siteName || "Web";
}

function cleanClipTags(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(values.map((tag) => cleanString(tag, 40)).filter(Boolean))].slice(0, 12);
}

module.exports = {
  cleanClipTags,
  cleanString,
  dimensionsFromImage,
  extensionForAsset,
  extractPageMetadata,
  normalizeClipUrl,
  normalizeOptionalHttpUrl,
  sourcePlatformForHost,
};

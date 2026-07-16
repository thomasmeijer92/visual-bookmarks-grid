const test = require("node:test");
const assert = require("node:assert/strict");

const {
  cleanClipTags,
  dimensionsFromImage,
  extensionForAsset,
  extractPageMetadata,
  normalizeClipUrl,
  normalizeOptionalHttpUrl,
  sourcePlatformForHost,
} = require("../lib/clip-metadata");

test("clip URLs accept web addresses and reject other schemes", () => {
  assert.equal(normalizeClipUrl("example.com/work#detail"), "https://example.com/work");
  assert.equal(normalizeClipUrl("example.com:4444/work"), "https://example.com:4444/work");
  assert.equal(normalizeClipUrl("localhost:3000/work"), "http://localhost:3000/work");
  assert.equal(normalizeClipUrl("http://example.com/work#detail"), "http://example.com/work");
  assert.throws(() => normalizeClipUrl("ftp://example.com/file"), /Only http and https/);
  assert.throws(() => normalizeClipUrl("javascript:alert(1)"), /Only http and https/);
  assert.throws(() => normalizeClipUrl(""), /Missing URL/);

  assert.equal(
    normalizeOptionalHttpUrl("/image.png#preview", "https://example.com/page"),
    "https://example.com/image.png"
  );
  assert.equal(normalizeOptionalHttpUrl("data:image/png;base64,test", "https://example.com"), "");
});

test("page metadata uses explicit social metadata and useful JSON-LD fallbacks", () => {
  const html = `<!doctype html>
    <html>
      <head>
        <title>Fallback &#x1F680;</title>
        <meta property="og:title" content="Launch &amp; Learn">
        <meta property="og:description" content="A focused description">
        <meta property="og:site_name" content="Example Studio">
        <link rel="canonical" href="/case-study#section">
        <link rel="icon" href="/icon.png">
        <script type="application/ld+json">
          {
            "author": {
              "name": "Ada Example",
              "url": "https://example.com/ada",
              "image": { "url": "/ada.png" }
            },
            "image": { "url": "/cover.png" }
          }
        </script>
      </head>
      <body><img src="/fallback.png"></body>
    </html>`;

  assert.deepEqual(extractPageMetadata(html, "https://www.example.com/source"), {
    canonicalUrl: "https://www.example.com/case-study",
    host: "example.com",
    siteName: "Example Studio",
    title: "Launch & Learn",
    description: "A focused description",
    author: "Ada Example",
    imageSourceUrl: "https://www.example.com/cover.png",
    avatarSourceUrl: "https://www.example.com/ada.png",
    avatarKind: "avatar",
    faviconUrl: "https://www.example.com/icon.png",
  });
});

test("asset helpers normalize extensions and read common image dimensions", () => {
  assert.equal(extensionForAsset("image/vnd.microsoft.icon", "https://example.com/icon"), ".ico");
  assert.equal(extensionForAsset("application/octet-stream", "https://example.com/image.jpeg"), ".jpg");
  assert.equal(extensionForAsset("application/octet-stream", "not a URL", ".png"), ".png");

  const png = Buffer.alloc(24);
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  assert.deepEqual(dimensionsFromImage(png, "image/png"), { width: 640, height: 480 });

  const gif = Buffer.alloc(10);
  gif.write("GIF", 0, "ascii");
  gif.writeUInt16LE(320, 6);
  gif.writeUInt16LE(180, 8);
  assert.deepEqual(dimensionsFromImage(gif, "image/gif"), { width: 320, height: 180 });
});

test("clip tags stay ordered, unique, trimmed, and bounded", () => {
  const values = ["  Branding ", "Motion", "Branding", ...Array.from({ length: 20 }, (_, index) => `tag-${index}`)];
  const tags = cleanClipTags(values);
  assert.deepEqual(tags.slice(0, 2), ["Branding", "Motion"]);
  assert.equal(tags.length, 12);
  assert.equal(new Set(tags).size, tags.length);
});

test("source platforms use recognizable names without coupling to a source service", () => {
  assert.equal(sourcePlatformForHost("dribbble.com", "Dribbble Inc."), "Dribbble");
  assert.equal(sourcePlatformForHost("www.are.na", "Are.na"), "Are.na");
  assert.equal(sourcePlatformForHost("example.com", "Example Studio"), "Example Studio");
});

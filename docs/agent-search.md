# Agent Search

Agent search is a read-only, deterministic interface over the same local inspiration catalog used by the grid. Runtime search uses Node built-ins only and makes no network requests.

## Catalog Precedence

Search first checks the ignored root `inspiration-index.json`. A present valid index is consumed directly, including its persisted resolver aliases. A present invalid index fails clearly and does not silently return bootstrap or sample records. If the index is absent, search derives the in-memory bootstrap catalog below without writing files.

Every command or API request derives an in-memory catalog:

1. `bookmarks-data.json`, falling back to `bookmarks-data.sample.json`.
2. `media-cards-clean.json`, falling back to `media-cards.sample.json`.
3. Optional `web-clips.json` when present.
4. Optional `manual-media-notes.json` when present.

The loader emits one record for each deterministic source URL and image-zero media URL pair. Unsafe source or media URLs and records without a usable primary visual are skipped with bounded diagnostic reason codes. Source files are never modified.

`searchText` is derived in documented field order by normalizing and lowercasing each final scalar or list value, then appending up to `MAX_SEARCH_TEXT_LENGTH` (10,000 UTF-16 code units). Truncation never splits a surrogate pair and reports only a count plus the static `max_search_text_length_exceeded` reason; it never includes source content. Runtime ranking reads the structured fields, so truncating this convenience projection does not change search results.

Catalog timestamps must be calendar-valid ISO date-time strings with an explicit `Z` or numeric offset. Impossible dates, times, and offsets are rejected before parsing. Timezone-less, invalid, and unknown values normalize to `null`, so note conflict ordering does not depend on the process timezone.

Manual-note object-map keys remain exact internal resolver selectors. Array positions are validation indexes only; array entries resolve through explicit `recordId`, `mediaId`, or source-record/media-URL fields.

Validation errors identify entries by a static role and numeric index. They never include resolver selectors or source content.

Imported human-readable fields and lists reject non-whitespace C0/C1 controls while preserving the ordinary whitespace collapsing used by catalog normalization. Exact identity and resolver aliases are not rewritten. Human CLI rendering escapes any remaining terminal control bytes at the output boundary, including controls carried by exact identity fields, and JSON output remains valid machine-readable JSON.

## CLI

```bash
npm run search -- --query "dark minimal pricing" --category Interface --limit 8
npm run --silent search -- --query "workspace" --json
node tools/search.mjs --query "workspace" --json
npm run search -- --style Minimal --style Editorial --offset 20 --limit 20
```

Options:

- `--query <text>` accepts at most 2,000 characters and searches normalized title, description, creator, source, URLs, collections, taxonomy, visible content, tags, and manual-note text. Search work uses at most the first 64 unique letter-or-number terms.
- `--category`, `--style`, `--color`, `--interaction`, `--source`, and `--media-type` are repeatable exact facets.
- `--limit` defaults to 20 and cannot exceed 50. `--offset` defaults to 0.
- `--json` emits one valid JSON value on stdout. Catalog diagnostics use stderr. Use `npm run --silent search -- ... --json` for machine mode, or invoke `node tools/search.mjs ... --json` directly.

An empty query is valid for filtered or paginated browsing. Within one facet values use OR; different facets use AND. Only own filter properties are read; unknown names, including inherited object names such as `constructor`, `toString`, and `__proto__`, are rejected when supplied. Invalid flags and values exit non-zero without returning records.

## API

The existing loopback server exposes:

```text
POST /api/search       16 KiB request body limit
GET  /api/items/:id
```

Search request:

```json
{
  "query": "dark minimal pricing motion",
  "filters": {
    "category": ["Interface"],
    "style": ["Minimal"],
    "color": ["Dark"],
    "interaction": ["Motion"],
    "source": [],
    "mediaType": []
  },
  "limit": 8,
  "offset": 0
}
```

Search response:

```json
{
  "ok": true,
  "query": "dark minimal pricing motion",
  "total": 1,
  "limit": 8,
  "offset": 0,
  "results": [
    {
      "item": {
        "id": "visual:v1:pair-derived-sha256",
        "sourceUrl": "https://example.com/reference",
        "media": { "type": "photo", "url": "assets/sample-interface.svg", "width": 1400, "height": 1000 }
      },
      "score": 42,
      "matchReasons": [
        { "field": "styles", "value": "Minimal", "kind": "filter" },
        { "field": "title", "value": "pricing", "kind": "term" }
      ]
    }
  ]
}
```

`total` is calculated before pagination. Results include at most eight deterministic match reasons, generated only for the returned page. Every result has at least one reason when a query or filter is present. `GET /api/items/:id` returns only the requested normalized record or 404. No endpoint returns the complete catalog or its resolver-alias lookup.

The routes reuse the server's origin policy, CORS headers, `Cache-Control: no-store`, method allowlists, and `{ "ok": false, "error": "..." }` errors.

## Verification

```bash
npm run check:search
npm run check
```

The focused suites cover sample-only bootstrap, index precedence, invalid-present-index failure, ranking, every facet, own-property filter validation, empty queries, pagination, stable ordering, image-zero selection, card/list order invariance, bounded derived search text, timezone-independent note conflicts, URL safety, persisted aliases, optional web clips, manual-note privacy, CLI output separation, atomic publication, and read-only source files. Server smoke tests cover API equivalence and availability, item lookup, origin/method behavior, malformed input, the 16 KiB cap, note aliases and validation privacy, oversized derived search text, and static-file boundaries.

## Rollback

Deleting `inspiration-index.json` is the operational rollback to bootstrap mode. For a code rollback, restore direct bootstrap loading in the CLI/server, then remove the `search` and `check:search` package scripts, the `/api/search` and `/api/items/:id` route wiring, and the agent-search modules/tests/docs. The existing browser search, clipper, notes, extension, and static allowlist do not depend on the agent-search layer.

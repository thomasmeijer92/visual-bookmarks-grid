# Product Requirements: Search, Enrichment, Review, Boards, and Quality

Status: Implemented and merged in `public-remix-starter`

Target: Visual Bookmarks Grid public starter

## Implementation Record

The requirements below are retained as historical design intent. The five bets
were delivered and merged in the public-remix-starter repository as follows:

| Bet | Delivery PR | Merge commit |
| --- | --- | --- |
| Search | #16 | `f92972b` |
| Unified index | #17 | `019f606` |
| Metadata review | #18 | `bf657df` |
| Boards | #19 | `152f8aa` |
| Browser/extension quality gate | #20 | `a63e383` |

The roadmap PRD itself was merged as PR #15, commit `a4e8fdd`. These are
public-remix-starter delivery records; they document merged repository work, not hosted
deployment or changes to private local data.

## 1. Executive Summary

Visual Bookmarks Grid already stores visual inspiration, metadata, tags, manual
notes, and web clips. This product cycle made that local material useful to agents
while preserving the browser experience and the public starter's privacy boundary.

The original proposal defined five ordered, independently shippable V1 bets:

1. Agent-native inspiration search.
2. A unified ingestion and enrichment pipeline.
3. A human-in-the-loop metadata review queue.
4. A brief-to-board workflow.
5. Automated browser and Chrome extension quality gates.

The sequence was a dependency chain, not permission to bundle the work. Search
introduced a read-only catalog contract. Ingestion persisted that same contract.
Review added durable corrections to the pipeline. Boards reference stable catalog
ids. Browser automation protects the completed workflow.

## 2. Product Outcome

A user or local agent can move from a design question to a useful, traceable set of
references without opening hundreds of items manually.

Example outcome:

> Find dark, minimal pricing interfaces with motion. Return eight references,
> explain each match, preserve source links, and save the selection as a board.

The system remains local-first. Search, indexing, review, and boards do not make
network requests. The existing clipper may fetch a URL when the user explicitly
saves it. An optional enrichment module may use a network only when the user both
configures it and opts into that run.

## 3. V1 Product Boundaries

### Principles

- Local-first and private by default.
- Source-agnostic records; no downstream feature depends on one platform's shape.
- Stable identifiers and deterministic, idempotent jobs.
- Human corrections take precedence over imported or generated metadata.
- Every search result explains why it matched.
- Generated and user-owned data stays ignored; public fixtures remain generic.
- Fixed appetite, variable scope. Circuit-break a bet before expanding its stack.

### Non-Goals

- A hosted, multi-user, or remotely accessible service.
- Accounts, permissions, collaboration, assignments, or notifications.
- A general-purpose digital asset manager.
- Mandatory embeddings, paid APIs, cloud storage, or cloud inference.
- Automatic modification or synchronization of an upstream source.
- A migration of the existing bookmark, metadata-card, clip, or manual-note files.
- Indexing every image in a multi-image source item in V1.
- Committing real bookmarks, clips, notes, indexes, boards, exports, or credentials.

## 4. Shared Contracts

### 4.1 Normalized Catalog

Search, indexing, review, and boards operate on one derived catalog shape. Source
adapters own all knowledge of the current bookmark, metadata-card, web-clip, and
manual-note formats.

V1 creates one normalized candidate per grid-visible source item and emits one
record per deterministic dedupe group, using the same primary visual that the
browser grid displays. Only metadata resolved to that primary visual may contribute
visual-specific searchable fields and facets. Indexing every visual in a
multi-image item is intentionally deferred because the current grid renders one
primary image per item.

Catalog file shape:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "items": [
    {
      "id": "visual:v1:f98442995c295466838fb3cbeafb31909d802d72c70fe408f2b150c56ba0e7d3",
      "sourceType": "bookmark",
      "sourceRecordId": "sample-interface-001",
      "mediaId": "sample-interface-001-01",
      "sourceName": "Sample",
      "sourceUrl": "https://example.com/reference",
      "title": "Compact pricing interface",
      "description": "A dark pricing layout with three plans.",
      "creatorName": "Example Studio",
      "creatorHandle": "example",
      "creatorAvatarUrl": "https://example.com/avatar.png",
      "media": {
        "type": "photo",
        "url": "assets/sample-interface.svg",
        "width": 1400,
        "height": 1000
      },
      "collections": ["Interface"],
      "categories": ["Interface"],
      "styles": ["Minimal"],
      "colors": ["Dark"],
      "interactions": ["Motion"],
      "visible": ["Three pricing cards", "Dark navigation"],
      "tags": ["pricing", "saas"],
      "notes": [
        {
          "kind": "manual",
          "text": "Useful hierarchy reference.",
          "updatedAt": "2026-01-01T00:00:00.000Z"
        }
      ],
      "savedAt": "2026-01-01T00:00:00.000Z",
      "searchText": "normalized lower-case searchable text",
      "provenance": {
        "title": ["metadata-card"],
        "styles": ["metadata-card"],
        "notes": ["manual-note"]
      }
    }
  ],
  "resolverAliases": [
    {
      "sourceType": "bookmark",
      "sourceRecordId": "sample-interface-001",
      "sourceUrl": "https://example.com/reference",
      "mediaId": "sample-interface-001-01",
      "mediaIdAliases": [
        "sample-interface-001-01",
        "sample-interface-card-01"
      ],
      "mediaUrl": "assets/sample-interface.svg",
      "legacyNoteKeyAliases": [
        {
          "kind": "canonical",
          "key": "sample-interface-001:assets/sample-interface.svg"
        }
      ],
      "catalogId": "visual:v1:f98442995c295466838fb3cbeafb31909d802d72c70fe408f2b150c56ba0e7d3"
    }
  ]
}
```

Contract rules:

- `id` is the versioned V1 visual-identity id defined below. It is opaque to
  consumers and stable across rebuilds, source-file ordering, and changes to which
  duplicate candidate owns presentation fields.
- `sourceRecordId` preserves a native stable source id when one exists and is `""`
  otherwise. Native ids are resolver aliases, not catalog identity.
- `mediaId` is a non-empty alias for the selected primary visual. An adapter keeps
  a native stable media id when available; otherwise it derives
  `media-url:v1:<hex SHA-256>` from the canonical JSON encoding of
  `["catalog-media-url-v1", canonicalMediaKey]`. It does not depend on source-array
  or metadata-card ordering and never changes to a metadata-card id.
- `sourceType` is the adapter kind, such as `bookmark` or `web-clip`.
  `sourceName` is a human-readable platform, site, or imported source label.
- `sourceUrl` preserves the adapter-selected clickable source. For bookmarks this
  is the original source URL. For web clips it follows the explicit
  `canonicalUrl`-then-raw-`sourceUrl` rule below. URL canonicalization used for
  comparison must not replace the selected display spelling.
- Missing strings use `""`, missing lists use `[]`, and unknown timestamps use
  `null`. A timestamp is known only when it is a calendar-valid ISO date-time
  string with an explicit `Z` or numeric offset; impossible component values and
  timezone-less values are unknown.
  Adapters never invent claims to fill gaps.
- List values follow the deterministic spelling and ordering rules in Section
  4.2; source-array order never decides output spelling or order.
- `searchText` is derived output and is never accepted from a source or override.
  Normalize and lowercase final fields in contract order, then append deterministically
  up to `MAX_SEARCH_TEXT_LENGTH` (10,000 UTF-16 code units) without splitting a
  surrogate pair. Truncation emits only a bounded count and static reason, never
  source content, and cannot affect Bet One search over structured fields.
- `provenance` maps normalized field names to ordered origin labels. It must not
  contain provider credentials, prompts, local paths, or raw responses.
- `resolverAliases` is a sorted internal lookup, not a catalog item field. Its
  explicit `mediaIdAliases` and `legacyNoteKeyAliases` preserve alternate join
  identities without changing normalized `mediaId`. Search, item, and board-detail
  responses do not expose the complete lookup.
- The historical metadata-card `tweet` field is accepted only inside its adapter.
- A record without a usable primary visual is skipped in V1 and reported by reason.
- Source files and manual notes are never modified by catalog reads or index builds.

#### Canonical URLs and V1 Visual Identity

The server and source adapters use one shared URL canonicalizer before identity,
dedupe, metadata-card joins, aliases, or resolver comparisons. Consumers never
canonicalize or hash these values.

For an absolute URL, the canonicalizer:

1. trims surrounding ASCII whitespace, rejects controls, malformed URLs,
   credentials, and schemes other than `http:` or `https:`, and parses with the
   Node/WHATWG `URL` implementation;
2. serializes the parsed URL after lowercasing scheme and ASCII host, applying
   WHATWG host/percent encoding, removing the default port, resolving path dot
   segments, and removing the fragment; and
3. preserves path case, a non-default port, trailing-slash significance, and the
   query's key order, duplicate keys, empty values, and encoded value semantics.
   V1 does not remove tracking parameters, sort query keys, or equate `http` with
   `https`.

The resulting comparison key is `web:<serialized-url>`. A usable selected source
URL must be an absolute HTTP(S) URL. Its selected original spelling remains the
clickable display value, but its `web:` key receives exactly the same normalization
as an absolute media URL.

For a web clip, source-field selection happens before canonicalization and is part
of normalization: use `canonicalUrl` when it is a syntactically valid absolute
HTTP(S) URL; otherwise use raw `sourceUrl` when that is valid. If neither is valid,
skip the clip with `invalid_source_url`. The chosen value becomes normalized
`sourceUrl`, `canonicalSourceKey`, catalog identity, resolver-alias `sourceUrl`, and
the browser's source hint. The unchosen raw capture URL is not an alternate identity
and cannot join or resolve the record. This matches the existing browser display,
link, and metadata-card behavior, which prefers `canonicalUrl`.

A primary-media URL may instead identify a local asset in either application-root-
relative `/assets/...` form or repository-relative `assets/...` form. The shared
server-side canonicalizer applies this exact contract:

1. Trim surrounding ASCII whitespace and reject an empty value, input beginning
   with `//`, or a raw path containing an ASCII control, DEL, NUL, backslash, or
   malformed percent escape. The `//` rule rejects protocol-relative URLs before
   WHATWG parsing. Split only the path portion before the first literal `?` or `#`
   into structural slash-delimited segments.
2. Validate each raw segment, then call `decodeURIComponent` repeatedly, stopping
   when the value is unchanged or after four decode passes. Validate after every
   pass: reject malformed escapes or a decode error; `..`; a slash or backslash
   produced inside a segment; ASCII controls, DEL, or NUL; and a colon in the first
   non-dot segment. Literal `.` structural segments remain allowed. If pass four
   still leaves a percent escape that another decode would change, reject with
   `decode_depth_exceeded`; no consumer may decode a canonical key again. This is
   the same four-pass bound as the existing server request-path decoder while
   refusing a representation whose server-visible meaning remains uncertain.
3. Rebuild the path from the fully decoded structural segments, assign it as the
   pathname of `new URL("https://local.invalid/")`, and take the query from parsing
   the original trimmed value against that same base. Require the original parsed
   origin to remain exactly `https://local.invalid`, then require the rebuilt
   serialized pathname to start with `/assets/` and contain a non-empty path below
   that logical root. WHATWG pathname assignment deterministically percent-encodes
   safe decoded characters and removes allowed `.` segments; validation has already
   rejected traversal and encoded separators.
4. Form the comparison key as
   `local:<rebuilt pathname without its one leading slash><original parsed search>`.
   Preserve path case, trailing-slash significance, and query key order, duplicates,
   empty values, and encoded value semantics exactly as WHATWG serializes them.

Consequently `/assets/clips/web-example/image.webp`,
`assets/clips/web-example/image.webp`, and
`./assets/clips/web-example/image.webp#preview` all produce
`local:assets/clips/web-example/image.webp`. A changed query or filename produces a
different key. Safe encodings normalize by decoded meaning, so `%73ample.svg` and
`sample.svg` compare identically while display values remain unchanged. Inputs such
as `//assets.example/image.webp`, `/other/image.webp`, `/assets/../image.webp`,
`/assets/%2e%2e/image.webp`, `/assets/%252e%252e/image.webp`,
`/assets/clips%2fprivate/image.webp`, `/assets/clips%252fprivate/image.webp`,
`/assets/clips%255cprivate/image.webp`, or a path containing `\`, a control, NUL,
or `%ZZ` are invalid. Deeper fixtures include `%25252e%25252e`, `%25252f`,
`%25255c`, and their four-pass equivalents; fixtures expose traversal, slash,
backslash, control, NUL, and malformed escapes on each pass. A five-layer encoding
that remains decodable after pass four fails with `decode_depth_exceeded`.
The canonical value is a comparison key only: normalized records and resolver
aliases retain the original media URL for browser display.

The generic acceptance fixture includes the current web-clip shape emitted by the
local clipper:

```json
{
  "id": "web-example-001",
  "sourcePlatform": "Example",
  "sourceUrl": "https://example.com/captured?from=clipper",
  "canonicalUrl": "https://example.com/reference",
  "title": "Root-relative clip",
  "media": {
    "type": "photo",
    "url": "/assets/clips/web-example-001/image.webp",
    "width": 1200,
    "height": 900
  }
}
```

The fixture matrix also runs this record with `id` omitted and with `id: ""`.
Those variants normalize `sourceRecordId` to `""`, derive `mediaId` from the
canonical media key, and remain valid because catalog identity is the canonical
source/media pair rather than a native clip id. In all three cases the selected
normalized `sourceUrl` is `https://example.com/reference`, not the differing raw
capture URL. Bootstrap, indexing, search, aliases, and resolver comparisons use its
`web:` key and `local:assets/clips/web-example-001/image.webp`; returned source links
use the selected canonical URL and previews keep
`/assets/clips/web-example-001/image.webp`. A companion fixture makes
`canonicalUrl` absent, then malformed, and verifies both cases fall back to the
valid raw `sourceUrl`; a fixture with both invalid is skipped.

Every candidate receives the same V1 catalog id before dedupe:

```text
visual:v1:<hex SHA-256 of the UTF-8 bytes of
  canonical JSON(["catalog-visual-v1", canonicalSourceKey, canonicalMediaKey])>
```

The array uses the canonical keys above and the canonical JSON algorithm below; no
locale or presentation values enter the hash. This works in
the read-only bootstrap before an index exists and needs no redirect table or
mutable identity history. Adding, removing, or reprioritizing another source record
for the same canonical pair cannot change the id.

Changing either canonical URL intentionally creates a new V1 visual item. A change
that only changes display spelling normalized away above does not. V1 does not
redirect across intentional identity changes: the old review entry remains attached
to the old id and an old board reference becomes unavailable until explicitly
replaced. Native source/media ids, titles, owners, timestamps, and metadata changes
never create or preserve catalog identity by themselves.

#### Canonical JSON and Fingerprints

Every SHA-256 input in this roadmap uses one recursive canonical JSON serializer,
including catalog ids, derived media ids, review ids, source-note fingerprints, and
card, note, and normalized-base tie-breaks. The algorithm is exact:

1. Accept only JSON-domain values: `null`, booleans, strings, finite numbers, dense
   arrays, and plain objects with string keys. Reject `undefined`, sparse array
   slots, non-finite numbers, `BigInt`, functions, symbols, cycles, and non-plain
   object instances; do not omit or coerce them.
2. Preserve array order. For every object at every depth, sort keys by ascending
   UTF-16 code-unit sequence using ordinary relational comparison, never
   `localeCompare`, and serialize each value recursively. Empty arrays and objects
   remain `[]` and `{}`.
3. Preserve string code points exactly as supplied to the fingerprint input; field-
   specific NFKC, whitespace, or case normalization happens before this serializer
   only where its contract explicitly requires it. Emit strings with JSON's standard
   escapes for quotes, backslashes, and controls, with no locale-dependent transform.
4. Emit `null`, `true`, and `false` literally. Normalize `-0` to `0`; serialize every
   other finite number using ECMAScript `JSON.stringify`'s shortest round-trippable
   decimal representation. No insignificant whitespace is emitted.
5. Encode the resulting string as UTF-8 without a BOM, hash those bytes with
   SHA-256, and render lowercase hexadecimal.

Canonical JSON preserves array order by design, so no role hashes a raw source
object directly. Before serialization, the adapter builds a role-specific normalized
fingerprint projection from the complete validated object. The adapter schema must
classify every accepted array path as semantically unordered or ordered; an
unclassified array is a validation error rather than an encounter-order tie-break.
Source-file container order and a candidate's position in that container never enter
an individual candidate projection.

The projections apply these exact rules:

- Every scalar or array source field that maps to `collections`, `categories`,
  `styles`, `colors`, `interactions`, `visible`, or `tags` is semantically
  unordered. Collapse source-format aliases to that normalized field name, normalize
  string members with Section 4.2's NFKC, whitespace, case-folded comparison-key,
  and display-spelling tie-break rules, deduplicate by comparison key, and sort by
  comparison key with normalized display spelling as the final tie-break. A scalar
  accepted by an adapter for one of these list roles is treated as a one-member
  list. Invalid or non-string members are rejected, not omitted.
- The normalized-base projection applies that unordered-list rule to every supported
  base field mapped to those catalog lists. It preserves only adapter-declared arrays
  whose order changes base meaning, including the primary visual array where image
  zero is authoritative and any explicit ordinal/ranking evidence.
- The metadata-card projection applies the same unordered-list rule to card style,
  color, taxonomy, interaction, visible-content, tag, collection, and equivalent
  adapter aliases. It preserves only arrays that encode semantically ordered media
  or ordinal evidence. The surrounding metadata-card candidate array is excluded.
- The manual-note projection excludes the surrounding notes-array position and
  applies the same rule to any validated note field mapped to a catalog list. V1's
  note text and timestamps remain normalized scalars; any future accepted note array
  must be classified before it can participate in a fingerprint. Explicitly ordered
  history or ordinal data remains ordered.

"Canonicalized card JSON", "canonicalized note JSON", and "canonicalized normalized
base JSON" below mean these projections serialized by the canonical JSON algorithm.
Adapters must reject source-format values outside the supported JSON domain instead
of omitting or coercing them at hash time. Therefore permuting or duplicating an
unordered semantic list cannot change primary-card selection, presentation-owner
selection, or a conflicting-note winner, while changing a truly ordered array may.

#### Primary Visual and Metadata-Card Resolution

Adapters resolve the primary visual once, before merge, search, notes, overrides,
or boards can inspect a record:

1. For a bookmark, `images[0]` is authoritative. No metadata card, scan status,
   search result, note, override, or board may replace it with another image. For a
   web clip, the equivalent is its existing locally saved primary asset.
2. The adapter preserves a stable base media id for image zero as normalized
   `mediaId`, or derives the URL-hash alias specified above when the base image has
   no native id. A selected card's media id is an alternate alias only; it never
   replaces this base-owned value. Image zero selects the visual, but its array
   position, source id, and media aliases do not enter catalog identity and no id
   depends on which metadata card was read first.
3. Metadata-card candidates first join by the card's historical source-id field.
   The adapter then selects at most one primary card using this ordered evidence:
   exact declared media id, exact canonical media URL, then an adapter-recognized
   source-id plus zero-based/first-media ordinal encoded by the card. Every URL
   comparison uses the exact shared canonicalizer above, including its absolute
   source/media and safe relative-local rules.
4. Ties at one evidence level sort by `mediaId`, canonical media URL, then a SHA-256
   hash of canonicalized card JSON. If a base item has exactly one visual and none
   of the evidence matches, a final fallback ranks `vision_scanned` before other
   statuses and applies the same tuple. A multi-image item with no positive match
   gets no primary card; V1 must not guess that a secondary image describes image
   zero.
5. The normalized record's `media` always comes from the base primary visual. A
   matched card can enrich descriptive fields but cannot replace `media` or
   `mediaId`. Non-primary cards are counted as joined-but-unused and cannot affect
   V1 search, note context, review overrides, or board previews.

Each base candidate materializes those read-only identities on its resolver row.
`mediaIdAliases` is a non-empty string array containing normalized base `mediaId`
and, when valid, the selected primary card's media id. This explicitly represents
the common case where the base image has no native id and therefore uses a derived
`mediaId` while its matched card has a native id. `legacyNoteKeyAliases` contains
objects shaped `{ kind, key }` for every exact legacy key the note adapter recognizes,
including the current `<source-id>:<media-url>` form. `kind` is one of `canonical`,
`card`, or `url`, from highest to lowest tie-break priority; it identifies the
adapter rule that produced the key and is not user-visible provenance.

Alias strings are validated non-empty bounded strings and compared exactly, without
case folding or Unicode normalization. Collapse exact values, sort `mediaIdAliases`
by ascending UTF-16 code-unit sequence, and sort legacy objects by the fixed kind
rank above then `key` using the same comparison. New notes write canonical
`recordId` and normalized `mediaId`. Legacy object-map keys resolve only through
exact `legacyNoteKeyAliases`. Array positions are validation indexes, never resolver
aliases; array entries require an explicit record, media, or source/media selector.
If one key reaches multiple catalog ids it is `ambiguous`,
is reported as an alias conflict, and remains unattached. If multiple distinct
legacy notes resolve to one primary visual, choose the note with the latest valid
`updatedAt`, then `canonical` over `card` over `url`, then SHA-256 of canonicalized
note JSON; report the others as conflicts. Search, review, and board code consume
the normalized record and shared alias lookup and never repeat card selection.

### 4.2 Deterministic Merge and Dedupe

Normalization uses the following field-level precedence. “First non-empty” means
the first source in the listed order. An accepted override key is authoritative
even when its explicit value is an empty string or array.

| Normalized fields | Rule and high-to-low source precedence |
| --- | --- |
| `id` | Derived only from the group's canonical source/primary-media pair; never copied from an owner, enriched, or overridden. |
| `sourceType`, `sourceRecordId`, `mediaId`, `media`, `savedAt` | Presentation-owning base record only; never enriched or overridden. |
| `sourceUrl` | Presentation-owning base record, then another record in the same group. Every candidate has the same canonical source key. |
| `sourceName` | Presentation-owning base record, primary metadata card. |
| `title`, `description` | Accepted manual override, primary metadata card, presentation-owning base record, optional enricher. |
| `creatorName` | Accepted manual override, presentation-owning base record, primary metadata card. |
| `creatorHandle`, `creatorAvatarUrl` | Presentation-owning base record, primary metadata card. |
| `collections` | User/source-owned only: accepted override replaces the field; otherwise union presentation-owning base and remaining duplicate base records. Cards and optional enrichers cannot contribute. |
| `categories`, `styles`, `colors`, `interactions`, `visible` | Accepted override replaces the field; otherwise union primary metadata card, presentation-owning base, remaining duplicate base records, optional enricher. |
| `tags` | Accepted override replaces the field; otherwise union presentation-owning base, remaining duplicate base records, primary metadata card, optional enricher. |
| `notes` | Resolved manual notes only. For the one note selected per catalog record, choose latest valid `updatedAt`, then alias kind `canonical`, `card`, `url`, then deterministic fingerprint. Catalog record/media grouping remains deterministic. Enrichers and cards cannot create notes. |
| `searchText` | Derived last from the final normalized fields; never merged. Append in contract field order up to `MAX_SEARCH_TEXT_LENGTH` without splitting a surrogate pair. |
| `provenance` | Derived from the winning scalar or ordered list contributors after merge. |

For scalar conflicts at the same precedence, normalize strings with Unicode NFKC,
trim and collapse whitespace, then choose the lexicographically smallest
case-folded value, with the normalized display value as the final tie-break. For
lists, comparison keys use the same normalization. The display spelling comes from
the highest-precedence source containing that key; conflicts within that source use
the scalar tie-break. Emit list values sorted by comparison key, not encounter
order.

Duplicate groups contain exactly the candidates with the same V1 catalog id, which
is equivalent to the same canonical `(sourceUrl, primary-media URL)` pair. Native
source or media ids alone never join groups. Choose the presentation-owning base
record by this ascending tuple: has a native stable source id before no native id,
`sourceType`, normalized `sourceRecordId`, canonical source key, canonical media
key, then SHA-256 of canonicalized normalized base JSON. Merge the group using the
table above and count every discarded base record. The tuple may change which
candidate supplies presentation fields when duplicates appear or disappear, but it
cannot change the already-derived catalog id. The owner tuple, field merge, display
spelling, catalog id, and output order are independent of input-file and array
ordering.

Emit one `resolverAliases` row for every base candidate, including discarded
duplicates, with `sourceType`, `sourceRecordId` (empty when no native id), selected
original `sourceUrl`, base-owned non-empty `mediaId`, sorted `mediaIdAliases`,
original primary `mediaUrl`, sorted `legacyNoteKeyAliases`, and the pair-derived
`catalogId`. When rows have identical scalar selector fields and `catalogId`, union
their alternate arrays, collapse exact aliases, and re-sort them; this is the only
alias-row merge. Then sort rows by `sourceType`, `sourceRecordId`, canonical source
key, `mediaId`, canonical media key, then `catalogId`, all with ordinary UTF-16
code-unit comparison and never locale-aware comparison.

One complete canonical `(sourceType, source URL, primary-media URL)` selector cannot
map to multiple catalog ids; that is an index-validation error. Native source ids,
alternate media ids, and legacy note keys are hints rather than identity and may
legitimately collide across rows. A lookup that still reaches multiple catalog ids
after all supplied exact URL and id hints is `ambiguous` and never picks by row order.
Bet One builds this exact structure in memory. Bet Two persists it byte-for-byte in
the index, and index load validates and consumes it rather than reconstructing
aliases from normalized items. Bet Three reconciliation and Bet Four resolution use
the same lookup so bootstrap and persisted-index behavior cannot diverge.

### 4.3 Bootstrap and Index Precedence

Bet One must work before a generated index exists. It therefore introduces a
read-only catalog loader that applies the existing runtime fallback rules:

1. Use local bookmark and metadata-card files when present; otherwise use their
   committed sample fallbacks.
2. Join local web clips and manual notes only when those files are present.
3. Return normalized records in memory without writing any files.

From Bet Two onward, search uses `inspiration-index.json` when it is present and
passes schema validation. If the file is absent, search uses the read-only loader.
If the file is present but invalid, commands and APIs fail with a clear validation
error rather than silently serving stale or sample results.

### 4.4 Local Files

The roadmap defines these ignored local files:

```text
inspiration-index.json   # generated, rebuildable catalog
metadata-review.json     # user-owned queue state and accepted patches
metadata-review.lock     # ignored ephemeral single-writer lock
boards.json              # user-owned boards
boards.lock              # ignored ephemeral single-writer lock
```

Tests may use committed fixtures under `test/fixtures/` with generic local or
`example.com` data. Raw local files are read server-side and are not added to the
static-file allowlist. A fresh clone must work without any ignored file.

### 4.5 Local Service and CLI Boundaries

- Extend the existing dependency-light Node server; do not introduce a web
  framework, database, bundler, or frontend framework for these bets.
- Keep the default loopback bind. Remote or LAN deployment is unsupported in V1.
- New APIs reuse the server's existing origin checks, no-store responses, bounded
  request bodies, allowlisted methods, and `{ "ok": false, "error": "..." }`
  errors.
- Collection endpoints are bounded or paginated. No endpoint returns the full
  catalog by default.
- API and CLI output never exposes local paths, environment values, credentials,
  provider responses, raw manual-note map keys, or source file contents beyond the
  requested records. Validation identifies manual-note entries by static role and
  numeric index while retaining exact keys only for internal resolution.
- With `--json`, stdout contains one valid JSON value and diagnostics go to stderr.
  Human-readable mode may use stdout for results.
- Invalid arguments exit non-zero; API validation failures use a 4xx response.
- PRs One through Four should use Node built-ins and the repository's current
  CommonJS/`.mjs` conventions. Only the quality-gate PR is expected to add a test
  dependency.

### 4.6 Shared Quality Gate

Every feature PR must:

- use its own branch based on the freshly merged preceding bet;
- document new commands, APIs, local files, and rollback behavior;
- add each feature-owned generated, user-owned, or ephemeral file/lock to
  `.gitignore` before any code path or test can generate it, and verify each exact
  path with an automated `git check-ignore` assertion;
- include deterministic fixtures and focused contract tests;
- run `npm run check` from a clean sample-only setup;
- confirm generated and user-owned files remain ignored and unserved;
- preserve existing clipper, note, browser-search, and extension behavior; and
- receive an independent review before merge.

## 5. Bet One: Agent-Native Inspiration Search

### Problem

The browser can search visually, but agents do not have a stable, documented way to
query the same corpus and return traceable results. Reading raw JSON encourages
inconsistent scripts and accidental bulk disclosure.

### Appetite

Two to three focused days.

### Required Slice

Build one read-only search core over the bootstrap catalog and expose it through:

1. a JavaScript module shared by tests, CLI, and server;
2. a CLI for local agents and scripts; and
3. a JSON API on the existing server.

No browser UI rewrite and no MCP adapter are part of this PR.

### Search Contract

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

Required behavior:

- Search title, description, creator, source name, URLs, collections, taxonomy,
  visible content, tags, and note text from normalized records.
- Use deterministic lexical ranking only. At least one text term must match when
  `query` is non-empty; remaining terms are soft ranking signals.
- Treat filters as hard constraints. Values are OR within one facet and AND across
  facets, using case-insensitive exact matching against normalized values. Read only
  own filter properties and reject every supplied unknown name, including names
  inherited by ordinary JavaScript objects.
- Rank exact phrases and title/taxonomy matches above scattered description or note
  matches. Tie-break by normalized title, then stable `id`.
- Return structured, human-readable match reasons. Reasons identify the matched
  field and value without quoting an entire note or description.
- Support empty-query filtered browsing.
- Default `limit` to 20, cap it at 50, require non-negative integer `offset`, and
  report `total` before pagination.

CLI contract:

```bash
npm run search -- --query "dark minimal pricing" --category Interface --limit 8
npm run --silent search -- --query "workspace" --json
```

HTTP contract:

```text
POST /api/search       # request body limit: 16 KiB
GET  /api/items/:id
```

Search response:

```json
{
  "ok": true,
  "query": "dark minimal pricing",
  "total": 4,
  "limit": 8,
  "offset": 0,
  "results": [
    {
      "item": {},
      "score": 18,
      "matchReasons": [
        { "field": "styles", "value": "Minimal", "kind": "filter" },
        { "field": "title", "value": "pricing", "kind": "term" }
      ]
    }
  ]
}
```

`GET /api/items/:id` returns one normalized record or 404. It does not expose the
catalog's filesystem location or neighboring records.

### Acceptance Criteria

- Ten generic golden requests cover text ranking, empty queries, pagination, and
  every supported facet; expected ids and order are deterministic.
- CLI and API call the same search function and return equivalent result data.
- Unknown filter names, invalid value types, oversized limits, and malformed bodies
  fail clearly without returning the catalog.
- Every result includes a stable id, source URL, primary preview media, score, and
  at least one reason for a non-empty query or filter.
- A sample-only clean clone runs CLI and API search without first building an index.
- With no generated index present, the root-relative web-clip fixture from Section
  4.1 is loaded through bootstrap even when its native `id` is empty or missing.
  CLI and API search return it with the original
  `/assets/clips/web-example-001/image.webp` preview URL and a derived non-empty
  `mediaId`; no adapter rewrites the source file or requires filesystem access.
- Existing browser search behavior remains unchanged.

### No-Gos and Circuit Breaker

- No embeddings, vector database, model call, writes, browser UI integration, or
  MCP installer.
- If one ranking pass cannot satisfy all subjective golden ordering, keep explicit
  filtering and deterministic scoring, document the disputed cases, and ship. Do
  not add semantic infrastructure inside this appetite.

## 6. Bet Two: Unified Ingestion and Enrichment Pipeline

### Problem

Bookmarks and web clips enter through different paths and receive different
metadata depth. Search needs a current, validated catalog without making its query
layer understand every source format.

### Appetite

One focused week.

### Required Slice

Reuse the Bet One adapters in an idempotent local pipeline:

```text
bookmarks + metadata cards --\
                              -> normalize -> deterministic enrichment -> index
web clips + manual notes ----/
```

The built-in pipeline is fully offline: it reads all supported local inputs,
validates and joins them, derives built-in metadata without network access, and
atomically writes `inspiration-index.json`. It never refreshes remote sources and
never rewrites an input file. External enrichment is a separate execution mode,
not part of the default build or release gate.

### Pipeline Contract

Source roles:

- Bookmarks and web clips are base records.
- Metadata cards and manual notes are join-only enrichment inputs.
- Metadata cards join through the current historical source-id field and, where
  available, media id. Orphans are skipped and counted, not promoted implicitly.
- Web clips preserve their existing stable clip id when it is present and use their
  locally saved primary asset. An empty or missing clip id is valid and follows the
  shared no-native-id alias and derived-`mediaId` rules. Their normalized source
  identity uses the first valid `canonicalUrl`, then raw `sourceUrl`; adapters do not
  retain the unchosen capture URL as a resolver alias.

Stages:

1. Read and validate all present sources.
2. Normalize one candidate per grid-visible base item.
3. Select image zero and its primary card with the shared resolution algorithm,
   materializing base, selected-card, and legacy-note aliases.
4. Select web-clip source identity, canonicalize source and primary-media URLs, and
   derive pair-based stable ids.
5. Merge and deduplicate with the shared field precedence and tie-break rules while
   retaining sorted aliases for every base candidate.
6. Optionally enrich missing allowlisted fields through one configured module.
7. Derive `searchText`, sort records by stable `id`, validate the complete output,
   and atomically replace the previous valid index.

Command contract:

```bash
npm run index:build
npm run index:check
npm run index:build -- --enricher ./local-enricher.mjs --allow-external-enrichment
```

There is no source-selective write in V1 because a partial rebuild could silently
drop other sources from the authoritative index.

Optional enricher contract:

```js
export async function enrich(record, context) {
  return {
    patch: { visible: ["Three pricing cards"] },
    provenance: { visible: "configured-enricher" }
  };
}
```

External enrichment rules:

- No provider implementation or SDK is bundled.
- Double opt-in is mandatory: `--enricher <path>` explicitly configures a module
  for that invocation and `--allow-external-enrichment` separately authorizes it
  to run. Supplying only one fails validation before the module is imported. There
  is no saved implicit opt-in, auto-discovery, or environment-only activation.
- The documented provider payload excludes manual notes and credentials. It may
  include title, description, taxonomy, and primary media needed for enrichment;
  documentation must state that those fields may leave the machine if the module
  uses a network. Primary-media URLs are included only for query- and
  fragment-free HTTP(S) URLs without user info hosted by a domain name that
  passes the syntactic local/internal and special-use policy. Every IPv4- or
  IPv6-literal media location is omitted, whether public, private, reserved,
  or special-purpose; the check is syntactic and does not resolve DNS.
  Signed/query-credential URLs, IP literals, and local, localhost, internal,
  or special-use domain locations are omitted.
- Patches may only fill missing `title`, `description`, `categories`, `styles`,
  `colors`, `interactions`, `visible`, and `tags`. They cannot change ids, source
  fields, media, creator fields, `collections`, notes, or existing non-empty values.
  This list is the complete allowlist and exactly matches the optional-enricher rows
  in Section 4.2; `collections` remains user/source-owned.
- Build and validate the complete offline base catalog before calling the module.
  Each record call has a fixed 30-second deadline exposed as `context.signal`.
  Stage all external patches in memory. If every attempted record succeeds and all
  patches validate, apply the complete batch and publish one enriched index. If any
  record throws, times out, or returns an invalid patch, collect a bounded error for
  each failed record, discard every external patch from that run, publish the
  complete validated offline base catalog atomically, and exit non-zero. Never mix
  successful external patches with unenriched records or retain stale external
  fields from the previous index.
- Error summaries identify records by opaque catalog id and stable reason code;
  they do not include provider text or raw record content. JSON and human output
  report `enrichmentAttempted`, `enrichmentFailed`, `enrichmentApplied`, and
  `publishedMode` (`offline-base` or `external-complete`).
- Raw prompts, responses, and record content are not logged or persisted.

### Acceptance Criteria

- Sample bookmarks and cards plus the Section 4.1 root-relative web-clip fixture
  and a note build one valid, source-agnostic catalog. The test covers present,
  empty, and missing clip ids.
- Reordering source arrays does not change ids, normalized records, or output order.
- Fingerprint fixtures independently permute and duplicate unordered base and card
  `collections`, taxonomy, style, color, interaction, visible-content, and tag
  values, including source-format aliases and scalar/list forms. They also permute
  metadata-card and manual-note container order. Primary-card selection, the
  presentation-owner tie-break, conflicting-note selection, normalized output, and
  every resulting fingerprint remain identical. A companion fixture changes base
  primary-visual order and verifies that this truly ordered semantic input is not
  sorted away.
- Two runs with identical inputs and no external enricher produce identical `items`
  and `resolverAliases`; only top-level `generatedAt` may differ.
- A base image without a native media id and a selected metadata card with a native
  media id keeps the base-derived value as normalized `mediaId`. Bootstrap and the
  persisted index retain both values in sorted `mediaIdAliases`, retain all sorted
  `legacyNoteKeyAliases`, and resolve the same exact selectors and note keys.
- Duplicate canonical source/primary-media pairs use the shared presentation-owner
  tuple and field table, increment a dedupe count, and produce identical display
  spelling when all source arrays and files are reordered. Equal native ids with
  different canonical URL pairs remain separate visual items.
- Starting with one candidate, adding a higher-priority duplicate for the same
  canonical URL pair and then removing it across two rebuilds leaves the original
  catalog id present after every build. The test runs through both bootstrap and
  persisted-index paths and requires every exact alias selector present in each
  build to resolve that id.
- Empty or lower-precedence metadata does not replace richer existing metadata;
  generic Bet Two fixtures exercise every applicable imported/enricher row of the
  field-precedence table. Bet Three adds the override rows.
- An invalid input, failed final validation, or interrupted write leaves the prior
  valid index untouched.
- With external mode enabled, an all-success batch publishes all staged patches. A
  mixed success/failure batch publishes a complete offline-base index, applies zero
  external patches, reports each failed record without provider content, and exits
  non-zero.
- Human and JSON summaries report per-source read counts plus normalized, enriched,
  skipped-by-reason, deduplicated, failed, and written counts.
- `index:check` validates schema, unique ids, required URLs/media, canonical-key/id
  agreement, canonical JSON fingerprints, sorted resolver rows and nested alias
  arrays, complete URL-pair uniqueness, reported native/media/legacy-alias
  ambiguity, and derived fields without modifying the file.
- Before the first index build can create output, Bet Two adds the exact root
  `inspiration-index.json` ignore entry and its checks prove the path is ignored and
  unavailable through static serving.
- The persisted index retains the fixture's original
  `/assets/clips/web-example-001/image.webp` media and alias URL. After restart,
  indexed search returns that browser-usable preview and produces the same catalog
  id and canonical media key as bootstrap; replacing only that fixture spelling
  with `assets/clips/web-example-001/image.webp` does not change either value.
- The web-clip fixture whose raw `sourceUrl` differs from valid `canonicalUrl`
  persists the canonical value as normalized `sourceUrl` and resolver source hint.
  Missing or invalid `canonicalUrl` falls back to valid raw `sourceUrl`; no path
  creates an alias for both values.
- Bet One search consumes the valid index without ranking or API changes, and still
  falls back to the read-only loader after the index is deleted.

### No-Gos and Circuit Breaker

- No upstream sync, cookie handling, scheduler, daemon, bundled AI provider,
  perceptual dedupe, database, or review overrides in this PR.
- The release gate and sample-only checks do not load an external module and assert
  that the index build makes no network requests. External-mode contract tests use
  local stub modules; live provider calls are never a merge requirement.
- If one source cannot map cleanly, keep it behind its adapter and report skipped
  records. Do not distort the shared schema around a source-specific edge case.

## 7. Bet Three: Metadata Review Queue

### Problem

The lightbox saves rough manual notes with `needs_agent_review`, but there is no
workflow that distinguishes unresolved feedback from accepted corrections. Edits
must survive index rebuilds without rewriting imported or generated source data.

### Appetite

Two to three focused days.

### Required Slice

Add a local review state machine backed by one atomically written
`metadata-review.json` file. Manual notes remain a separate existing source file,
so V1 does not claim a cross-file atomic transaction. Instead, a note write is the
durable intake intent and the review file is a deterministically reconciled
materialized state. Status, event history, and accepted patches remain together in
the review file.

```text
needs_review -> resolved
             -> dismissed
resolved or dismissed -> needs_review
```

The current lightbox note editor remains the intake UI. Queue operations are CLI
and API only in V1; there is no review dashboard.

### Review Contract

- A non-empty manual note with `needs_agent_review` creates or updates one queue
  entry for its normalized `recordId`, which is the pair-derived catalog id.
- New note saves include `recordId` when available. Existing notes resolve through
  the exact persisted `legacyNoteKeyAliases`; unresolved or ambiguous keys are
  reported with candidate record ids when available and remain unchanged. An
  ambiguous note preserves its candidate queue entries; a fully unresolved note
  conservatively suppresses source-deletion inference for existing entries.
  Reconciliation consumes the in-memory bootstrap or validated index alias rows
  and never reconstructs keys from normalized items.
- Re-saving an unchanged note is idempotent. Any changed fingerprint or restored
  note appends exactly one `source_note_updated` reopen event, including while the
  entry is already pending; a pending self-reopen is not a user transition.
- Deleting a pending note dismisses its entry with reason `source_note_deleted`.
  Deleting a note never removes event history or an already accepted patch.
- Resolving requires a non-empty structured patch. Dismissing requires a reason.
- Every transition appends `{ at, action, reason }`; V1 stores no reviewer identity.
- The active accepted patch remains effective if later feedback reopens the entry,
  until a new resolution replaces it.

Each queue entry stores `recordId` and a deterministic review id defined as
`review:v1:<hex SHA-256>` over the canonical JSON encoding of
`["catalog-review-v1", recordId]`, plus current `mediaId` context,
`sourceNoteFingerprint`, `sourcePresent`, status, events, and an optional
`acceptedPatch`. The fingerprint is SHA-256 over canonical JSON of
`{ recordId, normalizedNoteText }`; timestamps, media aliases, owner fields, and
source-array positions are excluded. Accepted patches are looked up and applied by
`recordId`, never by the current presentation owner's source or media alias.

#### Note Intake, Reconciliation, and Recovery

All note/review mutations use one shared server/CLI module and an ignored exclusive
`metadata-review.lock`; a busy lock fails clearly instead of writing concurrently.
The owner removes the lock in `finally`. A lock older than 60 seconds is recoverable
only when its recorded process is no longer running. The lock file is never served.

A lightbox note mutation follows this write order:

1. Acquire the lock, validate both current files, and reconcile them in memory.
2. Atomically replace `manual-media-notes.json` with the requested note mutation.
3. Reconcile from the now-committed note payload and atomically replace
   `metadata-review.json` if its state changed.
4. Release the lock. Only then report both note and queue success.

If step 2 fails, neither state changes. If the process stops or step 3 fails after
step 2, the note remains durably saved and the API returns a failure with
`noteSaved: true`, `reviewQueued: false`, and reason `review_reconcile_pending`;
it must not claim the note was lost. The next server startup, queue read, queue
mutation, explicit `review:reconcile`, or index build runs the same reconciliation
under the lock before using review state. A busy or unrecoverable reconciliation
fails with 503/non-zero rather than serving or indexing stale queue state.

Reconciliation first resolves each note by canonical `recordId` or exact
`legacyNoteKeyAliases`. Within each deterministic catalog record/media group, it
selects the latest valid `updatedAt`, then alias kind `canonical`, `card`, `url`,
then deterministic fingerprint, and applies these rules:

- A resolvable new note creates `needs_review`; an unchanged fingerprint and
  `sourcePresent: true` is a no-op, including an unchanged re-save.
- A changed fingerprint or a note returning after deletion sets
  `needs_review` and appends one reopen event.
- A missing note changes `sourcePresent` to false. If its entry is pending, it also
  becomes dismissed with `source_note_deleted`; a resolved or already dismissed
  status does not change.
- `sourcePresent` is replayed only from source events: intake and
  `source_note_updated` mean present, while `source_note_deleted` means absent.
  User resolve, dismiss, and reopen transitions do not change it, so a manually
  reopened source-deleted entry may be `needs_review` with `sourcePresent: false`.
- Event time comes from the note's `updatedAt`, or the notes payload's
  `generatedAt` for deletion recovery, rather than reconciliation wall time. An
  identical pair of input files therefore produces an identical review file.
- Reconciliation updates only source linkage, fingerprint, presence, status, and
  intake events. It never deletes or clears an `acceptedPatch`, accepted-patch
  provenance, resolution event, or unrelated entry. An invalid existing review
  file is an error and is preserved for repair, not replaced from notes.

The explicit reconciliation command is:

```bash
npm run --silent review:reconcile -- --json
```

Allowed patch fields:

- Strings: `title`, `description`, `creatorName`.
- String arrays: `collections`, `categories`, `styles`, `colors`, `interactions`,
  `visible`, `tags`.
- An explicit empty string or array clears that field. Missing keys leave it
  unchanged.
- Unknown keys, nested objects, non-string members, unsafe lengths, and changes to
  ids, source URLs, media, notes, provenance, or `searchText` are rejected.

On index build, the pipeline applies each active accepted patch after imported and
optional enriched metadata, then rebuilds `searchText` and records
`manual-override` provenance for changed fields.

CLI contract:

```bash
npm run --silent review:list -- --status needs_review --json
npm run --silent review:resolve -- --id review-id --patch patch.json
npm run --silent review:dismiss -- --id review-id --reason "Not actionable"
npm run --silent review:reopen -- --id review-id --reason "Needs another pass"
```

HTTP contract:

```text
GET  /api/review-queue?status=needs_review&limit=20&offset=0
POST /api/review-queue/:id/resolve
POST /api/review-queue/:id/dismiss
POST /api/review-queue/:id/reopen
```

List responses omit full source records and cap `limit` at 50. Diagnostics are
independently capped at 50 entries, with at most 50 candidate record ids each;
`diagnosticsOmitted` and `candidateRecordIdsOmitted` report the deterministic
remainder. Mutation bodies are capped at 32 KiB.

### Acceptance Criteria

- Saving, editing, and deleting fixture notes produces the specified idempotent
  queue transitions without modifying unrelated entries; note-first write ordering
  is covered at every failure boundary.
- A simulated stop after the atomic note replace leaves the note saved. Startup,
  `review:reconcile`, queue read, and index build each recover the same queue entry
  and event without duplication.
- Resolve, dismiss, and reopen validate their transition and atomically replace one
  review file; a failed write preserves the previous valid file.
- Reconciliation of an edited, deleted, or restored note preserves every accepted
  patch and continues to apply it on rebuild until an explicit later resolution
  replaces it.
- Invalid or oversized patches cannot alter review state or the index.
- Rebuilding applies active patches after enrichment, updates provenance and search
  text, and leaves bookmarks, cards, clips, and notes byte-unchanged.
- Adding or removing a higher-priority duplicate for the same visual identity does
  not create a new review entry, reopen unchanged feedback, or detach its active
  accepted patch; the rebuilt item keeps the same `recordId`.
- Search reflects an accepted correction after a successful rebuild.
- An unresolved legacy note is counted with a clear reason and does not attach to
  the wrong record.
- A fixture whose base image has only a derived `mediaId`, selected card has a
  different native media id, and legacy note uses the card-derived key reconciles to
  the same `recordId` in bootstrap and persisted-index modes without changing
  normalized `mediaId`; a colliding legacy key remains ambiguous and unattached.
- Before review reconciliation or mutation can create state, Bet Three adds exact
  root ignore entries for `metadata-review.json` and `metadata-review.lock`; checks
  verify both paths with `git check-ignore` and prove neither is statically served.
- The ignored review file is never statically served; generic fixtures cover all
  statuses and patch clearing.

### No-Gos and Circuit Breaker

- No review dashboard, claiming, assignments, identities, notifications, automatic
  agent resolution, source-file rewrites, or database.
- If event history becomes larger than the appetite, keep the transition log
  minimal. Do not add a general audit framework.

## 8. Bet Four: Brief-to-Board Workflow

### Problem

Search results disappear after a query. A user or agent needs a durable local way
to preserve a brief, selected references, and curation rationale.

### Appetite

One focused week.

### Required Slice

Add local boards backed by one atomically written `boards.json`. A board references
stable catalog ids instead of copying normalized records. The brief is stored as
user input; V1 does not interpret a brief with a model or generate a query.

```json
{
  "id": "board-stable-id",
  "name": "Dark pricing references",
  "brief": "Find dark minimal pricing interfaces with motion.",
  "querySnapshot": {
    "query": "dark minimal pricing motion",
    "filters": {},
    "limit": 8
  },
  "items": [
    {
      "itemId": "visual:v1:f98442995c295466838fb3cbeafb31909d802d72c70fe408f2b150c56ba0e7d3",
      "curationNote": "Strong plan comparison hierarchy.",
      "matchReasonsAtSave": ["style: Minimal", "title: pricing"]
    }
  ],
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

### Browser-to-Catalog Resolver

The browser's current grid items are runtime bookmark/clip objects, not catalog
records, and the browser must not recreate source adapters or construct opaque
catalog ids. Bet Four adds one bounded resolver over the catalog loader's in-memory
or persisted `resolverAliases` lookup:

```text
POST /api/catalog/resolve       # request body limit: 32 KiB, at most 50 selectors
```

```json
{
  "items": [
    {
      "clientKey": "filtered-result-0",
      "sourceType": "bookmark",
      "sourceRecordId": "sample-interface-001",
      "sourceUrl": "https://example.com/reference",
      "primaryMediaId": "sample-interface-001-01",
      "primaryMediaUrl": "assets/sample-interface.svg"
    },
    {
      "clientKey": "filtered-result-without-native-id",
      "sourceType": "web-clip",
      "sourceUrl": "https://example.com/reference",
      "primaryMediaUrl": "/assets/clips/web-example-001/image.webp"
    }
  ]
}
```

Bet Four must update the browser source loaders to emit `sourceType` and, when
present, the unmodified native source record id as inert identity hints; this is new
work and is not assumed to exist in the current app. Before resolver use, those
loaders validate `canonicalUrl` and `sourceUrl` through the shared Section 4.1 URL
contract. For web clips they select a valid absolute HTTP(S) `canonicalUrl`,
otherwise a valid raw `sourceUrl`; if neither is valid, they do not submit that
runtime item to the resolver and surface it in the compact unavailable count. For
other sources they require and send the validated original source URL. The shared
validator preserves the selected display spelling and must use the same fixtures
and outcomes as the server canonicalizer; browser code does not independently
canonicalize or hash values. Loaders send image-zero media id/URL when present but
do not inspect metadata cards or implement fallback matching. In particular, a
runtime record without a native id sends its exact selected source and primary-media
URLs to the server; it never constructs a URL-hash id.

`clientKey`, a known `sourceType`, and image-zero `primaryMediaUrl` are required
non-empty strings. `sourceRecordId`, `sourceUrl`, and `primaryMediaId` are optional,
but supplied optional strings must be non-empty. Every selector must choose one of
these bounded forms:

1. Native alias: supply `sourceRecordId`; `sourceUrl` may also be supplied as an
   additional exact verification hint.
2. URL-pair fallback: omit `sourceRecordId` and supply `sourceUrl`. The exact
   canonical `(sourceUrl, primaryMediaUrl)` pair is mandatory.

`clientKey` values must be unique within the request and are capped at 80
characters. Each URL is capped at 2,048 characters and each source/media id at 256
characters before canonicalization. Invalid selector shapes, unsupported URL
forms, or a request over the existing 50-selector/32 KiB limits fail the whole
request with 400 before lookup.

For a native selector, the server first takes only alias rows with exact
`(sourceType, sourceRecordId)`, then verifies the required canonical primary-media
URL and every supplied source-URL hint. A supplied `primaryMediaId` matches any
exact value in the row's `mediaIdAliases`, not only normalized `mediaId`. Zero
initial rows is `not_found`; existing native rows with no hint-complete match return
`primary_media_mismatch` or `source_url_mismatch` as applicable. If the complete
selector leaves aliases for more than one catalog id, it returns `ambiguous`. Rows
that differ but all map to one catalog id are one resolved match.

For a URL-pair fallback, the server canonicalizes both URLs with Section 4.1's
shared server-side canonicalizer and selects only an alias row with exact
`sourceType`, canonical source key, and canonical primary-media key. A supplied
`primaryMediaId` must also match one exact `mediaIdAliases` value. No match is `not_found` or
`primary_media_mismatch` when only that supplied id differs; more than one catalog
id is `ambiguous` and is also an index-validation failure because complete
pair-derived selectors must be unique. The resolver never broadens either path to
title, source URL alone, media URL alone, DOM key, result position, or secondary
image, and never returns candidates for client-side guessing. The ordered response
has one entry per `clientKey`:

```json
{
  "ok": true,
  "items": [
    {
      "clientKey": "filtered-result-0",
      "status": "resolved",
      "catalogId": "visual:v1:f98442995c295466838fb3cbeafb31909d802d72c70fe408f2b150c56ba0e7d3"
    }
  ]
}
```

Per-item status is `resolved`, `duplicate`, `not_found`,
`primary_media_mismatch`, `source_url_mismatch`, or `ambiguous`. The server marks a
later catalog-id match as `duplicate` with `duplicateOfClientKey`; only `resolved`
entries contain `catalogId`. Mismatch and ambiguity entries expose no candidate ids.
The resolver is read-only, preserves request order, returns no neighboring records,
and is the only browser-to-catalog adapter in V1.

### Board Contract

- Create a board from an explicit ordered list of current catalog ids. Browser
  creation first resolves the bounded canonical filtered-result list through the
  resolver above and submits only successfully resolved, unique ids.
- `querySnapshot` records the search request that produced the candidates; it is
  context, not a live query that changes the board later.
- Reject missing ids and duplicate ids on create. Cap a board at 100 items, names
  at 120 characters, briefs at 4,000, and item notes at 1,000.
- Add, remove, and reorder items; edit name, brief, and curation notes.
- Preserve saved match reasons as short strings for handoff context. They are not
  recalculated when metadata changes.
- Reopen a board through local `?board=<id>` mode. Data order, lightbox navigation,
  and export follow board order even if masonry placement is spatial.
- If a referenced item later disappears, retain its id, omit it from the masonry,
  show an unavailable count in the board header, and include an unavailable marker
  in export. Never silently remove it.
- Export one resolved board as bounded JSON or concise Markdown. Markdown includes
  name, brief, item title, curation or saved match reason, and source URL.
- Board text is rendered as text, not injected HTML. Export is explicit and local;
  no background sharing or upload occurs.

#### Board Mutation Lock and Atomic Writes

Every board read-modify-write path uses one shared server/CLI storage module and the
independent ignored `boards.lock`. It uses the same lock helper, 60-second stale
threshold, and busy semantics as metadata review, but it never reuses or nests
`metadata-review.lock`. This includes create, edit, add, remove, reorder, and delete
through either CLI or API. Browser mutations reach the same module through the API.

The lock and write contract is:

1. Acquire `boards.lock` with exclusive-create semantics before reading the current
   board state. The bounded lock record contains a schema version, process id,
   creation time, and unpredictable ownership token. No mutation reads
   `boards.json` before it owns the lock.
2. An existing well-formed lock is busy unless it is older than 60 seconds and its
   recorded process is no longer running. A malformed or incomplete lock is
   recoverable only after its filesystem modification time is older than 60
   seconds. Stale recovery compares the ownership token and filesystem identity and
   must not remove a replacement lock; if that comparison cannot be guaranteed, it
   fails busy. Acquisition performs at most one stale-recovery attempt and one
   reacquire attempt, with no unbounded polling. Busy is `boards_busy`, HTTP 503, or
   a non-zero CLI exit, and leaves `boards.json` untouched.
3. After acquisition, read and validate the complete current `boards.json` (or the
   defined empty initial state), apply exactly one mutation in memory, and validate
   the complete next payload. Write it to a unique adjacent temporary file, flush
   and close that file, atomically replace `boards.json`, and complete any supported
   parent-directory durability sync before reporting success. A failure before the
   replace preserves the old file; a failure after the replace may report failure
   but readers still see the complete new file.
4. Release in `finally` only when the on-disk ownership token still matches the
   holder, then remove any holder-owned temporary file. A process must never remove
   another process's lock. Lock files and temporary files are never served.

Board list, detail, and export reads may remain lock-free because the only published
write is an atomic replacement. Each read validates one complete payload and
therefore observes either the complete old file or the complete new file, never a
partial mix. A read that encounters an invalid file fails clearly rather than
falling back to empty state.

CLI contract:

```bash
npm run board:create -- --name "Dark pricing" --brief "..." --items ids.json
npm run board:export -- --id board-id --format markdown
```

HTTP contract:

```text
GET    /api/boards?limit=20&offset=0
POST   /api/boards
GET    /api/boards/:id
PATCH  /api/boards/:id
DELETE /api/boards/:id
```

`GET /api/boards` returns bounded summaries and does not expand catalog records.
`GET /api/boards/:id` and `board:export` call one shared board resolver against the
current catalog. The detail response contains the exact stored board plus one
ordered resolved entry for every stored item:

```json
{
  "ok": true,
  "board": {
    "id": "board-stable-id",
    "name": "Dark pricing references",
    "brief": "Find dark minimal pricing interfaces with motion.",
    "querySnapshot": {},
    "items": [
      {
        "itemId": "visual:v1:f98442995c295466838fb3cbeafb31909d802d72c70fe408f2b150c56ba0e7d3",
        "curationNote": "Strong plan comparison hierarchy.",
        "matchReasonsAtSave": ["style: Minimal", "title: pricing"]
      }
    ],
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-01T00:00:00.000Z"
  },
  "resolvedItems": [
    {
      "itemId": "visual:v1:f98442995c295466838fb3cbeafb31909d802d72c70fe408f2b150c56ba0e7d3",
      "status": "available",
      "item": {
        "id": "visual:v1:f98442995c295466838fb3cbeafb31909d802d72c70fe408f2b150c56ba0e7d3",
        "title": "Compact pricing interface",
        "sourceUrl": "https://example.com/reference"
      },
      "curationNote": "Strong plan comparison hierarchy.",
      "matchReasonsAtSave": ["style: Minimal", "title: pricing"]
    }
  ]
}
```

`status` is `available` with exactly one current normalized record in `item`, or
`unavailable` with `item: null`. Board mode, lightbox navigation, JSON export, and
Markdown export consume this ordered resolved array; they do not reload raw source
files or reimplement catalog matching. Create/add reject ids unavailable in the
current catalog, while reorder/remove continue to accept already stored unavailable
ids so a board can be repaired without losing them.

The example abbreviates `item`; on the wire an available `item` contains the full
normalized record from Section 4.1, while the top-level `resolverAliases` lookup is
never included.

This PR may extend the existing CORS method allowlist to `PATCH` and `DELETE` only
for these origin-checked routes. Mutation bodies are capped at 64 KiB. Deletes are
explicit and return 404 for an unknown id.

Required browser slice:

- A board command in the existing search surface opens a keyboard-operable dialog
  for name, brief, and selection. To bound the UI, take at most the first 50 unique
  items from the canonical filtered-result order before masonry tiling, resolve
  them once, show resolved items as checkboxes, and show one compact unavailable
  count for failures. There is no pagination or second search inside the dialog.
- Board mode adds an unframed header with name, available/unavailable counts, edit,
  export/copy, and close/back controls without covering the search bar or filters.
- Each board item has accessible move-earlier, move-later, and remove commands;
  drag-and-drop is optional.
- Name/brief use one small edit dialog; curation-note editing lives in the existing
  item lightbox. V1 has no standalone board library, board thumbnails, bulk editor,
  templates, duplication flow, or alternate presentation layout.
- Copy/export and save actions announce success or failure in an accessible live
  region and restore focus when dialogs close.

### Acceptance Criteria

- Through CLI/API, a fixture brief can be searched, selected, saved, reopened,
  reordered, edited, exported, and deleted.
- Through the browser, current filtered results can create a board; reload and the
  local board URL preserve board mode and item order.
- Browser-loader fixtures prove Bet Four emits `sourceType`, preserves native ids,
  and applies the shared absolute-URL validation contract before resolver use. They
  cover valid `canonicalUrl`, fallback to valid raw `sourceUrl`, both values
  invalid, and non-web source URLs without claiming this behavior exists before the
  feature. Client and server fixtures must agree on every selection/rejection.
- Resolver fixtures cover bookmarks, web clips, image-zero media aliases,
  native-id and URL-pair fallback selectors, native-alias ambiguity, source/media
  mismatches, multi-image mismatches, missing records, duplicate runtime results,
  and the 50-selector/body limits without client-side id construction or hashing.
- The no-native-id web-clip resolver fixture uses the exact absolute HTTP(S)
  selected `sourceUrl` (`https://example.com/reference`, preferred over the
  differing raw capture URL) and root-relative
  `/assets/clips/web-example-001/image.webp` `primaryMediaUrl` from Section 4.1.
  Its URL-pair selector resolves the bootstrap alias and the persisted-index alias
  to the same catalog id. A second selector using repository-relative
  `assets/clips/web-example-001/image.webp` resolves that same id; the raw capture
  URL does not. The protocol-relative, single/double/deeper-encoded traversal,
  encoded slash/backslash, control, NUL, malformed-escape, decode-depth, non-asset-
  root, and logical-root-escape cases listed in Section 4.1 fail request validation
  before lookup.
- One rebuild acceptance test starts with a lower-priority candidate, accepts a
  review patch, and stores its id on a board. It adds a higher-priority duplicate
  with the same canonical source/primary-media pair, rebuilds, removes that
  duplicate, and rebuilds again. After both rebuilds the catalog id is unchanged,
  the accepted patch still applies, and the board item remains `available`. After
  addition, both the new native selector and the original no-native-id exact
  URL-pair selector resolve to the stored id; after removal, the URL-pair selector
  still resolves it and the removed native alias is correctly `not_found`. No
  redirects or hidden history participate.
- Concurrent process tests start CLI and server mutations against the same fixture.
  Exactly one holder mutates under `boards.lock`; a contender either acquires after
  release using a freshly read file or fails `boards_busy`, and no successful
  mutation is lost. Fresh/live locks remain busy, dead-process locks older than 60
  seconds recover once, malformed fresh locks remain busy, and stale malformed
  locks follow the bounded recovery path without deleting a replacement lock.
- Failure-boundary tests cover validation, temporary write/flush, atomic replace,
  durability sync, and release. Lock-free readers loop during replacement and see
  only schema-valid old or new complete files. Board writes never modify the
  catalog or source files.
- Before any board path can create local state, Bet Four adds exact root ignore
  entries for `boards.json` and `boards.lock`; checks verify both with
  `git check-ignore` and prove the board, lock, and temporary files are not served.
- Missing catalog items remain in board data and appear as unavailable in header
  status, resolved detail responses, and exports.
- API pagination, limits, origin policy, method handling, and body limits have
  focused tests.
- Keyboard-only creation, editing, reordering, export, and exit work with sample
  data at desktop and compact widths.

### No-Gos and Circuit Breaker

- No public URLs, cloud sync, collaboration, model-generated curation, deck export,
  required drag-and-drop, or general board-management screen.
- If result-selection UI exceeds the appetite, keep the bounded checkbox dialog and
  omit decorative board management and optional drag-and-drop. The shared resolver,
  CLI/API creation, resolved board detail, board mode, accessible order controls,
  curation-note editing, and export remain required for this PR to ship.

### Implementation Notes

The shipped slice uses one browser-loadable URL contract shared with server-side
canonicalization, a bounded catalog resolver, and independent `boards.json` / token
owned `boards.lock` state. Board and metadata-review writers use the same bounded
local-state lock helper with separate paths and domain-specific busy errors. The
browser resolves only its first 50 canonical filtered results, preserves bounded
search/filter reasons on selected items, and sends only resolved ids to the board
API. Board detail, lightbox navigation, order controls, and exports consume the
server-resolved ordered entries; they do not reread raw source files.

## 9. Bet Five: Automated Browser and Extension Quality Gate

### Problem

Current unit and smoke checks protect data and server contracts, but browser focus,
layout, timing, and real extension loading can still regress without an automated
signal.

### Appetite

Two to three focused days.

### Required Slice

Add Playwright as a development-only dependency, one Chromium app suite, and one
unpacked-extension suite. Run them after the existing fast checks in CI. Tests use
only committed fixtures and isolated temporary paths for clips, notes, review state,
boards, and indexes.

Commands:

```bash
npm run check:e2e
npm run check:e2e:extension
npm run check:all
```

`npm run check` remains the fast unit/data/server/extension gate.
`npm run check:all` runs it before both browser suites.

### Required App Scenarios

1. The app loads sample data with nonblank grid content and no uncaught page error
   or unexpected console error.
2. Rapid Interface then Branding selection settles on Branding results, protecting
   the existing filter-transition race.
3. Browser search matches fixture metadata and a fixture manual note.
4. Reduced-motion mode applies filters without the delayed fade path.
5. The Add URL modal fits a 390 by 844 viewport, traps focus, restores focus on
   Escape, and clips a local fixture page into a temporary directory.
6. The lightbox opens by keyboard, exposes metadata and source, traps focus,
   navigates, and restores inert state and prior focus.
7. A board can be created from filtered sample results, reopened after reload,
   reordered, exported, and exited.

Run layout assertions at 1280 by 800 and 390 by 844. Assert key control bounding
boxes stay inside the viewport and do not intersect the search surface, filters,
modal actions, or board header. Screenshots support failure diagnosis; V1 does not
use pixel-perfect snapshot approval.

### Required Extension Scenarios

- Launch a fresh persistent Chromium context with the repository extension loaded
  unpacked and all other extensions disabled.
- Assert the real manifest, service worker, popup HTML, and shared clipper module
  load without errors.
- Point the extension at an isolated loopback fixture server with its generated
  extension origin explicitly allowed.
- Save a local fixture page through the popup and verify both the success state and
  temporary server record.
- Exercise the image context-menu handler against a local fixture image. If native
  menu automation is unavailable, use a fixture event harness around the exported
  handler and retain one documented manual native-menu check.
- A broken worker or shared-module import must fail the suite.

### CI and Acceptance Criteria

- Run `npm run check` first, then app and extension suites on pull requests to the
  repository's default branch.
- Use one supported Chromium version and viewport matrix only; no cross-browser or
  operating-system matrix.
- Use a headed virtual display in CI if unpacked Manifest V3 extension support is
  unreliable in headless mode.
- Keep test execution, excluding dependency and browser installation, under three
  minutes on CI.
- Upload failure-only screenshots and traces as CI artifacts with normal retention;
  never commit them.
- Expected console warnings are explicitly allowlisted by message and scenario.
  Any other page error, worker error, or console error fails the run.
- Local and CI documentation names install commands, test commands, fixture
  isolation, artifact locations, and the one manual check if the context-menu
  circuit breaker is used.
- Desktop and compact runs assert nonblank content, text fit, focus behavior, and
  the specific overlap boundaries above.

### No-Gos and Circuit Breaker

- No private data, real browser profile, external website, visual snapshot approval
  system, broad browser matrix, or flaky retry-as-success policy.
- Native context-menu automation alone cannot block the quality gate. The real
  unpacked popup and service worker remain mandatory; only the menu invocation may
  fall back to the handler harness plus a documented manual check.

## 10. Delivery Sequence and PR Boundaries

The original delivery plan called for each bet to ship from a fresh branch as one
independently reviewed pull request:

```text
PR 1: Read-only catalog loader + search core + CLI/API
  -> PR 2: Full index builder + deterministic/optional enrichment
    -> PR 3: Review state + accepted overrides + note intake integration
      -> PR 4: Board storage + CLI/API + bounded browser workflow
        -> PR 5: App and unpacked-extension browser quality gates
```

Independence rules:

- PR One works without an index. PR Two does not require review data. PR Three has
  no review dashboard. PR Four does not require model-generated curation. PR Five
  adds tests, not missing product behavior.
- Start each branch from the merged preceding PR and do not pull later-bet behavior
  forward merely for convenience.
- A later PR may extend shared modules while preserving all earlier CLI, API, file,
  and fallback contracts.
- Each PR documents schema changes and rollback. Deleting only the generated index
  must restore read-only fallback; deleting user-owned review or board files is not
  presented as a routine rollback because it loses local work.
- A separate agent reviews each PR. Blocking findings require a separate fix pass,
  rerun checks, and another independent review before merge.

## 11. Success Measures

The roadmap's completion criteria were that a fresh public clone could:

1. answer ten structured inspiration queries through CLI and API with traceable,
   explained results before any index exists;
2. build a deterministic index in which every supported local source uses the same
   normalized shape;
3. turn a sample manual note into an accepted correction that survives rebuilds and
   changes later search results;
4. turn an explicit search selection into a durable, ordered, exportable board; and
5. pass automated app and real unpacked-extension browser gates.

Commands and tests report indexed count, per-source coverage, skipped/failure and
dedupe counts, unresolved review count, search totals and reasons, board available
and unavailable counts, and end-to-end duration and failures.

## 12. Privacy and Release Checklist

Before every merge:

- Confirm all generated and user-owned files are ignored and absent from the commit.
- Confirm no new raw-data file is reachable through the static allowlist.
- Search the committed tree for local paths, personal identifiers, tokens, cookies,
  raw exports, generated media, browser profiles, and screenshots.
- Run checks from a clean archive without ignored local files.
- Verify APIs remain loopback-first, origin-restricted, bounded, and no-store.
- Verify fixtures use `example.com` or local fixture servers only.
- Verify search and the default built-in index build make no network requests.
- Verify external enrichment is inert without both configuration and per-run opt-in,
  is outside the offline release gate, and documents the fields disclosed when it
  is enabled.
- Include residual risks and any manual extension check in the PR story.

## 13. Remaining Product Decisions

These decisions were intentionally deferred and did not block the five V1 PRs:

- Whether a later version should index every visual in multi-image source items.
- Whether semantic ranking earns its privacy, dependency, and maintenance cost after
  lexical-search usage is measured.
- Whether the review queue eventually needs a browser dashboard.
- Whether boards later need shareable redacted exports or presentation formats.
- Whether native context-menu automation becomes reliable enough to remove the one
  allowed manual extension check.

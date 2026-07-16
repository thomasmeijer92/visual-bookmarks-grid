# Unified Index Pipeline

The unified pipeline turns every supported local source into one validated, source-agnostic catalog. Its default mode is offline and read-only toward inputs. It never syncs an upstream source, changes bookmarks, rewrites clips or notes, or makes a network request.

## Commands

```bash
npm run index:build
npm run index:check
npm run --silent index:build -- --json
npm run --silent index:check -- --json
```

`index:build` reads local bookmarks and metadata cards when present, otherwise their committed sample fallbacks. It also joins local web clips and manual notes when present. Before publishing, it reconciles the ignored metadata review queue and applies every active accepted patch after optional enrichment. Every run rebuilds the complete catalog; there is no source-selective write.

The output is the ignored root file `inspiration-index.json`. A successful build validates the complete document, writes a unique adjacent temporary file, flushes and closes it, and atomically renames it over the previous index. `index:check` reads and validates without modifying the file. Human output summarizes source counts, normalization, enrichment, skipped reasons, deduplication, failures, and written items. `--json` writes one JSON value to stdout; use npm's `--silent` flag as shown to suppress npm's own command banner.

## Schema

The persisted document contains only:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "items": [],
  "resolverAliases": []
}
```

Items use the normalized catalog shape in the [product roadmap](top-five-product-roadmap.md). Validation checks the schema version and timestamp; bounded fields and arrays; sorted unique item ids; required source and primary-media URLs; canonical URL-pair agreement with each visual id; URL-derived media ids; deterministic `searchText`; generated provenance and single-note state; resolver row and nested-alias ordering; generator-valid resolver aliases; one presentation-owner resolver row with exact source and media presentation URLs per item; catalog references; and complete selector uniqueness. The `media-url:v1:<64-hex>` namespace is reserved for canonical-media derivation, so matching native source values normalize to the deterministic URL-derived fallback rather than being retained as aliases. It also reports counts of ambiguous native ids, media aliases, and legacy note aliases. The validator computes a deterministic content fingerprint over `items` and `resolverAliases`; `generatedAt` is excluded.

Search CLI, search API, and item lookup prefer this file when it exists and validates. If it is absent, they use the read-only bootstrap catalog. A present invalid index is an error and never falls back to potentially stale or sample results. Persisted resolver aliases are consumed as written and are not reconstructed from items.

## Metadata Review Recovery

`metadata-review.json` is an ignored local materialized queue for manual-note intake. It is paired with the ignored, never-served `metadata-review.lock` owner directory. Atomic note, review, index, and web-clip writes leave adjacent `*.tmp-*` crash artifacts; web clips use `web-clips.json.tmp-<pid>-<timestamp>-<random>` and reserve each candidate with exclusive creation before rename. Lock installation and stale recovery use `metadata-review.lock.tmp-*` and `metadata-review.lock.stale-*` directories containing owner records. These root-only private-state forms are ignored and are denied by the static server, including symlink and hardlink aliases. The lock stores an unpredictable owner token; release removes only that owner's record, while stale recovery atomically claims the prior directory into a token-named tombstone before installing a replacement. A lock older than 60 seconds is recovered only when its recorded process is no longer running. A busy or invalid queue fails rather than publishing an index from stale review state.

```bash
npm run --silent review:list -- --status needs_review --json
npm run --silent review:resolve -- --id review-id --patch patch.json
npm run --silent review:dismiss -- --id review-id --reason "Not actionable"
npm run --silent review:reopen -- --id review-id --reason "Needs another pass"
npm run --silent review:reconcile -- --json
```

Queue entries use a deterministic `review:v1:<sha256>` id over the normalized catalog record id. A note mutation writes `manual-media-notes.json` first and then reconciles the queue. If the second atomic replace fails, the note remains saved and the next startup, queue read, queue mutation, explicit reconciliation, or index build recovers it. Accepted patches allow only `title`, `description`, `creatorName`, `collections`, `categories`, `styles`, `colors`, `interactions`, `visible`, and `tags`; explicit empty strings and arrays clear a field. Active patches remain in force after reopened feedback until a later resolution replaces them. Review-list responses independently return at most 50 diagnostics and at most 50 `candidateRecordIds` per diagnostic; `diagnosticsOmitted` and each `candidateRecordIdsOmitted` state the deterministic remainder.

Each entry retains at most 1,000 events. When the next durable transition would exceed that limit, reconciliation deterministically replaces only the oldest redundant history with a legal ordered replay witness while preserving the newest possible suffix. Current status, source presence, accepted patch, source fingerprint, and the current note linkage are unchanged; older individual audit rows may therefore be compacted.

The index applies accepted patches after imported and optional external metadata, annotates changed fields with `manual-override`, and derives `searchText` again. It never rewrites bookmarks, cards, clips, or notes. Removing `metadata-review.json` permanently discards accepted corrections and review history; restore a backup rather than treating deletion as a rollback.

## External Enrichment

External enrichment is inert unless both options are present on the same invocation:

```bash
npm run index:build -- \
  --enricher ./local-enricher.mjs \
  --allow-external-enrichment
```

The repository bundles no provider, SDK, discovery mechanism, saved opt-in, or environment-based activation. Supplying only one option fails before module import.

The configured module exports:

```js
export async function enrich(record, { signal }) {
  return {
    patch: { visible: ["Three pricing cards"] },
    provenance: { visible: "configured-enricher" }
  };
}
```

The enrichment payload contains only:

- the opaque catalog `id`
- title and description
- categories, styles, colors, interactions, visible values, and tags
- bounded primary-media type and dimensions

A primary-media URL is included only when it uses HTTP(S), has no query, fragment, or user info, and its domain passes the syntactic local/internal and IANA special-use policy. The check does not perform DNS resolution.

The URL is omitted for:

- every IPv4 or IPv6 literal, including public, private, reserved, and special-purpose addresses
- hostnames with repeated terminal dots or any other empty DNS label
- signed or credential-bearing query URLs
- local or internal hostnames
- exact names and subdomains of `alt`, `localhost`, `invalid`, `test`, `example`, `example.com`, `example.net`, `example.org`, `onion`, and `local`
- ARPA zones `6tisch.arpa`, `eap.arpa`, `eap-noob.arpa`, `home.arpa`, `in-addr.arpa`, `ip6.arpa`, `ipv4only.arpa`, `resolver.arpa`, and `service.arpa`
- legacy local suffixes `localdomain`, `internal`, `home`, and `lan`
- local media paths and every non-HTTP(S) URL form

A hostname may have one terminal DNS root dot. Name matching is exact or uses a dot-label suffix, so public names that merely contain a blocked string still pass.

Notes, collections, `searchText`, provenance, resolver aliases, source and creator fields, credentials, local paths, and raw source responses never enter the payload.

Those documented payload fields may leave the machine if the configured module sends them to a network service. The module itself is trusted local code and can access capabilities available to the Node process, so review it before opting in.

Patches can fill only missing `title`, `description`, `categories`, `styles`, `colors`, `interactions`, `visible`, and `tags`. They cannot overwrite non-empty values or change collections, identities, source, media, creator, or notes. Patch fields, values, and provenance are strictly bounded; external provenance labels cannot impersonate built-in `bookmark`, `web-clip`, `metadata-card`, `manual-note`, or the review-only `manual-override` origin. Each record receives a 30-second `AbortSignal` deadline.

All patches remain in memory until every record succeeds. A complete success publishes one enriched index. Any throw, timeout, invalid patch, or module-load failure discards all external patches, atomically publishes the validated offline-base index, reports only bounded opaque ids and stable reason codes, and exits non-zero. Provider messages, prompts, responses, and record content are not logged or persisted.

## Recovery And Performance

Invalid inputs and pre-write validation failures leave the previous valid index untouched. An interrupted temp write or rename also leaves it in place and cleans up only that run's unique temp file. After an external failure, the published offline base intentionally replaces any older external fields so stale and fresh enrichment cannot mix.

To roll back the generated state, remove `inspiration-index.json`; search immediately returns to bootstrap sources. To roll back the feature code, remove the index scripts and catalog index modules, restore bootstrap loading in `tools/search.mjs` and `server.js`, and remove the package scripts and this document.

V1 uses Node built-ins and holds normalized inputs, staged patches, the validated index, and serialized JSON in memory. Validation is linear in catalog and resolver size apart from deterministic sorting performed by the adapters. External calls use bounded concurrency of four, but a large or slow provider run can still take substantial time; there is no incremental or source-selective build.

# Visual Bookmarks Grid

Visual Bookmarks Grid keeps visual references in one local, searchable canvas. Browse them in the grid, query the same catalog from an agent, and save pages or exact images with the Chrome extension.

The repository is intentionally clean: no personal bookmarks, no private media, no local machine paths, and no account tokens. It runs with sample data immediately after cloning.

## Features

- Infinite pannable masonry grid with recycled DOM nodes.
- Frosted filter chips with stable design categories and counts.
- Bottom search across bookmark text, authors, tags, metadata, and manual notes.
- Read-only agent search through a deterministic CLI and loopback JSON API.
- Offline unified index builds with strict validation and atomic publication.
- Local metadata review intake with durable accepted corrections and CLI/API transitions.
- Brief-to-board workflow with bounded browser selection, ordered local references, curation notes, and Markdown or JSON export.
- Lightbox with source link, metadata, visible-content summary, notes, stats, and keyboard navigation.
- Local `POST /api/clips` web clipper that stores clipped pages/images in ignored local files.
- Chrome extension popup and right-click image save flow.
- Sample bookmarks and sample metadata so first run works without private data.
- Smoke tests for data shape, static server protection, clipper API, manual notes, and extension files.

## Requirements

- Node.js 20 or newer.
- Chrome or Chromium if you want to use the extension.

## Quick Start

```bash
npm install
npm start
```

Open `http://127.0.0.1:3000`.

On a fresh clone the app uses:

- `bookmarks-data.sample.json`
- `media-cards.sample.json`

When you add your own local data, create these ignored files:

- `bookmarks-data.json`
- `media-cards-clean.json` if you want richer metadata filters

## Public Demo

Build the sample-only, read-only static demo with:

```bash
npm run demo:build
```

The generated `dist/` artifact contains only committed sample data and the browser runtime needed for GitHub Pages. Search, filters, canvas navigation, and the metadata lightbox remain interactive. Controls and requests that write clips, notes, reviews, or boards are disabled, and the demo does not call local JSON APIs.

The Pages workflow deploys this exact artifact from `main`. Use `npm start` for the full local product and its write features. Do not expose the unauthenticated local Node server as a shared public service.

## Add Your Own Data

The app is source-agnostic. Write or export data into `bookmarks-data.json` using the documented shape:

- [Data format](docs/data-format.md)
- [Remix guide](docs/remix-guide.md)

Personal exports should stay local. The `.gitignore` already excludes generated bookmark data, clip data, local notes, media indexes, screenshots, logs, and environment files.

## Web Clipper

The local server exposes:

```text
GET  /api/clips
POST /api/clips
```

The extension and in-app "Save URL" button use that API. Saved clips are written to ignored local files:

- `web-clips.json`
- `assets/clips/`

See [Chrome extension setup](docs/chrome-extension.md).

The API accepts same-server localhost requests by default. Chrome extension origins and any additional web origins must be explicitly allowed through the environment variables documented in `.env.example`.

## Agent Search

Search works immediately with the committed sample data. Build the ignored local index when you want a persisted catalog:

```bash
npm run index:build
npm run index:check
```

Search prefers a present valid index and otherwise uses the read-only bootstrap sources:

```bash
npm run search -- --query "dark minimal" --style Minimal --limit 8
npm run --silent search -- --query "workspace" --json
node tools/search.mjs --query "workspace" --json
```

Facet flags are repeatable: `--category`, `--style`, `--color`, `--interaction`, `--source`, and `--media-type`. Use `--offset` with `--limit` for pagination. For machine-readable npm output, include `--silent` as shown above. JSON mode writes one JSON value to stdout and keeps catalog diagnostics on stderr.

The local server also exposes bounded search and item lookup:

```text
POST /api/search
GET  /api/items/:id
```

See [Agent search](docs/agent-search.md) for request/response examples and [Unified index pipeline](docs/index-pipeline.md) for schema, enrichment privacy, atomic rollback, and performance behavior.

## Metadata Review

Saving a non-empty lightbox note creates local review intake. The queue stays out of the browser UI in V1 and can be managed through the loopback API or these commands:

```bash
npm run --silent review:list -- --status needs_review --json
npm run --silent review:resolve -- --id review-id --patch patch.json
npm run --silent review:dismiss -- --id review-id --reason "Not actionable"
npm run --silent review:reopen -- --id review-id --reason "Needs another pass"
npm run --silent review:reconcile -- --json
```

`metadata-review.json` stores queue state, event history, and accepted patches. Writes use the ignored `metadata-review.lock`, and neither file is served by the app.

Each successful index build reconciles notes, applies active accepted patches after optional enrichment, records `manual-override` provenance, and rebuilds searchable text.

Deleting `metadata-review.json` permanently discards accepted corrections and review history. Treat that as data loss, not a routine rollback.

```text
GET  /api/review-queue?status=needs_review&limit=20&offset=0
POST /api/review-queue/:id/resolve
POST /api/review-queue/:id/dismiss
POST /api/review-queue/:id/reopen
```

## Boards

Create a board from the current browser filters with the square-plus button. The dialog resolves at most the first 50 filtered grid items through the local catalog; it never creates catalog ids or hashes in the browser. A board URL uses `?board=<id>` and preserves stored item order after reload. Missing catalog references remain on the board as unavailable entries until you remove or reorder them.

Boards are local, ignored user state:

- `boards.json` contains the complete board document.
- `boards.lock` is a short-lived, token-owned writer lock directory.

Use the CLI for local-agent or script workflows:

```bash
npm run --silent board:create -- --name "Pricing references" --brief "Dark, compact pricing interfaces" --items ids.json
npm run --silent board:list -- --json
npm run --silent board:show -- --id board-id --json
npm run --silent board:reorder -- --id board-id --items ids.json
npm run --silent board:export -- --id board-id --format markdown
```

`ids.json` may be an array of catalog ids or an object with an `items` array. The detailed command reference, API routes, lock behavior, and rollback note live in [Boards](docs/boards.md). Deleting `boards.json` permanently removes boards; it is data loss, not a normal rollback.

## Project Layout

- `app.js` and `style.css` contain the grid experience.
- `server.js` serves the app and coordinates the local JSON APIs.
- `lib/clip-metadata.js` owns URL normalization, page metadata extraction, and image helpers.
- `lib/catalog/` and `lib/search.js` own normalized read-only catalog and lexical search contracts.
- `chrome-extension/clipper-client.mjs` and `image-context-menu.mjs` are shared extension modules.
- `test/` contains fast unit tests; `tools/` contains data, server, and extension checks.
- [Product roadmap PRD](docs/top-five-product-roadmap.md) records the five V1 bets included in this snapshot.

## Checks

```bash
npm run check
npm run demo:build
```

This runs:

- `npm run check:unit`
- `npm run check:data`
- `npm run check:server`
- `npm run check:extension`

Run the focused catalog and search contract suite with:

```bash
npm run check:search
npm run check:index
npm run check:boards
npm run check:locks
```

## Browser Quality Gate

Install Chromium once with `npx playwright install chromium`, then run
`npm run check:e2e`, `npm run check:e2e:demo`, `npm run check:e2e:extension`,
or `npm run check:all`.
See [Browser quality gate](docs/browser-quality-gate.md) for fixture isolation,
headed extension execution, failure artifacts, and the context-menu manual check.

## Repository Hygiene

Before publishing a remix, run through:

- [Public release checklist](docs/public-release-checklist.md)

Keep these out of Git:

- real bookmark exports
- generated media indexes
- clipped media files
- local notes
- `.env` / `.env.local`
- browser cookies, profiles, or tokens
- Playwright/browser screenshots from private data

## License

MIT. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).

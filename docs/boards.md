# Boards

Boards are private, local reference sets. They store a brief, an immutable query
snapshot, ordered catalog ids, curation notes, and saved match reasons. They never
copy source files or normalized catalog records into board state.

## Local State

`boards.json` is ignored user-owned state. Its adjacent `boards.lock` is an ignored
single-writer lock directory that holds one token-owned owner record. All board
mutations acquire that lock, validate the whole current document, write a unique
adjacent temporary file, flush it, atomically replace `boards.json`, and then sync
the parent directory where supported.

Board and metadata-review writers share this lock implementation but always use
independent lock paths and retain their own bounded error codes.

Readers are lock-free and validate one complete document. They observe either the
old complete document or the new complete document. A lock older than 60 seconds is
recovered only once when its recorded process is no longer running; a fresh or
unverifiable lock returns `boards_busy`.

Do not delete `boards.json` as routine cleanup. It permanently discards local board
work. Deleting `inspiration-index.json` only restores the read-only catalog fallback;
it does not affect boards.

## API

All endpoints are loopback-oriented, origin-checked, no-store JSON routes. Mutation
bodies are capped at 64 KiB; catalog resolution is capped at 32 KiB and 50 selectors.

```text
POST   /api/catalog/resolve
GET    /api/boards?limit=20&offset=0
POST   /api/boards
GET    /api/boards/:id
PATCH  /api/boards/:id
DELETE /api/boards/:id
GET    /api/boards/:id/export?format=markdown
```

The resolver accepts only native source aliases or complete source/media URL pairs.
It returns ordered per-client statuses and never returns alias rows or nearby
candidate ids. Board detail resolves each stored id against the current catalog in
order. An absent record remains stored and returns `unavailable` with `item: null`.

`PATCH /api/boards/:id` edits `name`, `brief`, or `querySnapshot`; action bodies add,
remove, reorder, or update one curation note. Create and add reject unavailable or
duplicate catalog ids. Remove and reorder still work for unavailable stored items.

## CLI

```bash
npm run --silent board:create -- --name "Reference board" --brief "Short brief" --items ids.json
npm run --silent board:list -- --limit 20 --offset 0 --json
npm run --silent board:show -- --id board-id --json
npm run --silent board:update -- --id board-id --name "New name"
npm run --silent board:add -- --id board-id --item catalog-id --note "Why it belongs"
npm run --silent board:remove -- --id board-id --item catalog-id
npm run --silent board:reorder -- --id board-id --items ids.json
npm run --silent board:note -- --id board-id --item catalog-id --note "Curation note"
npm run --silent board:export -- --id board-id --format markdown
npm run --silent board:delete -- --id board-id
```

Use `--json` when another program reads stdout. Diagnostics and failures go to
stderr. All fixtures and example URLs remain generic.

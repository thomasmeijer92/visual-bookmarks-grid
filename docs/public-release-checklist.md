# Public Release Checklist

Run this before publishing or merging a public starter branch.

## Data And Secrets

- No `bookmarks-data.json`, `folders-data.json`, `media-cards-clean.json`, `web-clips.json`, `manual-media-notes.json`, or `inspiration-index.json` committed.
- No `assets/clips/` committed.
- No `.env`, `.env.local`, browser cookies, local profiles, auth tokens, or API keys committed.
- No private screenshots, Playwright traces, logs, or local output folders committed.
- Sample data uses local assets and `example.com` links only.

## Local Paths

- No absolute local machine paths.
- No machine-specific launch agents or absolute working directories.
- No personal names, handles, or private repo references.

## Product Quality

- `npm install`
- `npm run check`
- `npm run demo:build`
- `npm run check:e2e:demo`
- Start the app and verify sample data renders.
- Open the lightbox and check source links, metadata rows, tags, search, and filters.
- Save a URL through the in-app clipper and confirm it appears in the grid.
- Install the extension locally and confirm popup and right-click image flows still point to the local server.

## Hosted Demo

- Deploy the generated `dist/` artifact, not the writable local Node server.
- Confirm the hosted demo uses committed sample data only.
- Confirm clip, board, and manual-note write controls are absent.
- Confirm no `/api/` requests are made during load, search, filtering, or lightbox use.
- Verify the project-subpath URL on desktop and a compact mobile viewport.

## Documentation

- README explains quick start, data files, checks, clipper, and privacy expectations.
- Data format docs are current.
- Extension docs are current.
- License and third-party notices are present.

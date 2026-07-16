# Remix Guide

## Good First Remixes

- Replace `bookmarks-data.sample.json` and `media-cards.sample.json` with your own local ignored data.
- Change the visual system in `style.css`.
- Adjust masonry density in `CONFIG` inside `app.js`.
- Add or rename filter chips in `FILTER_OPTIONS`.
- Add an importer that writes `bookmarks-data.json`.
- Customize the Chrome extension name and default server URL.

## Keep Local

Do not commit:

- `bookmarks-data.json`
- `folders-data.json`
- `media-cards-clean.json`
- `media-cards.json`
- `media-metadata.json`
- `media-vision-index.json`
- `manual-media-notes.json`
- `web-clips.json`
- `assets/clips/`
- `.env` or `.env.local`
- browser cookies, profiles, tokens, or screenshots from private data

## Suggested Data Flow

```text
Your source export
  -> your importer
  -> bookmarks-data.json
  -> optional media-cards-clean.json
  -> server.js + lib/clip-metadata.js
  -> app.js
```

The starter does not require a specific source service. Anything that can write the documented JSON shape can power the grid.

## Public Demos

Use sample data or intentionally public data only. Real bookmark exports can contain private folders, source links, account details, and media URLs.

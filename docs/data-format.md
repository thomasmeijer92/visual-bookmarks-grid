# Data Format

The viewer loads `bookmarks-data.json` when it exists. If it is missing, the server and app fall back to `bookmarks-data.sample.json`.

Metadata cards are optional. The viewer loads `media-cards-clean.json` when it exists and falls back to `media-cards.sample.json`.

The agent search catalog derives one record for image zero of each visible bookmark. It never rewrites these source files. Local `web-clips.json` and `manual-media-notes.json` are joined only when present; a clean clone uses the two committed sample files above.

`npm run index:build` persists that normalized catalog to ignored `inspiration-index.json`. Search prefers the file when it is present and valid, and falls back to the source adapters only when it is absent. See [Unified index pipeline](index-pipeline.md) for the strict schema and validation rules.

## Top Level

```json
{
  "folders": [],
  "bookmarks": []
}
```

## Folder

```json
{
  "id": "interface",
  "name": "Interface"
}
```

## Bookmark

Required fields for a visible grid item:

```json
{
  "id": "bookmark-id",
  "text": "Short searchable description",
  "url": "https://example.com/source",
  "authorHandle": "example",
  "authorName": "Example Creator",
  "postedAt": "2026-01-01T12:00:00.000Z",
  "images": [
    {
      "url": "https://example.com/image.jpg",
      "width": 1200,
      "height": 900,
      "type": "photo"
    }
  ],
  "folders": ["Interface"],
  "tags": ["minimal", "dark"]
}
```

Optional fields used by the lightbox:

```json
{
  "authorAvatar": "https://example.com/avatar.jpg",
  "bookmarkedAt": "2026-01-01T12:30:00.000Z",
  "language": "en",
  "mediaCount": 1,
  "likeCount": 100,
  "repostCount": 10,
  "replyCount": 3,
  "quoteCount": 1,
  "bookmarkCount": 25,
  "links": ["https://example.com"]
}
```

Video and GIF items can include `videoUrl`:

```json
{
  "url": "https://example.com/poster.jpg",
  "videoUrl": "https://example.com/video.mp4",
  "width": 1280,
  "height": 720,
  "type": "video"
}
```

## Metadata Cards

Metadata cards enrich filtering, search, and the lightbox. Each card connects to a bookmark through `tweet.id`; the name is historical and can represent any bookmark/source id.

```json
{
  "mediaId": "sample-interface-001-01",
  "collection": "Interface",
  "title": "Compact Operations Dashboard",
  "creator": "Example Studio",
  "source": "Sample",
  "category": "Interface",
  "style": ["Minimal"],
  "color": ["Dark"],
  "interaction": ["None"],
  "visible": ["Dark dashboard surface", "metric cards"],
  "visibleText": "Dark product interface with compact cards.",
  "media": {
    "type": "photo",
    "url": "assets/sample-interface.svg",
    "width": 1400,
    "height": 1000
  },
  "tweet": {
    "id": "sample-interface-001",
    "url": "https://example.com/samples/interface-dashboard",
    "folders": ["Interface"]
  },
  "tagGroups": {
    "collection": ["Interface"],
    "category": ["Interface"],
    "style": ["Minimal"],
    "color": ["Dark"],
    "interaction": ["None"],
    "source": ["Sample"]
  }
}
```

For multi-image bookmarks, only a card that resolves to `images[0]` contributes visual metadata to agent search. A card's `mediaId` is retained as a resolver alias and does not replace the base image's native or URL-derived media id.

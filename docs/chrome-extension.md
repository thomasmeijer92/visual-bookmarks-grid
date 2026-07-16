# Chrome Extension

The optional extension saves pages and exact images to the local clipper API.

## Install Locally

1. Start the local server:

   ```bash
   npm start
   ```

2. Open Chrome.
3. Go to `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked**.
6. Select the repository's `chrome-extension` folder.
7. Copy the extension ID shown on the extension card.
8. Restart the server with that ID allowed:

   ```bash
   ALLOWED_CHROME_EXTENSION_IDS=abcdefghijklmnopabcdefghijklmnop npm start
   ```

You can also allow full origins with `ALLOWED_EXTENSION_ORIGINS=chrome-extension://abcdefghijklmnopabcdefghijklmnop`.

The server rejects unconfigured extension origins and unrelated localhost ports. Add extra browser origins with `ALLOWED_API_ORIGINS` only when your remix has a separate local frontend that needs API access.

## Save A Page

Click the extension button, add optional tags and a note, then save. The extension sends the current page URL to:

```text
POST http://127.0.0.1:3000/api/clips
```

## Save An Exact Image

Right-click an image on any regular website and choose **Save image to Visual Grid**. This sends the exact image URL plus the page URL to the local server.

## Local Storage

The extension stores only its settings and last save result in Chrome extension storage. The server stores clipped items locally in ignored files:

- `web-clips.json`
- `assets/clips/`

Open grid tabs refresh automatically when clips are saved.

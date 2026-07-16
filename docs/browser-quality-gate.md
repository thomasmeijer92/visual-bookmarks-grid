# Browser Quality Gate

The browser quality gate uses committed sample fixtures only. It copies the committed
bookmark and media-card samples into an isolated temporary root, starts the server in
explicit `GRID_FIXTURE_MODE=sample`, and requires both configured fixture paths.
That mode cannot fall back to ignored root exports. Clip, note, review, board, index,
profile, and downloaded fixture state also stay under the operating system temporary
directory. It never reads a local browser profile or generated repository data.

## Install and run

```bash
npm ci
npx playwright install chromium
npm run check
npm run check:e2e
npm run check:e2e:demo
npm run check:e2e:extension
npm run check:all
```

`check` is the fast gate. `check:all` runs that gate before the Chromium app,
read-only public demo, and unpacked-extension suites. The demo suite builds the exact
static Pages artifact, serves it under a project subpath, and verifies sample-only
data, hidden write controls, zero API requests, and desktop/compact layout. The
extension suite needs a display because Chromium's
unpacked Manifest V3 support is most reliable headed. On Linux, use:

```bash
xvfb-run -a npm run check:e2e:extension
```

The app suite registers error listeners before navigation and covers fixture identity,
network boundaries, desktop and compact layout surfaces, same-task filter races,
reduced-motion commits, metadata/manual-note search, URL clipping, keyboard lightbox
behavior, board reorder persistence, and exported Markdown order. The extension suite
launches a fresh persistent Chromium profile with only this repository extension
loaded, explicitly captures failure-only traces/screenshots for that context, audits
worker/page errors and network traffic, saves loopback fixtures through the popup, and
exercises the production image-save module through its shared `.mjs` boundary. Popup
previews resolve only at the configured local server origin.

## Artifacts and privacy

Playwright keeps failure-only screenshots and traces in `test-results/`; reports
belong in `playwright-report/`; any manually retained diagnostic output belongs in
`test-artifacts/`. All three exact paths are ignored and are uploaded by CI only
when the quality gate fails. No artifact, clip, board, note, or browser profile is
committed.

## Context-menu circuit breaker

Chromium automation cannot reliably invoke a native image context menu across CI
displays. Before a release that changes this path, perform one manual check: open a
local page with an image, right-click it, choose **Save image to Visual Grid**, and
confirm the saved result window shows success. This native menu invocation is the
only manual extension circuit breaker.

# comix-dl

Download a manga series from comix.to as images, then pack it into a single EPUB — resumable at the panel level, with an optional desktop app.

> Personal-use tooling. Respect the site's terms and the scanlators; don't hammer the service.

## Features

- **Whole-series downloads** — walks the title page, one release per chapter (preferred scanlation group, else newest).
- **Resumable everywhere**
  - `state.json` — chapter statuses, written atomically after every chapter.
  - `pages.json` — per-chapter panel index (page number → URL); partial indexes are kept.
  - `index.json` — human-readable series summary (`total / urls / files / status` per chapter).
  - Existing `page-*.webp` files are skipped; only missing panels are retried.
- **Per-panel recovery** — missing URLs are re-attempted individually (scroll into view, poll, viewport cycling), not by re-harvesting the chapter. Small gaps skip the full sweep entirely.
- **EPUB output** — one EPUB3 book with `nav.xhtml` + `toc.ncx`, pages re-encoded to WebP under a size budget (default 300 MB) with per-page adaptive quality.
- **Desktop app** — Electron window with per-chapter status, live harvest/download progress, EPUB progress, stop/resume.
- **Library** — persistent history of downloaded titles (`~/.comix-dl/library.json`) with a read checkbox (read / to-read lists), 1–5 star scores, chapter counts and last-run dates. Existing output folders can be imported with “add folder”. Track unfinished titles by URL without downloading and re-check their release status (ongoing/finished) later.
- **Optional Sentry** — error reporting for the app, CLI and EPUB builder (disabled unless a DSN is configured).

## Requirements

- macOS, Windows or Linux (prebuilt apps: macOS arm64 + x64, Windows x64, Linux x64)
- Node.js 22+ (developed on 24) when running from source
- Brave Browser (default paths per OS: macOS `/Applications/Brave Browser.app`, Windows `C:\Program Files\BraveSoftware\...`, Linux `/usr/bin/brave-browser`; override with `COMIX_BROWSER=/path/to/browser`)

## Install

```bash
npm install
```

## Desktop app

```bash
npm start          # development
npm run build      # produces dist/comix-dl-darwin-arm64/comix-dl.app
```

Paste a comix.to **title URL**, pick the preferred group, set an optional chapter limit and EPUB cap, then **Start**. **Stop** is safe — Start resumes. Output defaults to `~/Downloads/comix-dl`.

## CLI

```bash
# one chapter
node comix-dl.mjs https://comix.to/title/<slug>/<id>-chapter-<n>

# whole series, preferred group, EPUB capped at 300 MB
node comix-dl.mjs --series https://comix.to/title/<slug> --group "Violet Scans"

# first five chapters, no EPUB
node comix-dl.mjs --series https://comix.to/title/<slug> --group "Violet Scans" --limit 5 --no-epub

# EPUB only, from an existing folder
node comix-epub.mjs "The Perks of Being a Villainess" --max-mb 300
```

Options: `--out DIR`, `--limit N`, `--group NAME`, `--max-mb N`, `--no-epub`, `--progress` (NDJSON events for the app), `--self-test`.

## How it works

1. Opens the title page in a real Brave instance (persistent profile, `~/.comix-dl-profile`) and walks its chapter list with trusted input.
2. For each chapter, resolves every panel URL by driving the reader: pages are virtualized, so each page is brought into view and polled until its `<img>` gets a `src`. Network requests are monitored as a completeness cross-check.
3. Downloads panels in a separate channel (6-way parallel `fetch`), validating image bytes rather than trusting content length.
4. Encodes and packs the EPUB (`sharp` + `yazl`).

The site's reader skips some near-square panels depending on viewport; the harvester sets a desktop viewport and cycles viewports per stuck panel — that is why recovery is per page.

## Tests

```bash
npm test          # offline, no browser/network: parsing, CLI errors, EPUB structure/ToC, size budget
node comix-dl.mjs --self-test
```

## Sentry (optional)

Create `~/.comix-dl/sentry.json`:

```json
{ "dsn": "https://<key>@o<org>.ingest.sentry.io/<project>", "environment": "production" }
```

or set `SENTRY_DSN`. Without it, all reporting is a no-op. Captured: main-process and renderer errors, spawn failures, chapter/harvest/download failures, EPUB errors.

## Project layout

```
comix-dl.mjs         pipeline CLI (enumeration, harvest, download, resume)
comix-epub.mjs       EPUB builder (encode + package + ToC)
app/                 Electron shell (main, preload, renderer)
test/run.mjs         offline test suite
```

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
- **Failure recovery** — transient CDN/connection errors retry with backoff (honoring `Retry-After`); chapters that still fail get a second, gentler pass (~45s cool-down, 2 workers, 8 attempts). Nothing is deleted: the run exits `2` (partial) without binding an incomplete book; rerunning retries only the failed chapters, or you can build an EPUB from the completed ones explicitly (app: “retry failed” / “build EPUB anyway”).
- **Kindle-first EPUB output** — fixed-layout comic EPUB3 using KCC's page structure (per-page viewport, `fixed-layout`, `book-type=comic`, one XHTML page per image, `nav.xhtml` + `toc.ncx`, `region-mag=true`). Pages are re-encoded to grayscale JPEG under a size budget (default 300 MB) with per-page adaptive quality; `--color` keeps color.
- **Desktop app** — Electron window with per-chapter status, live harvest/download progress, EPUB progress, stop/resume.
- **Background browser** — the automation browser launches without activation and is parked off-screen; downloads, searches and status checks never take focus. It only comes forward when a Cloudflare challenge needs a click, then parks again and returns focus to your previous app.
- **Library** — persistent history of downloaded titles (`~/.comix-dl/library.json`) with a read checkbox (read / to-read lists), 1–5 star scores, chapter counts and last-run dates. Existing output folders can be imported with “add folder”. Track titles by name (searches comix.to, including all content ratings: safe → pornographic) or URL without downloading; “check status” pulls comix's own status (RELEASING / HIATUS / FINISHED / …) and finished titles move into the to-read list automatically.
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

Paste a comix.to **title URL**, pick the preferred group, set an optional chapter range (`from` / `to`, blank = first/last), chapter limit and EPUB cap, then **Start**. The range also applies to **build EPUB anyway**, so you can split a large series into volume-sized books. **Stop** is safe — Start resumes. Output defaults to `~/Downloads/comix-dl`.

## CLI

```bash
# one chapter
node comix-dl.mjs https://comix.to/title/<slug>/<id>-chapter-<n>

# whole series, preferred group, EPUB capped at 300 MB
node comix-dl.mjs --series https://comix.to/title/<slug> --group "Violet Scans"

# first five chapters, no EPUB
node comix-dl.mjs --series https://comix.to/title/<slug> --group "Violet Scans" --limit 5 --no-epub

# one volume-sized range (Ch50–Ch70); limit applies after the range
node comix-dl.mjs --series https://comix.to/title/<slug> --from 50 --to 70 --max-mb 200

# EPUB only, from an existing folder, also range-limited
node comix-epub.mjs "The Perks of Being a Villainess" --max-mb 300 --from 50 --to 70
```

Options: `--out DIR`, `--from N`, `--to N`, `--limit N`, `--group NAME`, `--max-mb N`, `--no-epub`, `--progress` (NDJSON events for the app), `--self-test`. Exit codes: `0` complete, `2` partial (some chapters failed; EPUB built from the rest), `1` failed or nothing to build.

EPUB builder options: `--max-mb N` (default 300), `--width N` (default 800), `--from N`, `--to N`, `--color` (default is grayscale for e-ink), `--no-panel-view` (sets `region-mag=false`), `--device-width` / `--device-height` (default 1072×1448), `--progress`.

## How it works

1. Opens the title page in a real Brave instance (persistent profile, `~/.comix-dl-profile`) and walks its chapter list with trusted input. The window starts in the background and is parked off-screen; a Cloudflare challenge is the only time it comes forward.
2. For each chapter, resolves every panel URL by driving the reader: pages are virtualized, so each page is brought into view and polled until its `<img>` gets a `src`. Network requests are monitored as a completeness cross-check.
3. Downloads panels in a separate channel (6-way parallel `fetch`), validating image bytes rather than trusting content length.
4. Encodes and packs the EPUB (`sharp` + `yazl`).

The site's reader skips some near-square panels depending on viewport; the harvester sets a desktop viewport and cycles viewports per stuck panel — that is why recovery is per page.

## Tests

```bash
npm test          # offline, no browser/network: parsing, CLI errors, fixed-layout EPUB structure/ToC, size budget, chapter range
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

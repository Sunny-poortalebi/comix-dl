# HANDOFF

Date: 2026-10-25
Repo: `Sunny-poortalebi/comix-dl`
Branch: `main`
Last code commit: `5551a71` (`Report the ranged chapter count to the app`)

## Current state

The app and CLI now support chapter ranges and build fixed-layout comic EPUBs
using KCC-style page structure. The rebuilt macOS app is deployed at:

```
~/Desktop/Manhwa/comix-dl.app
```

Source/build directory:

```
~/Desktop/Manhwa/comix-dl
```

The working tree is clean. `npm test` passes 8/8 offline tests.

## What was implemented

### Chapter ranges

- CLI:
  - `--from N` and `--to N` select a chapter range.
  - Range is applied after preferred-group selection and before `--limit`.
  - Values may be decimals (`10.5`); `--from 0` is valid.
  - Invalid values and inverted ranges fail with a clear message.
- App:
  - Added **Chapter from** and **Chapter to** inputs.
  - Blank means first/last chapter.
  - The range is passed to both **Start** and **Build EPUB anyway**.
  - `COMIX_SMOKE_FROM` / `COMIX_SMOKE_TO` supported for smoke runs.
- Selection behavior:
  - If a cached `releases.json` exists, it is used.
  - With a range and no cache, the full chapter list is enumerated; the
    oldest-chapters shortcut is only used for `--limit` without a range.
  - The app's "planned" count now reports the selected range count, not the
    whole series count.

Relevant code: `comix-dl.mjs`, `app/main.cjs`, `app/preload.cjs`,
`app/renderer.js`, `app/index.html`.

### Fixed-layout EPUB builder

`comix-epub.mjs` was replaced with a fixed-layout comic EPUB3 builder:

- One JPEG and one XHTML page per source page.
- Per-page viewport and explicit image dimensions, matching KCC's page model.
- Kindle metadata: `fixed-layout`, `book-type=comic`, device
  `original-resolution`, `region-mag`, zero gutter/margin, border metadata,
  `rendition:pre-paginated`.
- EPUB3 `nav.xhtml` plus `toc.ncx`; one nav point per chapter.
- Grayscale JPEG by default (e-ink friendly); `--color` keeps color.
- Two-pass size-budget logic and quality/dimension fallback.
- Range-limited output filename suffix:
  - full: `Series.epub`
  - one chapter: `Series - Ch5.epub`
  - range: `Series - Ch5-20.epub`
  - from/to only: `Ch5+` / `Ch0-20`
- Builder options: `--max-mb`, `--width`, `--from`, `--to`, `--color`,
  `--no-panel-view`, `--device-width`, `--device-height`, `--progress`.

Relevant code: `comix-epub.mjs`, `test/run.mjs`, `README.md`.

### Other fix included in the commit

- Tiny but structurally valid image panels (for example a 78-byte WebP strip)
  are now accepted; image containers are validated instead of using a byte-size
  heuristic. Existing page files are validated the same way.

## Verification performed

- `npm test`: 8/8 pass (structure, budget, range, inverted range, CLI errors).
- Real cached range selection:
  - `--from 2 --to 2` on The Age of Arrogance.
  - Log: `93 chapters (Ch2-Ch2) · 1 already done`; exit 0.
- Real range EPUB build:
  - Ch1 only, 145 pages, 11.3 MB.
  - 145 JPEGs + 145 XHTML pages.
  - `viewport width=800 height=1280`; OPF has fixed-layout/book-type=comic.
  - `unzip -t` clean; OPF, NCX, nav and a page passed `xmllint`.
  - Test artifact was removed afterward.
- App UI via Electron CDP:
  - Range fields render correctly.
  - **Start** with `from=2, to=2` logs the range and
    `series: ... 1 chapters · 0 to download`.
  - **Build EPUB anyway** IPC with `from=1, to=1` returned code 0 and emitted
    the EPUB path.
- `npm run build` and deployment to `~/Desktop/Manhwa/comix-dl.app` were done
  after the final code change.
- Commits pushed:
  - `73a1b90` Add chapter ranges and fixed-layout comic EPUBs
  - `5551a71` Report the ranged chapter count to the app

## Known limitations / risks

- **Not tested on a physical Kindle.** Validation so far is structural: EPUB
  layout, metadata, XML and archive integrity. The next real test is Send to
  Kindle and checking page fit and panel view.
- **No KCC magnify overlays.** The EPUB sets `region-mag=true`, but unlike KCC
  it does not emit per-page `app-amzn-magnify` quadrant overlays. If Kindle
  panel view does not work, add those overlays next.
- **Existing full-series EPUB was not regenerated.** The old
  `~/Downloads/comix-dl/The Age of Arrogance.epub` is still the previous
  reflowable WebP build (246 MB). Build a new range from the app or CLI before
  sending it to Kindle.
- **Full 300 MB build not exercised end-to-end.** A 145-page chapter was
  verified. Large ranges (for example 12,000 pages) should be tested for memory
  use, runtime, and cap accuracy.
- **App does not expose color/panel-view options.** These are CLI flags only.
- **Minor copy:** the app summary currently says `1 chapters` for a one-chapter
  range.
- **Older unrelated open task:** retry the 37 failed chapters of
  *Cheese in the Trap* from the earlier session; this handoff did not touch that
  download.

## Planned next steps

1. Send a small new range EPUB (Ch1 only or Ch1-10) to Kindle and verify:
   - it opens as a comic/fixed-layout book;
   - pages fit without clipping;
   - panel view / double-tap behavior;
   - file size and conversion time.
2. If panel view is missing, implement KCC-style `app-amzn-magnify` overlays
   for four quadrants per page and retest on Kindle.
3. Build the user's desired volumes with the new builder, for example
   Ch1-35, Ch36-70, etc., instead of one 300 MB book. Do not overwrite the old
   full EPUB until the new one is verified.
4. Stress-test one large range (roughly 300 MB) for runtime and memory.
5. Optional polish:
   - expose `--color` and `--no-panel-view` in the app;
   - validate `from > to` in the app before spawning the CLI;
   - fix `1 chapters` pluralization;
   - bump the release version and rebuild platform artifacts.
6. Rerun the earlier *Cheese in the Trap* retry separately.

## Useful commands

```bash
cd ~/Desktop/Manhwa/comix-dl

npm test

# download one range, no EPUB
node comix-dl.mjs \
  --series https://comix.to/title/<slug> \
  --from 1 --to 10 --no-epub

# build an EPUB for a range from an existing folder
node comix-epub.mjs "The Age of Arrogance" --from 1 --to 10 --max-mb 200

# rebuild and deploy the macOS app
npm run build
rm -rf ~/Desktop/Manhwa/comix-dl.app
cp -R dist/comix-dl-darwin-arm64/comix-dl.app ~/Desktop/Manhwa/
```

# HANDOFF

Date: 2026-10-26
Repo: `Sunny-poortalebi/comix-dl`
Branch: `main`
Last code commit: `0e78695` (`EPUB: remove inter-page baseline gap (line-height 0, vertical-align top)`)

## Current state

The app and CLI now support chapter ranges and build fixed-layout comic EPUBs
using KCC's page model (2/3 viewport, cover, `#PV` layer, LTR spine). A
Ch1–3 test build was validated on a physical Kindle. The rebuilt macOS app is
deployed at:

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
- **KCC-compatible page geometry** (commit `a83dc69`):
  - viewport is **2/3 of the image** (`800×1280 → 533×853`, floored), while the
    `<img>` keeps its native pixel dimensions — this is what made Kindle scale
    pages instead of clipping them.
  - page wrapper (`text-align:center` + hidden dot) and empty `<div id="PV">`
    plus KCC's `#PV*` CSS for Kindle's virtual panel view.
  - first page doubles as `cover.jpg`, with `<meta name="cover">` and a
    `cover-image` manifest entry.
  - `page-progression-direction="ltr"` on the spine.
  - **seamless pages** (`0e78695`): `body { line-height: 0 }` +
    `img { vertical-align: top }`. KCC's inline image otherwise adds a 4px
    line-box below every page, visible as a gap between panels in continuous
    scroll. The image keeps its inline centering.
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

- `npm test`: 8/8 pass (structure, budget, range, inverted range, CLI errors;
  the cover is excluded from the page-count assertions).
- Real cached range selection:
  - `--from 2 --to 2` on The Age of Arrogance.
  - Log: `93 chapters (Ch2-Ch2) · 1 already done`; exit 0.
- Real range EPUB build (pre-`a83dc69`):
  - Ch1 only, 145 pages, 11.3 MB.
  - `unzip -t` clean; OPF, NCX, nav and a page passed `xmllint`.
  - Test artifact was removed afterward.
- KCC page-model rebuild (`a83dc69`) on The Age of Arrogance Ch1–3:
  - 409 pages (145+124+140), 29.5 MB, 409 JPEGs + 409 XHTML pages + cover.
  - Page viewport `533×853`, img `800×1280`, `#PV` layer and KCC CSS,
    spine `page-progression-direction="ltr"`, `region-mag=true`.
  - `unzip -t` clean; 0 `app-amzn-magnify` overlays (the validated KCC file
    also has none).
  - Page fidelity vs source WebPs: sampled MAE 1.83 / 1.18 / 2.27 / 2.01 /
    2.65 / 2.25 / 2.02 / 1.86 / 2.88 / 0.45 out of 255 — content-complete.
  - Artifact: `~/Downloads/comix-dl/kindle-kcc/TEST/The Age of Arrogance
    Ch1-3 (comix-epub native v2).epub`.
  - **Validated on a physical Kindle by the user** (page fit and panel view
    acceptable).
- Seamless-gap rebuild (`0e78695`):
  - Same 409-page geometry as v2, but rendered body height is now exactly the
    image height (1280px) instead of 1284px — the 4px baseline gap is gone.
  - Artifact: `~/Downloads/comix-dl/kindle-kcc/TEST/The Age of Arrogance
    Ch1-3 (comix-epub native v3).epub`.
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
  - `a83dc69` EPUB: match KCC page model (2/3 viewport, cover, PV layer, ltr spine)
  - `0e78695` EPUB: remove inter-page baseline gap (line-height 0, vertical-align top)

## Known limitations / risks

- **Kindle validation is limited to Ch1–3 of one title.** Longer ranges and
  other Kindle models are untested; structural checks pass but page fit should
  be spot-checked on larger builds.
- **No KCC magnify overlays.** The EPUB sets `region-mag=true` and the `#PV`
  layer; the validated KCC 12.1.1 file also has zero `app-amzn-magnify`
  overlays. Add quadrant overlays only if the built-in virtual panel view is
  not good enough.
- **No automatic white-margin cropping.** KCC crops page margins (its images
  are smaller than the source); this builder keeps the full page, so artwork
  can appear smaller. Add an optional crop step if margins matter.
- **Existing full-series EPUB was not regenerated.** The old
  `~/Downloads/comix-dl/The Age of Arrogance.epub` is still the previous
  reflowable WebP build (246 MB). Build a new range from the app or CLI before
  sending it to Kindle.
- **Full 300 MB build not exercised end-to-end.** A 409-page range was
  verified. Large ranges (for example 12,000 pages) should be tested for memory
  use, runtime, and cap accuracy.
- **App does not expose color/panel-view options.** These are CLI flags only.
- **Minor copy:** the app summary currently says `1 chapters` for a one-chapter
  range.
- **Older unrelated open task:** retry the 37 failed chapters of
  *Cheese in the Trap* from the earlier session; this handoff did not touch that
  download.

## Planned next steps

1. Build the user's desired volumes with the validated page model, for example
   Ch1-35, Ch36-70, etc., instead of one 300 MB book. The Ch1–3 v2 artifact is
   the reference; do not overwrite the old full EPUB until a large build is
   checked.
2. Stress-test one large range (roughly 300 MB) for runtime and memory.
3. Optional polish:
   - expose `--color` and `--no-panel-view` in the app;
   - validate `from > to` in the app before spawning the CLI;
   - fix `1 chapters` pluralization;
   - bump the release version and rebuild platform artifacts.
4. Optional: add KCC-style white-margin cropping and/or `app-amzn-magnify`
   quadrant overlays if device testing shows a need.
5. Rerun the earlier *Cheese in the Trap* retry separately.

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

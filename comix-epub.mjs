#!/usr/bin/env node
// comix-epub — pack a series folder into a fixed-layout comic EPUB.
//
// usage: node comix-epub.mjs <series-dir> [--max-mb 300] [--width 800]
//        [--from N] [--to N] [--color] [--no-panel-view]
//
// Each source page becomes one full-page JPEG and one XHTML page, with the
// fixed-layout/book-type=comic metadata Kindle expects for manga. This is the
// structure KCC/Kindle comics use; it converts far more reliably through Send
// to Kindle than a reflowable stack of images.
//
// Images are grayscale by default (e-ink friendly, smaller). Pass --color for
// tablets/color Kindles.

import sharp from "sharp";
import yazl from "yazl";
import * as Sentry from "@sentry/node";
import { readdir, readFile, stat } from "node:fs/promises";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

let PROGRESS = false;
const emit = (ev) => {
  if (PROGRESS) process.stdout.write(`\n@@P ${JSON.stringify(ev)}\n`);
};

// --- Sentry (optional): DSN from SENTRY_DSN or ~/.comix-dl/sentry.json
let SENTRY_ON = false;
try {
  const cfgPath = path.join(os.homedir(), ".comix-dl", "sentry.json");
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
  const dsn = process.env.SENTRY_DSN || cfg.dsn;
  if (dsn) {
    Sentry.init({
      dsn,
      environment: cfg.environment || "production",
      release: "comix-dl@1.0.0",
      tracesSampleRate: 0,
    });
    SENTRY_ON = true;
  }
} catch {}
const capture = (err, tags = {}, extra = {}) => {
  if (!SENTRY_ON) return;
  Sentry.withScope((scope) => {
    scope.setTags(tags);
    scope.setExtras(extra);
    Sentry.captureException(err);
  });
};

function fail(msg) {
  throw new Error(msg);
}

const args = process.argv.slice(2);
let seriesDir = null;
let maxMb = 300;
let width = 800;
let color = false;
let panelView = true;
let from = null;
let to = null;
let deviceWidth = 1072;
let deviceHeight = 1448;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--max-mb") maxMb = Number(args[++i]);
  else if (a === "--width") width = Number(args[++i]);
  else if (a === "--from") from = Number(args[++i]);
  else if (a === "--to") to = Number(args[++i]);
  else if (a === "--device-width") deviceWidth = Number(args[++i]);
  else if (a === "--device-height") deviceHeight = Number(args[++i]);
  else if (a === "--color") color = true;
  else if (a === "--no-panel-view") panelView = false;
  else if (a === "--progress") PROGRESS = true;
  else if (a.startsWith("--")) fail(`unknown option: ${a}`);
  else seriesDir = a;
}
if (!seriesDir || !existsSync(seriesDir))
  fail("usage: node comix-epub.mjs <series-dir> [--max-mb 300] [--width 800] [--from N] [--to N]");
if (!Number.isFinite(maxMb) || maxMb <= 0) fail("--max-mb must be a positive number");
if (!Number.isFinite(width) || width <= 0) fail("--width must be a positive number");
for (const [name, value] of [["--from", from], ["--to", to]]) {
  if (value != null && (!Number.isFinite(value) || value < 0))
    fail(`${name} must be a non-negative chapter number`);
}
if (from != null && to != null && from > to) fail("--from must be <= --to");

const IMG_RE = /^page-(\d+)\.(webp|jpe?g|png)$/i;
const QUALITY_LADDER = color
  ? [72, 65, 58, 52, 46, 40, 34, 28, 22, 16]
  : [68, 60, 54, 48, 42, 36, 30, 24, 18];
const CONCURRENCY = Math.max(1, Math.min(4, os.cpus().length - 1));

const fmtNum = (n) => String(Number(n)).replace(/\.0$/, "");
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function rangeSuffix() {
  if (from == null && to == null) return "";
  if (from != null && to != null) return from === to ? ` - Ch${fmtNum(from)}` : ` - Ch${fmtNum(from)}-${fmtNum(to)}`;
  if (from != null) return ` - Ch${fmtNum(from)}+`;
  return ` - Ch0-${fmtNum(to)}`;
}

async function scanChapters(dir) {
  // respect the download ledger: never bind a chapter that failed mid-way
  let statuses = null;
  try {
    statuses = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")).chapters || null;
  } catch {}
  const chapters = [];
  for (const name of (await readdir(dir)).sort()) {
    const m = /^Ch([\d.]+)\s*\(/.exec(name);
    if (!m) continue;
    const num = String(parseFloat(m[1]));
    if (statuses && statuses[num]?.status && statuses[num].status !== "done") continue;
    const chapDir = path.join(dir, name);
    if (!(await stat(chapDir)).isDirectory()) continue;
    const images = (await readdir(chapDir)).filter((f) => IMG_RE.test(f)).sort();
    if (images.length) chapters.push({ number: parseFloat(m[1]), label: name, dir: chapDir, images });
  }
  chapters.sort((a, b) => a.number - b.number);
  return chapters.filter(
    (c) => (from == null || c.number >= from - 1e-9) && (to == null || c.number <= to + 1e-9),
  );
}

function jpegPipeline(file, targetWidth) {
  let s = sharp(file, { failOn: "none" }).rotate().resize({
    width: targetWidth,
    withoutEnlargement: true,
  });
  if (!color) s = s.grayscale();
  return s;
}

async function encodePage(file, target) {
  const base = jpegPipeline(file, width);
  let fallback = null;
  for (const q of QUALITY_LADDER) {
    const { data, info } = await base
      .clone()
      .jpeg({ quality: q, mozjpeg: true, chromaSubsampling: "4:4:4" })
      .toBuffer({ resolveWithObject: true });
    const page = { buf: data, width: info.width, height: info.height };
    if (data.length <= target) return page;
    fallback = page;
  }
  // quality floor still misses the budget: trade dimensions for bytes
  for (const scale of [0.85, 0.72, 0.6, 0.5, 0.42]) {
    const { data, info } = await jpegPipeline(file, Math.max(320, Math.round(width * scale)))
      .jpeg({ quality: 32, mozjpeg: true, chromaSubsampling: "4:4:4" })
      .toBuffer({ resolveWithObject: true });
    const page = { buf: data, width: info.width, height: info.height };
    if (data.length <= target) return page;
    fallback = page;
  }
  return fallback;
}

async function encodeAll(chapters, target, pass) {
  const tasks = [];
  for (let ci = 0; ci < chapters.length; ci++)
    for (let ii = 0; ii < chapters[ci].images.length; ii++)
      tasks.push({ ci, ii, file: path.join(chapters[ci].dir, chapters[ci].images[ii]) });
  const encoded = chapters.map((ch) => ({ ...ch, imgs: new Array(ch.images.length) }));
  let next = 0;
  let done = 0;
  let bytes = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, async () => {
      while (next < tasks.length) {
        const task = tasks[next++];
        const page = await encodePage(task.file, target);
        encoded[task.ci].imgs[task.ii] = page;
        bytes += page.buf.length;
        done++;
        if (done % 100 === 0 || done === tasks.length) {
          process.stdout.write(
            `\r  pass ${pass}: encoding ${done}/${tasks.length} (${(bytes / 1e6).toFixed(1)} MB)`,
          );
          emit({ type: "epubEncode", pass, done, total: tasks.length, bytes });
        }
      }
    }),
  );
  process.stdout.write("\n");
  return { encoded, bytes };
}

// KCC's proven page model: the viewport is 2/3 of the image, so Kindle scales
// the page instead of rendering it at 1:1 and clipping the bottom. The image
// keeps its full pixel dimensions (KCC does the same), and #PV is the anchor
// Kindle's virtual panel view overlays.
const VIEWPORT_SCALE = 2 / 3;

function xhtml(page, imageName, w, h) {
  const vw = Math.floor(w * VIEWPORT_SCALE);
  const vh = Math.floor(h * VIEWPORT_SCALE);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
<head><meta charset="utf-8"/><title>Page ${page}</title><link rel="stylesheet" href="../style.css"/>
<meta name="viewport" content="width=${vw}, height=${vh}"/></head>
<body><div style="text-align:center;"><div style="display:none;">.</div><img width="${w}" height="${h}" src="../Images/${imageName}" alt="Page ${page}"/></div><div id="PV"></div></body>
</html>`;
}

async function main() {
  const chapters = await scanChapters(seriesDir);
  if (!chapters.length) fail(`no completed chapters${rangeSuffix() ? ` in range${rangeSuffix()}` : ""} under ${seriesDir}`);
  const totalImages = chapters.reduce((n, c) => n + c.images.length, 0);
  const budget = maxMb * 1e6;
  const overhead = Math.min(3e6, budget * 0.02 + 200_000);
  let target = Math.max(2048, Math.floor((budget - overhead) / totalImages));
  const series = path.basename(seriesDir);
  const title = `${series}${rangeSuffix()}`;
  const outPath = path.join(path.dirname(seriesDir), `${title}.epub`);
  console.log(
    `  ${chapters.length} chapters · ${totalImages} pages · target ${Math.round(target / 1024)} KB/page · cap ${maxMb} MB`,
  );

  let encoded = [];
  for (let pass = 1; pass <= 2; pass++) {
    const res = await encodeAll(chapters, target, pass);
    encoded = res.encoded;
    if (res.bytes <= budget - 1.2e6) break;
    if (pass === 2) fail(`cannot fit ${totalImages} pages under ${maxMb} MB at width ${width}`);
    target = Math.max(2048, Math.floor(target * ((budget - 1.5e6) / res.bytes) * 0.98));
    console.log(`  over budget — retrying with ${Math.round(target / 1024)} KB/page`);
  }

  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from("application/epub+zip"), "mimetype", { compress: false });
  zip.addBuffer(
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
    "META-INF/container.xml",
  );

  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="css" href="style.css" media-type="text/css"/>',
  ];
  const coverImg = encoded[0]?.imgs[0];
  if (coverImg) {
    zip.addBuffer(coverImg.buf, "OEBPS/Images/cover.jpg", { compress: false });
    manifest.push('<item id="cover" href="Images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>');
  }
  const spine = [];
  const navItems = [];
  const toc = [];
  let page = 0;
  encoded.forEach((chapter) => {
    chapter.firstPage = page + 1;
    for (const imgPage of chapter.imgs) {
      page++;
      const id = `p${String(page).padStart(5, "0")}`;
      const img = `${id}.jpg`;
      zip.addBuffer(imgPage.buf, `OEBPS/Images/${img}`, { compress: false });
      zip.addBuffer(
        Buffer.from(xhtml(page, img, imgPage.width, imgPage.height)),
        `OEBPS/Text/${id}.xhtml`,
      );
      manifest.push(`<item id="img${id}" href="Images/${img}" media-type="image/jpeg"/>`);
      manifest.push(`<item id="${id}" href="Text/${id}.xhtml" media-type="application/xhtml+xml"/>`);
      spine.push(`<itemref idref="${id}"/>`);
    }
    navItems.push(
      `<li><a href="Text/p${String(chapter.firstPage).padStart(5, "0")}.xhtml">${esc(chapter.label)}</a></li>`,
    );
    toc.push({
      id: `p${String(chapter.firstPage).padStart(5, "0")}`,
      label: chapter.label,
    });
  });

  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">
<head><meta charset="utf-8"/><title>Contents</title><link rel="stylesheet" href="style.css"/></head>
<body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${navItems.join("")}</ol></nav></body>
</html>`;

  const uuid = crypto.randomUUID();
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${uuid}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${esc(title)}</text></docTitle>
  <navMap>
${toc
  .map(
    (e, i) =>
      `    <navPoint id="navPoint-${i + 1}" playOrder="${i + 1}"><navLabel><text>${esc(e.label)}</text></navLabel><content src="Text/${e.id}.xhtml"/></navPoint>`,
  )
  .join("\n")}
  </navMap>
</ncx>`;
  manifest.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:${uuid}</dc:identifier>
    <dc:title>${esc(title)}</dc:title>
    <dc:language>en</dc:language>
    <dc:contributor id="contributor">KindleComicConverter-compatible</dc:contributor>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</meta>
    <meta name="fixed-layout" content="true"/>
    <meta name="original-resolution" content="${deviceWidth}x${deviceHeight}"/>
    <meta name="book-type" content="comic"/>
    <meta name="primary-writing-mode" content="horizontal-lr"/>
    <meta name="zero-gutter" content="true"/>
    <meta name="zero-margin" content="true"/>
    <meta name="ke-border-color" content="#FFFFFF"/>
    <meta name="ke-border-width" content="0"/>
    <meta name="orientation-lock" content="none"/>
    <meta name="region-mag" content="${panelView ? "true" : "false"}"/>
    <meta property="rendition:spread">landscape</meta>
    <meta property="rendition:layout">pre-paginated</meta>
    ${coverImg ? '<meta name="cover" content="cover"/>' : ""}
  </metadata>
  <manifest>${manifest.join("")}</manifest>
  <spine toc="ncx" page-progression-direction="ltr">${spine.join("")}</spine>
</package>`;

  const css = `@page { margin: 0; }
body { display: block; margin: 0; padding: 0; }
#PV { position: absolute; width: 100%; height: 100%; top: 0; left: 0; }
#PV-T { top: 0; width: 100%; height: 50%; }
#PV-B { bottom: 0; width: 100%; height: 50%; }
#PV-L { left: 0; width: 49.5%; height: 100%; float: left; }
#PV-R { right: 0; width: 49.5%; height: 100%; float: right; }
#PV-TL { top: 0; left: 0; width: 49.5%; height: 50%; float: left; }
#PV-TR { top: 0; right: 0; width: 49.5%; height: 50%; float: right; }
#PV-BL { bottom: 0; left: 0; width: 49.5%; height: 50%; float: left; }
#PV-BR { bottom: 0; right: 0; width: 49.5%; height: 50%; float: right; }
.PV-P { width: 100%; height: 100%; top: 0; position: absolute; display: none; }`;
  zip.addBuffer(Buffer.from(opf), "OEBPS/content.opf");
  zip.addBuffer(Buffer.from(ncx), "OEBPS/toc.ncx");
  zip.addBuffer(Buffer.from(nav), "OEBPS/nav.xhtml");
  zip.addBuffer(Buffer.from(css), "OEBPS/style.css");

  await new Promise((resolve, reject) => {
    const ws = createWriteStream(outPath);
    zip.outputStream.on("error", reject);
    zip.outputStream.pipe(ws).on("close", resolve).on("error", reject);
    zip.end();
  });

  const size = (await stat(outPath)).size;
  console.log(`  wrote ${outPath} (${(size / 1e6).toFixed(1)} MB)`);
  emit({ type: "epubReady", bytes: size, path: outPath });
  if (size > budget) fail(`epub exceeds the ${maxMb} MB budget`);
}

try {
  await main();
} catch (err) {
  capture(err, { stage: "epub" });
  console.error(`comix-epub: ${err.message}`);
  if (SENTRY_ON) await Sentry.flush(3000);
  process.exit(1);
}

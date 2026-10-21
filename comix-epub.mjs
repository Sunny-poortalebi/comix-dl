#!/usr/bin/env node
// comix-epub — pack a comix-dl series folder into one EPUB within a size budget.
//
// usage: node comix-epub.mjs <series-dir> [--max-mb 300] [--width 600]
//
// Every page is downscaled to `width` and re-encoded as WebP with the highest
// quality step that fits a per-page byte target derived from the budget, so the
// whole book lands under the cap while simple pages stay crisp. One XHTML per
// chapter, images stacked vertically (webtoon layout).

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
  if (PROGRESS) process.stdout.write(`@@P ${JSON.stringify(ev)}\n`);
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
let width = 600;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--max-mb") maxMb = Number(args[++i]);
  else if (a === "--width") width = Number(args[++i]);
  else if (a === "--progress") PROGRESS = true;
  else if (a.startsWith("--")) fail(`unknown option: ${a}`);
  else seriesDir = a;
}
if (!seriesDir || !existsSync(seriesDir))
  fail("usage: node comix-epub.mjs <series-dir> [--max-mb 300] [--width 600]");

const IMG_RE = /^page-(\d+)\.(webp|jpe?g|png)$/i;
const QUALITY_LADDER = [78, 68, 58, 50, 42, 36];

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
  return chapters;
}

async function encodePage(file, target) {
  const base = sharp(file, { failOn: "none" }).resize({ width, withoutEnlargement: true });
  let fallback = null;
  for (const q of QUALITY_LADDER) {
    const buf = await base.clone().webp({ quality: q, effort: 5 }).toBuffer();
    if (buf.length <= target) return buf;
    fallback = buf;
  }
  // quality floor still misses the target: trade dimensions for bytes
  for (const scale of [0.85, 0.72, 0.6]) {
    const buf = await sharp(file, { failOn: "none" })
      .resize({ width: Math.max(360, Math.round(width * scale)), withoutEnlargement: true })
      .webp({ quality: 34, effort: 5 })
      .toBuffer();
    if (buf.length <= target) return buf;
    fallback = buf;
  }
  return fallback;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function xhtml(title, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
<head><meta charset="utf-8"/><title>${esc(title)}</title><link rel="stylesheet" href="style.css"/></head>
<body>${body}</body>
</html>`;
}

async function encodeAll(chapters, target, pass) {
  const encoded = [];
  const total = chapters.reduce((n, c) => n + c.images.length, 0);
  let done = 0;
  let bytes = 0;
  for (const ch of chapters) {
    const imgs = [];
    for (const f of ch.images) {
      const buf = await encodePage(path.join(ch.dir, f), target);
      imgs.push(buf);
      bytes += buf.length;
      done++;
      if (done % 100 === 0 || done === total)
        process.stdout.write(`\r  pass ${pass}: encoding ${done}/${total} (${(bytes / 1e6).toFixed(1)} MB)`);
      emit({ type: "epubEncode", pass, done, total, bytes });
    }
    encoded.push({ chapter: ch, imgs });
  }
  process.stdout.write("\n");
  return { encoded, bytes };
}

async function main() {
  const chapters = await scanChapters(seriesDir);
  if (!chapters.length) fail(`no chapter folders with images under ${seriesDir}`);
  const totalImages = chapters.reduce((n, c) => n + c.images.length, 0);
  const budget = maxMb * 1e6;
  let target = Math.floor((budget - 2e6) / totalImages); // reserve 2 MB for xhtml/opf/zip overhead
  const series = path.basename(seriesDir);
  const outPath = path.join(path.dirname(seriesDir), `${series}.epub`);
  console.log(
    `  ${chapters.length} chapters · ${totalImages} pages · target ${Math.round(target / 1024)} KB/page · cap ${maxMb} MB`,
  );

  let encoded = [];
  for (let pass = 1; pass <= 2; pass++) {
    const res = await encodeAll(chapters, target, pass);
    encoded = res.encoded;
    if (res.bytes <= budget - 1.5e6) break;
    if (pass === 2) fail(`cannot fit ${totalImages} pages under ${maxMb} MB at width ${width}`);
    target = Math.floor(target * ((budget - 1.8e6) / res.bytes) * 0.98);
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
  const spine = [];
  const navItems = [];
  const tocEntries = [];

  encoded.forEach(({ chapter, imgs }, ci) => {
    const chId = `ch${String(ci + 1).padStart(3, "0")}`;
    const body = imgs
      .map((buf, pi) => {
        const name = `img/${chId}-p${String(pi + 1).padStart(3, "0")}.webp`;
        zip.addBuffer(buf, `OEBPS/${name}`, { compress: false });
        manifest.push(`<item id="${chId}p${pi + 1}" href="${name}" media-type="image/webp"/>`);
        return `<img src="${name}" alt="Page ${pi + 1}"/>`;
      })
      .join("");
    zip.addBuffer(Buffer.from(xhtml(chapter.label, `<h1>${esc(chapter.label)}</h1>${body}`)), `OEBPS/${chId}.xhtml`);
    manifest.push(`<item id="${chId}" href="${chId}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${chId}"/>`);
    navItems.push(`<li><a href="${chId}.xhtml">${esc(chapter.label)}</a></li>`);
    tocEntries.push({ id: chId, label: chapter.label });
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
  <docTitle><text>${esc(series)}</text></docTitle>
  <navMap>
${tocEntries
  .map(
    (e, i) =>
      `    <navPoint id="navPoint-${i + 1}" playOrder="${i + 1}"><navLabel><text>${esc(e.label)}</text></navLabel><content src="${e.id}.xhtml"/></navPoint>`,
  )
  .join("\n")}
  </navMap>
</ncx>`;
  manifest.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:${uuid}</dc:identifier>
    <dc:title>${esc(series)}</dc:title>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</meta>
  </metadata>
  <manifest>${manifest.join("")}</manifest>
  <spine toc="ncx">${spine.join("")}</spine>
</package>`;

  const css = "body{margin:0;padding:0}h1{font:600 1.1em/1.3 sans-serif;margin:1em .8em}img{display:block;width:100%;height:auto;margin:0}";

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

#!/usr/bin/env node
// Offline test suite for comix-dl (no browser, no network).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";

const ROOT = path.resolve(import.meta.dirname, "..");
const CHILD_TIMEOUT = 60_000; // fail fast if a child hangs
const results = [];

let tmpRoot = "";
let sandboxHome = "";

function cleanup() {
  if (!tmpRoot) return;
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
  tmpRoot = "";
}
process.on("exit", cleanup);

const clip = (s, n = 1500) => {
  s = String(s ?? "");
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

// Run a project script with a sandboxed HOME so Sentry stays off even if the
// developer has ~/.comix-dl/sentry.json configured.
function runNode(script, args = []) {
  const r = spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    timeout: CHILD_TIMEOUT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, HOME: sandboxHome, SENTRY_DSN: "" },
  });
  return {
    ...r,
    timedOut: r.error?.code === "ETIMEDOUT",
    out: r.stdout ?? "",
    err: r.stderr ?? "",
  };
}

function expectStatus(r, expected, label) {
  if (r.timedOut) {
    throw new Error(`${label}: child timed out after ${CHILD_TIMEOUT / 1000}s`);
  }
  if (r.error) throw new Error(`${label}: spawn failed: ${r.error.message}`);
  assert.equal(
    r.status,
    expected,
    `${label}: expected exit ${expected}, got ${r.status}\n` +
      `--- stdout ---\n${clip(r.out)}\n--- stderr ---\n${clip(r.err)}`,
  );
}

function runUnzip(args, { binary = false } = {}) {
  const r = spawnSync("unzip", args, {
    cwd: ROOT,
    timeout: 20_000,
    encoding: binary ? "buffer" : "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `unzip ${args.join(" ")} failed: ${clip(r.stderr)}`);
  return r.stdout;
}

function zipEntries(epub) {
  return runUnzip(["-Z1", epub])
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function zipText(epub, entry) {
  return runUnzip(["-p", epub, entry], { binary: true }).toString("utf8");
}

// Deterministic, high-detail gradient noise: distinct per page, compresses to
// a realistic size (solid fills would make the 10 KB floor meaningless).
function gradientPage(width, height, palette, seed) {
  const buf = Buffer.alloc(width * height * 3);
  let state = seed >>> 0;
  const rand = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = 0.25 + 0.5 * (x / width) + 0.25 * (y / height);
      const i = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) {
        const v = Math.round(palette[c] * t + (rand() - 0.5) * 44);
        buf[i + c] = Math.max(0, Math.min(255, v));
      }
    }
  }
  return buf;
}

async function makeSeries(baseDir, { width, height, noisy }) {
  const seriesDir = path.join(baseDir, "Test Series");
  const chapterDir = path.join(seriesDir, "Ch1 (Test)");
  mkdirSync(chapterDir, { recursive: true });
  const palettes = [
    [230, 57, 70],
    [42, 157, 143],
    [69, 123, 157],
  ];
  for (let i = 0; i < 3; i++) {
    let raw;
    if (noisy) {
      raw = crypto.randomBytes(width * height * 3);
    } else {
      raw = gradientPage(width, height, palettes[i], 0x1234 + i * 7919);
    }
    const webp = await sharp(raw, { raw: { width, height, channels: 3 } })
      .webp({ quality: noisy ? 92 : 78, effort: 5 })
      .toBuffer();
    writeFileSync(
      path.join(chapterDir, `page-${String(i + 1).padStart(3, "0")}.webp`),
      webp,
    );
  }
  return seriesDir;
}

async function makeMultiSeries(baseDir) {
  const seriesDir = path.join(baseDir, "Range Series");
  const labels = ["Ch1 (Test)", "Ch2 (Test)", "Ch3 (Test)"];
  for (let c = 0; c < labels.length; c++) {
    const chapterDir = path.join(seriesDir, labels[c]);
    mkdirSync(chapterDir, { recursive: true });
    const raw = gradientPage(300, 500, [120 + c * 40, 80, 160 - c * 30], 0x9000 + c);
    const webp = await sharp(raw, { raw: { width: 300, height: 500, channels: 3 } })
      .webp({ quality: 78, effort: 5 })
      .toBuffer();
    writeFileSync(path.join(chapterDir, "page-001.webp"), webp);
  }
  return seriesDir;
}

async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name} (${Date.now() - started}ms)`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log(`FAIL ${name} (${Date.now() - started}ms)`);
    console.log(
      err.message
        .split("\n")
        .map((line) => `     ${line}`)
        .join("\n"),
    );
  }
}

function assertEpubStructure(epub, { chapterLabel, pageCount, chapterCount = 1 }) {
  assert.ok(existsSync(epub), `expected EPUB output at ${epub}`);
  const size = statSync(epub).size;
  assert.ok(size > 10 * 1024, `EPUB is only ${size} bytes (expected > 10 KB)`);

  const entries = zipEntries(epub);
  assert.ok(entries.length > 0, "EPUB archive contains no entries");
  assert.equal(entries[0], "mimetype", `first ZIP entry is ${entries[0]}, not mimetype`);

  const mimetype = zipText(epub, "mimetype").replace(/\r?\n/g, "").trim();
  assert.equal(mimetype, "application/epub+zip", `bad mimetype content: ${mimetype}`);

  for (const required of ["OEBPS/toc.ncx", "OEBPS/nav.xhtml", "OEBPS/content.opf", "OEBPS/style.css"]) {
    assert.ok(entries.includes(required), `archive is missing ${required}`);
  }

  const opf = zipText(epub, "OEBPS/content.opf");
  assert.ok(opf.includes('spine toc="ncx"'), 'content.opf lacks spine toc="ncx"');
  assert.ok(
    opf.includes('media-type="application/x-dtbncx+xml"'),
    "content.opf lacks the NCX media-type declaration",
  );
  assert.ok(opf.includes('<meta name="fixed-layout" content="true"/>'), "content.opf lacks fixed-layout");
  assert.ok(opf.includes('<meta name="book-type" content="comic"/>'), "content.opf lacks book-type=comic");

  const ncx = zipText(epub, "OEBPS/toc.ncx");
  const navPoints = ncx.match(/<navPoint\b/g) ?? [];
  assert.equal(
    navPoints.length,
    chapterCount,
    `toc.ncx has ${navPoints.length} <navPoint> entries, expected ${chapterCount}`,
  );
  assert.ok(
    ncx.includes(`<text>${chapterLabel}</text>`),
    `toc.ncx label does not contain ${chapterLabel}`,
  );

  const images = entries.filter(
    (e) => e.startsWith("OEBPS/Images/") && e.endsWith(".jpg") && !e.endsWith("/cover.jpg"),
  );
  const pages = entries.filter((e) => e.startsWith("OEBPS/Text/") && e.endsWith(".xhtml"));
  assert.equal(images.length, pageCount, `expected ${pageCount} .jpg images, found ${images.length}`);
  assert.equal(pages.length, pageCount, `expected ${pageCount} XHTML pages, found ${pages.length}`);

  const firstPage = zipText(epub, "OEBPS/Text/p00001.xhtml");
  assert.match(
    firstPage,
    /<meta name="viewport" content="width=\d+, height=\d+"\/>/,
    "page lacks a fixed-layout viewport",
  );
  assert.match(firstPage, /<img width="\d+" height="\d+"/, "page image lacks explicit dimensions");

  return size;
}

async function main() {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "comix-test-"));
  sandboxHome = path.join(tmpRoot, "home");
  mkdirSync(sandboxHome, { recursive: true });

  await test("self-test", () => {
    const r = runNode("comix-dl.mjs", ["--self-test"]);
    expectStatus(r, 0, "self-test");
    assert.match(r.out, /self-test ok/, `stdout missing "self-test ok": ${clip(r.out)}`);
  });

  await test("no-args shows usage", () => {
    const r = runNode("comix-dl.mjs");
    expectStatus(r, 1, "no-args");
    assert.match(`${r.out}${r.err}`, /usage/i, `neither stdout nor stderr mentions usage: ${clip(r.err)}`);
  });

  await test("unknown option exits 1", () => {
    const r = runNode("comix-dl.mjs", ["--bogus"]);
    expectStatus(r, 1, "unknown option");
  });

  await test("CLI rejects inverted chapter range", () => {
    const r = runNode("comix-dl.mjs", ["--series", "https://comix.to/title/x", "--from", "3", "--to", "2"]);
    expectStatus(r, 1, "CLI inverted range");
    assert.match(r.err, /--from must be <= --to/, `unexpected stderr: ${clip(r.err)}`);
  });

  await test("epub fixture structure", async () => {
    const base = path.join(tmpRoot, "basic");
    const seriesDir = await makeSeries(base, { width: 500, height: 1400, noisy: false });
    const r = runNode("comix-epub.mjs", [seriesDir, "--max-mb", "5"]);
    expectStatus(r, 0, "epub fixture");
    assertEpubStructure(`${seriesDir}.epub`, { chapterLabel: "Ch1 (Test)", pageCount: 3 });
  });

  await test("epub respects 3 MB budget", async () => {
    const base = path.join(tmpRoot, "budget");
    const seriesDir = await makeSeries(base, { width: 700, height: 2000, noisy: true });
    const r = runNode("comix-epub.mjs", [seriesDir, "--max-mb", "3"]);
    expectStatus(r, 0, "epub budget");
    const epub = `${seriesDir}.epub`;
    assert.ok(existsSync(epub), `expected EPUB output at ${epub}`);
    const size = statSync(epub).size;
    assert.ok(size <= 3_000_000, `EPUB is ${size} bytes, over the 3,000,000-byte budget`);
  });

  await test("epub chapter range", async () => {
    const base = path.join(tmpRoot, "range");
    const seriesDir = await makeMultiSeries(base);
    const r = runNode("comix-epub.mjs", [
      seriesDir,
      "--max-mb",
      "5",
      "--from",
      "2",
      "--to",
      "2",
    ]);
    expectStatus(r, 0, "epub range");
    const epub = `${seriesDir} - Ch2.epub`;
    assertEpubStructure(epub, { chapterLabel: "Ch2 (Test)", pageCount: 1 });
    const ncx = zipText(epub, "OEBPS/toc.ncx");
    assert.ok(ncx.includes("Ch2 (Test)"), "range EPUB labels should name Ch2");
    assert.ok(!ncx.includes("Ch1 (Test)"), "range EPUB should not include Ch1");
    assert.ok(!ncx.includes("Ch3 (Test)"), "range EPUB should not include Ch3");
    assert.ok(zipText(epub, "OEBPS/content.opf").includes("Range Series - Ch2"), "range title missing");
  });

  await test("epub rejects inverted range", () => {
    const base = path.join(tmpRoot, "bad-range");
    const seriesDir = path.join(base, "Range Series");
    mkdirSync(seriesDir, { recursive: true });
    const r = runNode("comix-epub.mjs", [seriesDir, "--from", "3", "--to", "2"]);
    expectStatus(r, 1, "epub inverted range");
    assert.match(r.err, /--from must be <= --to/, `unexpected stderr: ${clip(r.err)}`);
  });

  cleanup();
}

await main();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} tests passed`);
if (failed.length) {
  console.log("failed:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.error.split("\n")[0]}`);
}
process.exit(failed.length ? 1 : 0);

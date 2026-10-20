#!/usr/bin/env node
// comix-dl — download every page of a comix.to chapter as image files.
//
// usage:
//   node comix-dl.mjs <chapter-url> [more chapter urls...] [options]
//   node comix-dl.mjs --series <title-url> [--group NAME] [options]
//
// options:
//   --out <dir>    parent directory for downloads (default: cwd)
//   --series URL   download every chapter of a title (resumable via state.json)
//   --group NAME   preferred scanlation group in series mode (default: newest)
//   --no-epub      skip the final EPUB build in series mode
//   --max-mb N     EPUB size budget in MB (default: 300)
//
// If Cloudflare shows a challenge, the browser window stays open and the script
// asks you to solve it, then continues automatically.
//
// examples:
//   node comix-dl.mjs https://comix.to/title/<slug>/<id>-chapter-<n>
//   node comix-dl.mjs --series https://comix.to/title/<slug> --group "Your Group"
//
// How it works:
//   1. Launches your installed Chrome with a persistent profile
//      (~/.comix-dl-profile) so Cloudflare clearance cookies survive across runs.
//   2. The reader virtualizes images (~9 <img> in the DOM at a time) and scrolls
//      inside `main.rpage-main`, not the window. A MutationObserver plus a
//      stepped scrollTop walk harvests every page URL as it is inserted.
//   3. Images are plain no-referrer CDN URLs, so they download with plain fetch.
//
// Output: `<out>/<Series> - Ch<N> (<Group>)/page-001.webp ...`

import puppeteer from "puppeteer-core";
import * as Sentry from "@sentry/node";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile, readFile, readdir, stat, rename } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_BROWSER =
  process.platform === "darwin"
    ? "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
    : process.platform === "win32"
      ? "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
      : "/usr/bin/brave-browser";
const CHROME = process.env.COMIX_BROWSER || DEFAULT_BROWSER;
const PROFILE = path.join(os.homedir(), ".comix-dl-profile");
const DEBUG_PORT = 9333;

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

// --progress turns stdout into NDJSON events ("@@P {...}") for the desktop app
let PROGRESS = false;
const emit = (ev) => {
  if (PROGRESS) process.stdout.write(`@@P ${JSON.stringify(ev)}\n`);
};

function parseArgs(argv) {
  const urls = [];
  const opts = { out: process.cwd(), series: null, group: null, epub: true, maxMb: 300 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opts.out = argv[++i];
    else if (a === "--series") opts.series = argv[++i];
    else if (a === "--group") opts.group = argv[++i];
    else if (a === "--no-epub") opts.epub = false;
    else if (a === "--max-mb") opts.maxMb = Number(argv[++i]);
    else if (a === "--limit") opts.limit = Number(argv[++i]);
    else if (a === "--progress") PROGRESS = true;
    else if (a === "--self-test") opts.selfTest = true;
    else if (a === "--status-check") (opts.statusChecks ||= []).push(argv[++i]);
    else if (a === "--search") opts.search = argv[++i];
    else if (a.startsWith("--")) fail(`unknown option: ${a}`);
    else urls.push(a);
  }
  if (!opts.series && !opts.selfTest && !opts.statusChecks?.length && !opts.search && urls.length === 0)
    fail("usage: node comix-dl.mjs <chapter-url> [...] | --series <title-url> [--group NAME] [--out DIR] [--no-epub] [--max-mb N]");
  return { urls, opts };
}

function fail(msg) {
  throw new Error(msg);
}

/** Attach to an ordinary Chrome instance. We spawn the binary ourselves with
 *  only --remote-debugging-port, so the browser carries no automation flags
 *  (navigator.webdriver stays false) and Cloudflare treats it as normal Chrome.
 *  A running instance is reused; the browser stays open between runs so
 *  clearance cookies persist. */
async function connectBrowser() {
  const opts = { browserURL: `http://127.0.0.1:${DEBUG_PORT}`, protocolTimeout: 300_000 };
  try {
    return await puppeteer.connect(opts);
  } catch {}
  spawn(
    CHROME,
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
    { detached: true, stdio: "ignore" },
  ).unref();
  for (let i = 0; i < 60; i++) {
    try {
      return await puppeteer.connect(opts);
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  fail(`could not connect to Chrome on port ${DEBUG_PORT}`);
}

/** Trusted-input heartbeat: the site flags sessions after 3 consecutive API
 *  requests with no trusted click/keydown in the previous 2 s, so keep feeding
 *  CDP key events (isTrusted) while automation runs. */
function startHeartbeat(page) {
  const timer = setInterval(() => {
    page.keyboard.press("Shift").catch(() => {});
  }, 1500);
  return () => clearInterval(timer);
}

async function isBlocked(page) {
  const t = await page.title().catch(() => "");
  return /just a moment|third-party apps/i.test(t);
}

/** Cloudflare and the site's "third-party app" flag both look like a bad title.
 *  Clearing site data resets the flag; the Cloudflare check then needs the
 *  user's click, so the window stays open and we wait. */
async function ensureUnblocked(page, url) {
  if (!(await isBlocked(page))) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    const client = await page.createCDPSession();
    await client.send("Network.clearBrowserCookies").catch(() => {});
    try {
      await client.send("Storage.clearDataForOrigin", { origin: "https://comix.to", storageTypes: "all" });
    } catch {}
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));
    if (!(await isBlocked(page))) return;
    if (!/just a moment/i.test(await page.title())) continue; // still the block page
    console.log("  Cloudflare challenge open in the browser window — please solve it.");
    await page
      .waitForFunction(() => !/just a moment|third-party apps/i.test(document.title), { timeout: 300_000 })
      .catch(() => {});
    if (!(await isBlocked(page))) return;
  }
  fail(`still blocked at ${url}`);
}

/** Open the chapter page, waiting out any Cloudflare challenge with the
 *  user's help: the window stays open until the page clears. */
async function openChapter(url) {
  const browser = await connectBrowser();
  const page = await browser.newPage();
  // the reader's virtualizer skips some near-square panels at narrow/default
  // viewports; a desktop-sized viewport loads them consistently
  await page.setViewport({ width: 1280, height: 900 }).catch(() => {});
  const stopHeartbeat = startHeartbeat(page);
  // the page's hydration API calls must land inside the site's 2 s activity window
  await page.keyboard.press("Shift").catch(() => {});
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await ensureUnblocked(page, url);

  const cleared = await page
    .waitForFunction(() => !/just a moment|attention required/i.test(document.title), { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  if (!cleared) {
    console.log("  Cloudflare challenge open in the browser window — please solve it.");
    console.log("  waiting up to 5 minutes...");
    await page.waitForFunction(() => !/just a moment|attention required/i.test(document.title), {
      timeout: 300_000,
    });
    console.log("  challenge cleared");
  }
  return { browser, page, stopHeartbeat };
}

/** Reader metadata: series, chapter number, scanlation group, total pages. */
async function readerMeta(page) {
  await page.waitForSelector("main.rpage-main .rpage-page", { timeout: 60_000 });
  return page.evaluate(() => {
    const title = document.title; // "The Perks of Being a Villainess · Ch.109"
    const series = (title.split("·")[0] || title).trim();
    const chMatch = /Ch\.?\s*(\d+)/i.exec(title) || /chapter-(\d+)/i.exec(location.pathname);
    const bodyText = document.body.innerText;
    const gMatch = /Translated by ([^\n·]+)/i.exec(bodyText);
    return {
      series,
      chapter: chMatch ? chMatch[1] : "?",
      group: gMatch ? gMatch[1].trim().replace(/[\\/:*?"<>|]/g, "") : null,
      pages: document.querySelectorAll("main.rpage-main .rpage-page[data-page]").length,
    };
  });
}

/** Harvest every page URL despite virtualization: a MutationObserver catches
 *  each img at insertion time; stepped scrolling of the inner container
 *  triggers the lazy loader. */
async function harvestUrls(page, totalPages, known = {}) {
  // lazy images never load in a hidden tab (IntersectionObserver needs a
  // rendering pipeline), and puppeteer opens tabs in the background
  await page.bringToFront();

  // resumable panel index: if every page URL is already known, skip the reader
  if (Object.keys(known).length >= totalPages) {
    emit({ type: "harvest", seen: totalPages, total: totalPages, cached: true });
    return { pages: { ...known }, headers: new Map() };
  }

  /** Bring one panel into the reader's mounted window and wait for its URL.
   *  If the virtualizer dropped the node, scroll by estimated offset using the
   *  nearest mounted page as an anchor — never by an arbitrary neighbour. */
  const loadPanel = (num, budget = 2200) =>
    page.evaluate(
      async (target, total, budgetMs) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const sc = document.querySelector("main.rpage-main");
        const inner = sc && /(auto|scroll)/.test(getComputedStyle(sc).overflowY);
        const scroller = inner ? sc : document.scrollingElement || document.documentElement;
        scroller.style.scrollBehavior = "auto";
        const find = () => document.querySelector(`.rpage-page[data-page="${target}"]`);

        let el = find();
        for (let attempt = 0; attempt < 8 && !el; attempt++) {
          const mounted = [...document.querySelectorAll(".rpage-page[data-page]")];
          if (mounted.length) {
            let best = mounted[0];
            for (const p of mounted) {
              if (
                Math.abs(Number(p.dataset.page) - target) < Math.abs(Number(best.dataset.page) - target)
              )
                best = p;
            }
            const bestNum = Number(best.dataset.page);
            const avg = scroller.scrollHeight / total;
            const viewTop = inner ? sc.getBoundingClientRect().top : 0;
            const bestTop = best.getBoundingClientRect().top - viewTop + scroller.scrollTop;
            scroller.scrollTo({ top: Math.max(0, bestTop + (target - bestNum) * avg), behavior: "instant" });
          } else {
            scroller.scrollTo({ top: Math.max(0, ((target - 1) / total) * scroller.scrollHeight), behavior: "instant" });
          }
          await sleep(350);
          el = find();
        }
        if (!el) return false;
        el.scrollIntoView({ block: "center", behavior: "instant" });
        const deadline = performance.now() + budgetMs;
        for (;;) {
          const img = el.querySelector("img.rpage-page__img");
          const src = img && (img.src || img.getAttribute("src"));
          if (src) {
            window.__seen[String(target)] = src;
            return true;
          }
          if (performance.now() > deadline) return false;
          await sleep(120);
        }
      },
      num,
      totalPages,
      budget,
    );

  // the reader sometimes refuses to mount a panel until its layout is
  // recomputed; cycling the viewport un-sticks every case we have reproduced
  const VIEWPORTS = [
    { width: 1280, height: 900 },
    { width: 600, height: 900 },
    { width: 900, height: 600 },
    { width: 800, height: 780 },
  ];
  let vpIdx = 0;
  const cycleViewport = async () => {
    vpIdx = (vpIdx + 1) % VIEWPORTS.length;
    await page.setViewport(VIEWPORTS[vpIdx]).catch(() => {});
    await new Promise((r) => setTimeout(r, 450));
  };
  const loadPanelWithRecovery = async (num, budget = 2200) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await loadPanel(num, budget)) return true;
      await cycleViewport();
    }
    return false;
  };

  // small gap (typically a retry): skip the whole sweep and load just those
  // panels directly — deterministic and a few seconds
  const knownMissing = [];
  for (let n = 1; n <= totalPages; n++) if (!known[String(n)]) knownMissing.push(n);
  if (knownMissing.length && knownMissing.length <= 12) {
    await page.evaluate((seed) => {
      window.__seen = { ...seed };
    }, known);
    for (const n of knownMissing) await loadPanelWithRecovery(n);
    const pages = await page.evaluate(() => window.__seen);
    emit({ type: "harvest", seen: Object.keys(pages).length, total: totalPages, targeted: true });
    return { pages, headers: new Map() };
  }

  // network channel: every image the reader actually requests, with the exact
  // headers the browser used (fallback for the separate download channel)
  const net = new Map();
  page.on("request", (req) => {
    const u = req.url();
    if (req.resourceType() === "image" && /\/hi\//.test(u)) net.set(u, req.headers());
  });

  await page.evaluate((seed) => {
    window.__seen = { ...seed };
    if (window.__obs) window.__obs.disconnect();
    const record = (i) => {
      const pg = /Page (\d+)/.exec(i.alt || "");
      const src = i.src || i.getAttribute("src");
      if (pg && src) window.__seen[pg[1]] = src;
    };
    // Virtualization keeps ~9 <img> alive; catch each at insertion time and
    // again when its lazy src attribute lands.
    window.__obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "attributes") {
          record(m.target);
          continue;
        }
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.tagName === "IMG") record(n);
          else n.querySelectorAll?.("img.rpage-page__img").forEach(record);
        }
      }
    });
    window.__obs.observe(document.querySelector("main.rpage-main"), {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });
    document.querySelector("main.rpage-main").style.scrollBehavior = "auto";
    document.querySelectorAll("img.rpage-page__img").forEach(record);
  }, known);

  const grabStep = (top, wait) =>
    page.evaluate(async (t, budget) => {
      // the reader either scrolls main.rpage-main or the window; detect which
      const sc = document.querySelector("main.rpage-main");
      const inner = sc && /(auto|scroll)/.test(getComputedStyle(sc).overflowY);
      const el = inner ? sc : document.scrollingElement || document.documentElement;
      el.style.scrollBehavior = "auto";
      if (inner) el.scrollTo({ top: t, behavior: "instant" });
      else window.scrollTo({ top: t, behavior: "instant" });

      // don't step blindly: wait until each page currently in view has its
      // image URL assigned (virtualizer inserts placeholders, then sets src)
      const view = inner ? sc.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      const deadline = performance.now() + budget;
      for (;;) {
        const pending = [...document.querySelectorAll(".rpage-page[data-page]")].some((p) => {
          const r = p.getBoundingClientRect();
          if (r.bottom <= view.top + 1 || r.top >= view.bottom - 1) return false;
          const img = p.querySelector("img.rpage-page__img");
          return !img || !(img.src || img.getAttribute("src"));
        });
        if (!pending) break;
        if (performance.now() > deadline) break;
        await new Promise((r) => requestAnimationFrame(r));
      }
      await new Promise((r) => setTimeout(r, 80));
      document.querySelectorAll("img.rpage-page__img").forEach((i) => {
        const pg = /Page (\d+)/.exec(i.alt || "");
        if (pg && i.src) window.__seen[pg[1]] = i.src;
      });
      return { seen: Object.keys(window.__seen).length, top: el.scrollTop, height: el.scrollHeight };
    }, top, wait);

  // wait until the reader has laid out its full height; before hydration the
  // scroller reports only a couple of pages, which ends the walk immediately
  await page
    .waitForFunction(
      () => {
        const sc = document.querySelector("main.rpage-main");
        const el = sc && /(auto|scroll)/.test(getComputedStyle(sc).overflowY) ? sc : document.scrollingElement;
        return !!el && el.scrollHeight > 10_000;
      },
      { timeout: 60_000 },
    )
    .catch(() => {});

  let seen = 0;
  let y = 0;
  let height = 0;
  try {
    while (seen < totalPages) {
      const st = await grabStep(y, 1500);
      seen = st.seen;
      height = st.height;
      process.stdout.write(`\r  harvesting page URLs: ${seen}/${totalPages}`);
      emit({ type: "harvest", seen, total: totalPages });
      y += 2000;
      if (y > height + 2000) break;
    }
    // back sweep catches anything the forward pass scrolled past
    for (let yy = height; yy >= 0 && seen < totalPages; yy -= 1400) {
      const st = await grabStep(yy, 1200);
      seen = st.seen;
      height = st.height;
      process.stdout.write(`\r  harvesting page URLs: ${seen}/${totalPages}`);
    }
  } catch (err) {
    if (/Target closed|Session closed|Protocol error/i.test(String(err))) {
      console.error(`\n  browser tab closed during harvest — was the window closed?`);
      capture(new Error("browser tab closed during harvest"), { stage: "harvest" });
      return { failed: true };
    }
    throw err;
  }

  // repair pass: a few pages can fall between sweep windows (virtualizer
  // timing). Scroll each missing page element into view and let its img load.
  try {
    for (let round = 0; round < 3; round++) {
      // NOTE: never derive the page count from the DOM — the virtualizer
      // prunes nodes, so a DOM count silently skips every page past the window
      const missing = await page.evaluate((total) => {
        const out = [];
        for (let n = 1; n <= total; n++) if (!window.__seen[String(n)]) out.push(n);
        return out;
      }, totalPages);
      if (!missing.length) break;
      for (const n of missing) await loadPanelWithRecovery(n);
      const count = await page.evaluate(() => Object.keys(window.__seen).length);
      process.stdout.write(`\r  repairing missing pages: ${count}/${totalPages}`);
      emit({ type: "harvest", seen: count, total: totalPages });
    }
  } catch (err) {
    if (!/Target closed|Session closed|Protocol error/i.test(String(err))) throw err;
  }

  // last resort for stubborn pages: fresh document (virtualizer state reset),
  // keep everything found so far, then target only the gaps
  let stubborn = await page
    .evaluate((total) => {
      const out = [];
      for (let n = 1; n <= total; n++) if (!window.__seen[String(n)]) out.push(n);
      return out;
    }, totalPages)
    .catch(() => []);
  if (stubborn.length && stubborn.length <= 25) {
    try {
      const before = await page.evaluate(() => window.__seen);
      await page.keyboard.press("Shift").catch(() => {});
      await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
      await page.waitForSelector("main.rpage-main .rpage-page", { timeout: 60_000 }).catch(() => {});
      await page.evaluate((seed) => {
        window.__seen = { ...seed };
      }, before);
      for (const n of stubborn) await loadPanelWithRecovery(n, 2600);
      const count = await page.evaluate(() => Object.keys(window.__seen).length);
      emit({ type: "harvest", seen: count, total: totalPages, deep: true });
    } catch (err) {
      if (!/Target closed|Session closed|Protocol error/i.test(String(err))) throw err;
    }
  }
  process.stdout.write("\n");

  const pages = await page.evaluate(() => window.__seen);
  // network fill: a URL the browser loaded but the DOM removed before we read
  // it (virtualizer race). Only fill when the unmatched count exactly matches
  // the gap count, and in scroll order — never guess a partial mapping.
  const missingNums = [];
  for (let n = 1; n <= totalPages; n++) if (!pages[String(n)]) missingNums.push(n);
  const knownUrls = new Set(Object.values(pages));
  const unmatched = [...net.keys()].filter((u) => !knownUrls.has(u));
  if (missingNums.length && unmatched.length === missingNums.length) {
    missingNums.forEach((n, i) => (pages[n] = unmatched[i]));
    emit({ type: "networkFill", count: missingNums.length, total: net.size });
  }
  emit({ type: "network", count: net.size });

  return { pages, headers: net };
}

const EXT_BY_TYPE = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif" };

async function downloadAll(pages, dir, headers = new Map()) {
  await mkdir(dir, { recursive: true });
  const entries = Object.entries(pages).sort((a, b) => a[0] - b[0]);
  const existing = new Set();
  for (const f of await readdir(dir)) {
    const m = /^page-(\d+)\.(webp|jpe?g|png)$/i.exec(f);
    if (m && (await stat(path.join(dir, f))).size > 10_000) existing.add(Number(m[1]));
  }
  let done = 0;
  const failures = [];

  async function one([num, url]) {
    if (existing.has(Number(num))) {
      done++;
      return;
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // retries reuse the exact browser headers (the CDN sometimes enforces them)
        const h = attempt > 1 ? headers.get(url) : null;
        const res = await fetch(url, {
          signal: AbortSignal.timeout(60_000),
          ...(h
            ? {
                headers: {
                  ...(h["user-agent"] ? { "user-agent": h["user-agent"] } : {}),
                  accept: h.accept || "image/avif,image/webp,image/*,*/*;q=0.8",
                  ...(h.referer ? { referer: h.referer } : {}),
                },
              }
            : {}),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const type = (res.headers.get("content-type") || "").split(";")[0];
        const ext = EXT_BY_TYPE[type] || "webp";
        const buf = Buffer.from(await res.arrayBuffer());
        // tiny panels are legitimate (near-blank pages compress to a few KB);
        // validate the actual image container instead of a size heuristic
        const valid =
          buf.length > 100 &&
          (type === "image/webp"
            ? buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP"
            : type === "image/jpeg"
              ? buf[0] === 0xff && buf[1] === 0xd8
              : type === "image/png"
                ? buf.subarray(1, 4).toString() === "PNG"
                : /^image\//.test(type));
        if (!valid) throw new Error(`invalid image (${type || "unknown"}, ${buf.length} bytes)`);
        await writeFile(path.join(dir, `page-${String(num).padStart(3, "0")}.${ext}`), buf);
        done++;
        process.stdout.write(`\r  downloading: ${done}/${entries.length}`);
        emit({ type: "download", done, total: entries.length });
        return;
      } catch (err) {
        if (attempt === 3) failures.push({ num, url, err: String(err) });
      }
    }
  }

  const queue = entries.slice();
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (queue.length) await one(queue.shift());
    }),
  );
  process.stdout.write("\n");
  return failures;
}

function folderName(meta) {
  let name = `${meta.series.replace(/[\\/:*?"<>|]/g, "").trim()} - Ch${meta.chapter}`;
  if (meta.group) name += ` (${meta.group})`;
  return name;
}

async function downloadChapter(url, opts, dest = null) {
  console.log(url);
  const { browser, page, stopHeartbeat } = await openChapter(url);
  try {
    const meta = await readerMeta(page);
    console.log(`  ${meta.series} · Ch${meta.chapter}${meta.group ? ` · ${meta.group}` : ""} · ${meta.pages} pages`);
    emit({ type: "chapterMeta", number: meta.chapter, group: meta.group, pages: meta.pages });

    const dir = dest || path.join(opts.out, folderName(meta));
    const indexFile = path.join(dir, "pages.json");
    let known = {};
    try {
      if (existsSync(indexFile)) known = JSON.parse(await readFile(indexFile, "utf8")).pages || {};
    } catch {}
    emit({ type: "index", known: Object.keys(known).length, total: meta.pages });

    const harvested = await harvestUrls(page, meta.pages, known);
    if (harvested.failed) return false;
    const pages = harvested.pages;

    // persist the panel index even when incomplete: the next attempt retries
    // only the gaps instead of re-harvesting the whole chapter
    await mkdir(dir, { recursive: true });
    const tmpIndex = `${indexFile}.tmp`;
    await writeFile(
      tmpIndex,
      JSON.stringify(
        { chapter: meta.chapter, group: meta.group, total: meta.pages, fetchedAt: Date.now(), pages },
        null,
        1,
      ),
    );
    await rename(tmpIndex, indexFile);

    const got = Object.keys(pages).length;
    const missing = [];
    for (let n = 1; n <= meta.pages; n++) if (!pages[n]) missing.push(n);
    if (missing.length) {
      console.error(
        `  ${missing.length} page URL(s) still missing: ${missing.join(", ")} — index saved, next run retries only these`,
      );
      capture(new Error(`chapter incomplete: ${missing.length} page urls missing`), {
        stage: "harvest",
        chapter: String(meta.chapter),
      }, { missing: missing.slice(0, 25) });
      emit({ type: "chapterPartial", number: meta.chapter, missing: missing.length, total: meta.pages });
      return false;
    }

    const failures = await downloadAll(pages, dir, harvested.headers || new Map());
    if (failures.length) {
      console.error(`  ${failures.length} download(s) failed:`);
      for (const f of failures.slice(0, 5)) console.error(`    page ${f.num}: ${f.err}`);
      capture(new Error(`${failures.length} page downloads failed`), {
        stage: "download",
        chapter: String(meta.chapter),
      }, { first: failures[0]?.err });
      return false;
    }
    console.log(`  saved ${got} pages -> ${dir}`);
    emit({ type: "chapterDone", number: meta.chapter, ok: true, pages: got });
    return true;
  } finally {
    stopHeartbeat();
    await page.close().catch(() => {});
    browser.disconnect(); // leave Chrome running so clearance cookies persist
  }
}

// ---------------------------------------------------------------------------
// series mode: enumerate the title's chapter list, pick one release per
// chapter (preferred group, else newest), download resumably, then build EPUB

function normGroup(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function sameGroup(a, b) {
  if (!a || !b) return false;
  const na = normGroup(a);
  const nb = normGroup(b);
  return na === nb || na.includes(nb) || nb.includes(na);
}

const POLITE = (min = 2500, max = 4500) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

async function clickTrusted(page, selector) {
  const ok = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el || el.disabled) return false;
    document.documentElement.style.scrollBehavior = "auto";
    el.scrollIntoView({ block: "center", behavior: "instant" });
    return true;
  }, selector);
  if (!ok) return false;
  await new Promise((r) => setTimeout(r, 350));
  const pt = await page.evaluate((sel) => {
    const b = document.querySelector(sel).getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }, selector);
  // CDP mouse input is isTrusted — the site's guard credits it as user activity
  await page.mouse.click(pt.x, pt.y);
  return true;
}

async function firstRowHref(page) {
  return page.evaluate(() => document.querySelector('a[href*="chapter-"]')?.href || null);
}

async function waitForRowsChange(page, prev) {
  return page
    .waitForFunction(
      (p) => {
        const a = document.querySelector('a[href*="chapter-"]');
        return !!a && a.href !== p;
      },
      { timeout: 8_000 },
      prev,
    )
    .then(() => true)
    .catch(() => false);
}

async function scrapeRows(page) {
  return page.evaluate(() => {
    const out = [];
    document.querySelectorAll('a[href*="chapter-"]').forEach((a) => {
      const row = a.closest("li, tr, div");
      const t = (row ? row.innerText : a.innerText).trim().replace(/\s+/g, " ");
      if (/^Ch\./.test(t) && t.length < 150) out.push({ href: a.href, text: t });
    });
    return out;
  });
}

/** Full walk: trusted clicks on Next (the click also satisfies the site's
 *  user-activity guard for the pagination request it triggers). */
async function enumerateReleases(page) {
  await page.waitForSelector('a[href*="chapter-"]', { timeout: 60_000 });
  const rows = new Map();
  for (let guard = 0; guard < 80; guard++) {
    const batch = await scrapeRows(page);
    if (!batch.length) break;
    for (const r of batch) rows.set(r.href, r);
    process.stdout.write(`\r  enumerating: ${rows.size} releases`);

    const prev = batch[0].href;
    if (!(await clickTrusted(page, 'button[aria-label="Next page"]'))) break;
    if (!(await waitForRowsChange(page, prev))) break;
    await POLITE(2500, 4500);
  }
  process.stdout.write("\n");
  return [...rows.values()];
}

/** Sorted newest-first, so the oldest chapters are on the last page — jump
 *  there with one trusted click, then walk back only if something is missing. */
async function locateOldestChapters(page, topN, preferGroup) {
  await page.waitForSelector('a[href*="chapter-"]', { timeout: 60_000 });
  const need = new Set(Array.from({ length: topN }, (_, i) => String(i + 1)));
  const found = new Map();
  const collect = async () => {
    for (const r of await scrapeRows(page)) {
      const num = parseReleaseRow(r)?.number;
      if (!num || !need.has(num)) continue;
      if (!found.has(num)) found.set(num, []);
      found.get(num).push(r);
    }
    process.stdout.write(`\r  locating chapters: ${found.size}/${need.size}`);
  };

  await collect();
  if (found.size < need.size) {
    const prev = await firstRowHref(page);
    if (await clickTrusted(page, 'button[aria-label="Last page"]')) {
      if (await waitForRowsChange(page, prev)) {
        await POLITE(2000, 3500);
        await collect();
      }
    }
  }
  // walk back until every needed chapter has a release, and — when a preferred
  // group is set — until that group's release is found (rows alone are not
  // enough: the first match for a chapter may be a different group)
  const hasPreferred = (num) =>
    (found.get(num) || []).some((r) => sameGroup(parseReleaseRow(r)?.group, preferGroup));
  const complete = () => [...need].every((num) => found.has(num) && (!preferGroup || hasPreferred(num)));
  for (let i = 0; i < 8 && !complete(); i++) {
    const prev = await firstRowHref(page);
    if (!(await clickTrusted(page, 'button[aria-label="Previous page"]'))) break;
    if (!(await waitForRowsChange(page, prev))) break;
    await POLITE(2000, 3500);
    await collect();
  }
  process.stdout.write("\n");
  return [...found.values()].flat();
}

function ageSeconds(text) {
  const m = /(\d+)\s*(mos?|mo|[smhdwy])\b/i.exec(text);
  if (!m) return Infinity;
  const mult = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, mo: 2592000, mos: 2592000, y: 31536000 };
  return Number(m[1]) * (mult[m[2].toLowerCase()] ?? Infinity);
}

function parseReleaseRow(r) {
  const parts = r.text.split("·").map((s) => s.trim());
  const m = /^Ch\.([\d.]+)\s+(.+)$/.exec(parts[0] || "");
  if (!m) return null;
  return {
    number: String(parseFloat(m[1])).replace(/\.0$/, ""),
    group: m[2].trim(),
    age: ageSeconds(parts[parts.length - 1] || ""),
    url: r.href,
  };
}

/** One release per chapter: preferred group if present, else the newest. */
function pickReleases(raw, preferGroup) {
  const byNumber = new Map();
  for (const r of raw) {
    const rel = parseReleaseRow(r);
    if (!rel) continue;
    const cur = byNumber.get(rel.number);
    if (!cur) byNumber.set(rel.number, rel);
    else if (!sameGroup(cur.group, preferGroup) && sameGroup(rel.group, preferGroup)) byNumber.set(rel.number, rel);
    else if (
      sameGroup(cur.group, preferGroup) === sameGroup(rel.group, preferGroup) &&
      rel.age < cur.age
    )
      byNumber.set(rel.number, rel);
  }
  return [...byNumber.values()].sort((a, b) => parseFloat(a.number) - parseFloat(b.number));
}

async function downloadSeries(titleUrl, opts) {
  console.log(titleUrl);
  const { browser, page, stopHeartbeat } = await openChapter(titleUrl);
  let series;
  let releases;
  try {
    series = (await page.title()).split("·")[0].replace(/\s*[-–|].*$/, "").trim();
    const seriesDirEarly = path.join(opts.out, series.replace(/[\\/:*?"<>|]/g, ""));
    const cachePath = path.join(seriesDirEarly, "releases.json");
    if (existsSync(cachePath)) {
      try {
        const cached = JSON.parse(await readFile(cachePath, "utf8"));
        if (cached.fetchedAt && Date.now() - cached.fetchedAt < 14 * 864e5 && cached.rows?.length) {
          releases = cached.rows;
          console.log(`  using cached chapter list (${releases.length} releases)`);
        }
      } catch {}
    }
    if (!releases) {
      if (opts.limit) {
        releases = await locateOldestChapters(page, opts.limit, opts.group);
      } else {
        releases = await enumerateReleases(page);
        await mkdir(seriesDirEarly, { recursive: true });
        await writeFile(cachePath, JSON.stringify({ fetchedAt: Date.now(), rows: releases }, null, 1));
      }
    }
  } finally {
    stopHeartbeat();
    await page.close().catch(() => {});
    browser.disconnect();
  }
  if (!releases.length) fail("no chapters found on the title page");

  const picked = pickReleases(releases, opts.group);
  const limited = opts.limit ? picked.slice(0, opts.limit) : picked;
  const seriesDir = path.join(opts.out, series.replace(/[\\/:*?"<>|]/g, ""));
  await mkdir(seriesDir, { recursive: true });
  const statePath = path.join(seriesDir, "state.json");

  let state = { series, titleUrl, preferGroup: opts.group, chapters: {} };
  if (existsSync(statePath)) {
    try {
      const saved = JSON.parse(await readFile(statePath, "utf8"));
      state = { ...state, ...saved, chapters: saved.chapters || {} };
    } catch {}
  }

  const queue = limited.filter((r) => state.chapters[r.number]?.status !== "done");
  console.log(
    `  ${series} · ${picked.length} chapters${opts.limit ? ` (limited to first ${opts.limit})` : ""} · ${limited.length - queue.length} already done`,
  );
  emit({ type: "series", series, picked: picked.length, queued: queue.length, out: seriesDir });

  // state.json is the resume ledger: written atomically after every chapter,
  // so a crash/block/quit never loses completed work. Partial page folders are
  // also resumable — downloadAll skips files already on disk.
  const saveState = async () => {
    const tmp = `${statePath}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 1));
    await rename(tmp, statePath);
  };

  // readable chapter/panel index: what we know and what is on disk, per chapter
  const writeIndex = async () => {
    const chapters = [];
    const nums = Object.keys(state.chapters).sort((a, b) => parseFloat(a) - parseFloat(b));
    for (const num of nums) {
      const entry = state.chapters[num];
      let urls = 0;
      let total = 0;
      let files = 0;
      try {
        const idx = JSON.parse(await readFile(path.join(seriesDir, entry.dir || "", "pages.json"), "utf8"));
        urls = Object.keys(idx.pages || {}).length;
        total = idx.total || 0;
      } catch {}
      try {
        files = (await readdir(path.join(seriesDir, entry.dir || ""))).filter((f) =>
          /^page-\d+\.(webp|jpe?g|png)$/i.test(f),
        ).length;
      } catch {}
      chapters.push({ number: num, group: entry.group, status: entry.status, total, urls, files });
    }
    await writeFile(
      path.join(seriesDir, "index.json"),
      JSON.stringify({ series, updatedAt: Date.now(), chapters }, null, 1),
    );
  };

  const runQueue = async (list) => {
    let allOk = true;
    for (let i = 0; i < list.length; i++) {
      if (i > 0) await POLITE(3000, 6000);
      const r = list[i];
      console.log(`  [${i + 1}/${list.length}] Ch${r.number} (${r.group})`);
      emit({ type: "chapterStart", number: r.number, group: r.group });
      const dest = path.join(seriesDir, `Ch${r.number} (${r.group.replace(/[\\/:*?"<>|]/g, "")})`);
      let good = false;
      try {
        good = await downloadChapter(r.url, opts, dest);
      } catch (err) {
        console.error(`  chapter failed: ${String(err).slice(0, 200)}`);
        capture(err, { stage: "chapter", chapter: String(r.number) }, { group: r.group, series });
      }
      state.chapters[r.number] = {
        url: r.url,
        group: r.group,
        status: good ? "done" : "failed",
        dir: path.basename(dest),
      };
      await saveState();
      await writeIndex();
      allOk = allOk && good;
    }
    return allOk;
  };

  let ok = await runQueue(queue);
  const retryList = queue.filter((r) => state.chapters[r.number]?.status !== "done");
  if (retryList.length) {
    console.log(`  retrying ${retryList.length} failed chapter(s)...`);
    emit({ type: "retry", count: retryList.length });
    await POLITE(5000, 8000);
    ok = (await runQueue(retryList)) && ok;
  }

  if (ok && opts.epub) {
    console.log("  building epub...");
    emit({ type: "epubStart" });
    const res = spawnSync(
      process.execPath,
      [
        path.join(import.meta.dirname, "comix-epub.mjs"),
        seriesDir,
        "--max-mb",
        String(opts.maxMb),
        ...(PROGRESS ? ["--progress"] : []),
      ],
      { stdio: "inherit" },
    );
    ok = res.status === 0;
  }
  emit({ type: "runDone", ok });
  return ok;
}

/** Search comix.to through its own search box and return title results. */
async function searchTitles(query) {
  const { browser, page, stopHeartbeat } = await openChapter("https://comix.to/");
  try {
    // include every content rating (safe → pornographic) in the site's search;
    // comix reads this persisted settings store when building content_rating[]
    await page.evaluate(() => {
      try {
        const raw = localStorage.getItem("settings_v2");
        const s = raw ? JSON.parse(raw) : { state: {}, version: 2 };
        s.state = s.state || {};
        s.state.contentFilter = "pornographic";
        s.version = s.version ?? 2;
        localStorage.setItem("settings_v2", JSON.stringify(s));
      } catch {}
    });
    await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForSelector('input[placeholder="Search any title..."]', { timeout: 30_000 });
    const input = await page.$('input[placeholder="Search any title..."]');
    await input.click();
    await page.keyboard.type(query, { delay: 40 });
    await new Promise((r) => setTimeout(r, 1800));
    const results = await page.evaluate(() => {
      const links = [...document.querySelectorAll(".search-pop__section a[href*='/title/']")];
      const seen = new Set();
      const out = [];
      for (const a of links) {
        const href = new URL(a.getAttribute("href"), location.origin).href;
        if (seen.has(href)) continue;
        seen.add(href);
        const t = a.querySelector(".search-pop__item-title");
        const img = a.querySelector(".search-pop__thumb img");
        const type = a.querySelector(".search-pop__type");
        const sub = a.querySelector(".search-pop__item-sub");
        out.push({
          url: href,
          title: (t ? t.textContent : a.innerText).trim().replace(/\s+/g, " "),
          thumb: img ? img.src : null,
          type: type ? type.textContent.trim() : null,
          meta: sub ? sub.innerText.trim().replace(/\s+/g, " ") : null,
        });
      }
      return out.slice(0, 10);
    });
    console.log(`  ${results.length} result(s) for “${query}”`);
    emit({ type: "searchResults", query, results });
    return results.length > 0;
  } catch (err) {
    capture(err, { stage: "search" });
    console.error(`  search failed: ${err.message}`);
    emit({ type: "searchResults", query, results: [], error: err.message });
    return false;
  } finally {
    stopHeartbeat();
    await page.close().catch(() => {});
    browser.disconnect();
  }
}

/** Read a title's release status without downloading anything. */
async function checkStatus(url) {
  const { browser, page, stopHeartbeat } = await openChapter(url);
  try {
    const series = (await page.title()).split("·")[0].replace(/\s*[-–|].*$/, "").trim();
    const status = await page.evaluate(() => {
      const el = document.querySelector(".mpage__badge--status");
      return el ? el.textContent.trim().toUpperCase() : null;
    });
    const cover = await page.evaluate(() => {
      const img = document.querySelector(".mpage__poster img, .poster img");
      if (img && img.src) return img.src;
      const og = document.querySelector('meta[property="og:image"]');
      return og ? og.content : null;
    });
    console.log(`  ${series} — ${status || "unknown"}`);
    emit({ type: "status", url, series, status, cover });
    return true;
  } catch (err) {
    capture(err, { stage: "status" });
    console.error(`  status check failed: ${err.message}`);
    emit({ type: "status", url, series: null, status: null, error: err.message });
    return false;
  } finally {
    stopHeartbeat();
    await page.close().catch(() => {});
    browser.disconnect();
  }
}

function runSelfTest() {
  const assert = (cond, msg) => {
    if (!cond) {
      console.error(`self-test FAILED: ${msg}`);
      process.exit(1);
    }
  };
  const rel = parseReleaseRow({ href: "u", text: "Ch.109 Violet Scans · 0 · 12h ago" });
  assert(rel.number === "109", "chapter number parse");
  assert(rel.group === "Violet Scans", "group parse");
  assert(rel.age === 43_200, "age parse");
  assert(ageSeconds("8mos ago") === 8 * 2_592_000, "months parse");

  const picked = pickReleases(
    [
      { href: "a", text: "Ch.5 Other · 1 · 10d ago" },
      { href: "b", text: "Ch.5 Violet Scans · 2 · 1mo ago" },
      { href: "c", text: "Ch.4 Other · 1 · 2h ago" },
    ],
    "Violet Scans",
  );
  assert(picked.length === 2, "one release per chapter");
  assert(picked[0].number === "4" && picked[0].group === "Other", "ascending order");
  assert(picked[1].url === "b", "preferred group wins over recency");
  assert(folderName({ series: "A/B", chapter: "3", group: "G" }) === "AB - Ch3 (G)", "folder naming");
  console.log("self-test ok");
}

try {
  const { urls, opts } = parseArgs(process.argv.slice(2));
  if (opts.selfTest) {
    runSelfTest();
    process.exit(0);
  }
  if (opts.search) {
    const found = await searchTitles(opts.search);
    if (SENTRY_ON) await Sentry.flush(3000);
    process.exit(found ? 0 : 1);
  }
  if (opts.statusChecks?.length) {
    let allOk = true;
    for (const u of opts.statusChecks) allOk = (await checkStatus(u)) && allOk;
    if (SENTRY_ON) await Sentry.flush(3000);
    process.exit(allOk ? 0 : 1);
  }
  let ok = true;
  if (opts.series) {
    ok = await downloadSeries(opts.series, opts);
  } else {
    for (const url of urls) ok = (await downloadChapter(url, opts)) && ok;
  }
  if (SENTRY_ON) await Sentry.flush(3000);
  process.exit(ok ? 0 : 1);
} catch (err) {
  capture(err, { stage: "fatal" });
  console.error(`comix-dl: ${err.message}`);
  if (SENTRY_ON) await Sentry.flush(3000);
  process.exit(1);
}

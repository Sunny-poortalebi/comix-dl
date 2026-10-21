// comix-dl desktop app — Electron shell around the CLI pipeline.
// The CLI remains the engine: this process spawns it with --progress and
// renders the NDJSON events it emits on stdout.

const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const ROOT = path.join(__dirname, "..");
const SMOKE = process.env.COMIX_SMOKE === "1";

// --- Sentry (optional): DSN from SENTRY_DSN or ~/.comix-dl/sentry.json
const Sentry = require("@sentry/electron/main");
function sentryConfig() {
  const p = path.join(os.homedir(), ".comix-dl", "sentry.json");
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {}
  return null;
}
const sentryCfg = sentryConfig();
const SENTRY_DSN = process.env.SENTRY_DSN || sentryCfg?.dsn || null;
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: sentryCfg?.environment || "production",
    release: `comix-dl@${require("../package.json").version}`,
    tracesSampleRate: 0,
  });
}

let win = null;
let child = null;
let lastExitCode = null;
let currentRun = null;

// --- library: persistent history of downloaded titles ----------------------
const LIB_PATH = path.join(os.homedir(), ".comix-dl", "library.json");

function loadLibrary() {
  try {
    const lib = JSON.parse(fs.readFileSync(LIB_PATH, "utf8"));
    if (lib && typeof lib.titles === "object") return { version: 1, outDirs: [], ...lib };
  } catch {}
  return { version: 1, outDirs: [], titles: {} };
}

function saveLibrary(lib) {
  fs.mkdirSync(path.dirname(LIB_PATH), { recursive: true });
  const tmp = `${LIB_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lib, null, 2));
  fs.renameSync(tmp, LIB_PATH);
}

const libKey = (name) =>
  String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** import series folders that already exist on disk (index.json/state.json) */
function mergeLibraryFrom(dir) {
  const lib = loadLibrary();
  if (!lib.outDirs.includes(dir)) lib.outDirs.push(dir);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {}
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const seriesDir = path.join(dir, e.name);
    let idx;
    try {
      idx = JSON.parse(fs.readFileSync(path.join(seriesDir, "index.json"), "utf8"));
    } catch {
      continue;
    }
    const chapters = idx.chapters || [];
    const key = libKey(idx.series || e.name);
    const cur = lib.titles[key] || { addedAt: Date.now(), read: false, score: null };
    // comix-epub writes <out>/<Series>.epub next to the series folder
    const epubPath = path.join(dir, `${e.name}.epub`);
    lib.titles[key] = {
      ...cur,
      series: idx.series || e.name,
      outDir: seriesDir,
      epubPath: fs.existsSync(epubPath) ? epubPath : null,
      chaptersTotal: chapters.length,
      chaptersDone: chapters.filter((c) => c.status === "done").length,
      lastRunAt: idx.updatedAt || cur.lastRunAt || Date.now(),
    };
  }
  saveLibrary(lib);
  return lib;
}

function scanAllOutDirs() {
  let lib = loadLibrary();
  const dirs = [...new Set([...lib.outDirs, path.join(app.getPath("downloads"), "comix-dl")])];
  for (const d of dirs) lib = mergeLibraryFrom(d);
  return lib;
}


function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 780,
    minWidth: 780,
    minHeight: 560,
    title: "comix-dl",
    backgroundColor: "#0f1117",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "index.html"));
  win.on("closed", () => (win = null));
}

function send(ev) {
  if (win && !win.isDestroyed()) win.webContents.send("progress", ev);
}

function stopRun() {
  if (child) {
    child.kill("SIGTERM");
    child = null;
  }
}

ipcMain.handle("start", async (_e, cfg) => {
  if (child) return { error: "a run is already active" };
  if (statusCheckRunning) return { error: "metadata refresh in progress — try again in a moment" };
  if (epubRunning) return { error: "EPUB build in progress — try again in a moment" };
  if (!cfg.url || !/^https?:\/\//.test(cfg.url)) return { error: "paste a comix.to title URL" };

  const out = cfg.out || path.join(app.getPath("downloads"), "comix-dl");
  fs.mkdirSync(out, { recursive: true });

  const args = [
    path.join(ROOT, "comix-dl.mjs"),
    "--series",
    cfg.url,
    "--group",
    cfg.group || "Violet Scans",
    "--max-mb",
    String(cfg.maxMb || 300),
    "--progress",
  ];
  if (cfg.limit > 0) args.push("--limit", String(cfg.limit));
  if (cfg.noEpub) args.push("--no-epub");

  // run the pipeline on Electron's bundled Node runtime: a Finder-launched
  // .app has no system node on PATH. ELECTRON_RUN_AS_NODE makes the app binary
  // behave as plain node for the child process.
  child = spawn(process.execPath, args, {
    cwd: out,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  lastExitCode = null;
  currentRun = { url: cfg.url, out, seen: new Set() };

  const forward = (stream, isErr) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (line.startsWith("@@P ")) {
          try {
            const ev = JSON.parse(line.slice(4));
            if (currentRun && ev.type === "series") {
              const lib = loadLibrary();
              const key = libKey(ev.series);
              const cur = lib.titles[key] || { addedAt: Date.now(), read: false, score: null };
              lib.titles[key] = {
                ...cur,
                series: ev.series,
                url: currentRun.url,
                outDir: ev.out,
                lastRunAt: Date.now(),
                planned: ev.picked,
              };
              if (!lib.outDirs.includes(currentRun.out)) lib.outDirs.push(currentRun.out);
              saveLibrary(lib);
              send({ type: "libraryChanged" });
            }
            send(ev);
          } catch {}
        } else if (line.trim()) {
          send({ type: "log", line, err: isErr });
        }
      }
    });
  };
  forward(child.stdout, false);
  forward(child.stderr, true);

  child.on("error", (err) => {
    send({ type: "log", line: `spawn failed: ${err.message}`, err: true });
    if (SENTRY_DSN) Sentry.captureException(err, { tags: { stage: "spawn" } });
  });

  child.on("exit", (code) => {
    lastExitCode = code;
    child = null;
    if (currentRun) {
      try {
        mergeLibraryFrom(currentRun.out);
      } catch {}
      send({ type: "libraryChanged" });
      currentRun = null;
    }
    send({ type: "exit", code });
    if (SMOKE) {
      console.log(`SMOKE_RESULT code=${code}`);
      setTimeout(() => app.exit(code === 0 ? 0 : 1), 300);
    }
  });

  return { ok: true, out };
});

ipcMain.handle("stop", () => {
  stopRun();
  send({ type: "log", line: "stopped — state.json keeps completed chapters; Start resumes" });
  return { ok: true };
});

ipcMain.handle("chooseOut", async () => {
  const res = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle("openPath", async (_e, p) => {
  if (!p) return;
  if (fs.existsSync(p)) await shell.openPath(p);
});

ipcMain.handle("openExternal", async (_e, url) => {
  if (/^https?:\/\//.test(url || "")) await shell.openExternal(url);
});

// renderer errors arrive here because the UI runs without node integration
ipcMain.on("renderer-error", (_e, payload) => {
  if (!SENTRY_DSN) return;
  const err = new Error(payload?.message || "renderer error");
  if (payload?.stack) err.stack = payload.stack;
  Sentry.captureException(err, { tags: { stage: "renderer" } });
});

ipcMain.handle("library:list", () => scanAllOutDirs());

ipcMain.handle("library:import", (_e, dir) => {
  if (!dir) return loadLibrary();
  return mergeLibraryFrom(dir);
});

ipcMain.handle("library:track", async (_e, url, name, cover) => {
  if (!/^https?:\/\/(www\.)?comix\.to\/title\//.test(url || "")) return { error: "paste a comix.to title URL" };
  const lib = loadLibrary();
  const slug = (String(url).match(/\/title\/([^/?#]+)/) || [])[1] || String(url);
  const nameHint =
    (name && String(name).trim()) ||
    slug
      .replace(/^[a-z0-9]{3,8}-/i, "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  const key = libKey(nameHint);
  const cur = lib.titles[key] || { addedAt: Date.now(), read: false, score: null };
  lib.titles[key] = {
    ...cur,
    series: cur.series || nameHint,
    url,
    watching: true,
    ...(cover ? { cover } : {}),
  };
  saveLibrary(lib);

  // adding a title also resolves its status, so it lands in the right list
  if (child || statusCheckRunning) return lib;
  statusCheckRunning = true;
  try {
    const events = await fetchStatuses([url]);
    const fresh = await applyStatuses(events);
    send({ type: "libraryChanged" });
    return fresh;
  } catch {
    return lib;
  } finally {
    statusCheckRunning = false;
  }
});

ipcMain.handle("library:search", async (_e, query) => {
  if (child) return { error: "a download is running — try again when it finishes" };
  if (statusCheckRunning) return { error: "status check is running — try again in a moment" };
  const q = String(query || "").trim();
  if (!q) return { error: "type a title to search" };
  const events = await runChildCapture([path.join(ROOT, "comix-dl.mjs"), "--progress", "--search", q]);
  const hit = events.find((ev) => ev.type === "searchResults");
  if (!hit) return { error: "search failed" };
  return { results: hit.results || [] };
});

function runChildCapture(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    const events = [];
    const handle = (stream, isErr) => {
      let buf = "";
      stream.on("data", (d) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (line.startsWith("@@P ")) {
            try {
              events.push(JSON.parse(line.slice(4)));
            } catch {}
          } else if (line.trim()) {
            send({ type: "log", line, err: isErr });
          }
        }
      });
    };
    handle(p.stdout, false);
    handle(p.stderr, true);
    p.on("error", (err) => {
      send({ type: "log", line: `status check failed: ${err.message}`, err: true });
      resolve(events);
    });
    p.on("exit", () => resolve(events));
  });
}

let statusCheckRunning = false;
let epubRunning = false;

async function fetchStatuses(urls) {
  if (!urls.length) return [];
  const args = [path.join(ROOT, "comix-dl.mjs"), "--progress"];
  for (const u of urls) args.push("--status-check", u);
  const events = await runChildCapture(args);
  return events.filter((e) => e.type === "status");
}

async function applyStatuses(events) {
  const fresh = loadLibrary();
  for (const ev of events) {
    if (!ev.url) continue;
    const found = Object.entries(fresh.titles).find(([, t]) => t.url === ev.url);
    if (!found) continue;
    const [key, t] = found;
    const latest = ev.latestChapter != null && ev.latestChapter !== "" ? Number(ev.latestChapter) : null;
    const prev = typeof t.latestChapter === "number" ? t.latestChapter : null;
    const isNew = latest != null && prev != null && latest > prev;
    fresh.titles[key] = {
      ...t,
      ...(ev.series ? { series: ev.series } : {}),
      status: ev.status || t.status || null,
      ...(latest != null ? { latestChapter: latest } : {}),
      ...(isNew ? { newChapter: latest, newChapterAt: Date.now() } : {}),
      ...(ev.cover ? { cover: ev.cover } : {}),
      checkedAt: Date.now(),
    };
  }
  saveLibrary(fresh);
  return fresh;
}

// backfill covers for entries that predate cover scraping (also refreshes status)
ipcMain.handle("library:covers", async () => {
  if (child || statusCheckRunning) return { error: "busy — try again in a moment" };
  const lib = loadLibrary();
  const need = [
    ...new Set(
      Object.values(lib.titles)
        .filter((t) => t.url && (!t.cover || t.latestChapter == null))
        .map((t) => t.url),
    ),
  ];
  if (!need.length) return lib;
  statusCheckRunning = true;
  try {
    const events = await fetchStatuses(need);
    let fresh = await applyStatuses(events);
    // one retry for URLs whose page load hiccuped (metadata still unknown)
    const still = [
      ...new Set(
        Object.values(fresh.titles)
          .filter((t) => need.includes(t.url) && t.latestChapter == null)
          .map((t) => t.url),
      ),
    ];
    if (still.length) {
      const retry = await fetchStatuses(still);
      fresh = await applyStatuses(retry);
    }
    send({ type: "libraryChanged" });
    return fresh;
  } finally {
    statusCheckRunning = false;
  }
});

// imported folders have no comix URL, which disables every title-level feature;
// resolve them by exact-name search on comix, then fetch their metadata
function matchTitle(name, results) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const target = norm(name);
  if (!target) return null;
  const exact = results.find((r) => norm(r.title) === target);
  if (exact) return exact;
  const contains = results.filter((r) => norm(r.title).includes(target) || target.includes(norm(r.title)));
  if (contains.length === 1) return contains[0];
  if (results.length === 1) return results[0];
  return null;
}

ipcMain.handle("library:resolve", async () => {
  if (child || statusCheckRunning) return { error: "busy — try again in a moment" };
  const lib = loadLibrary();
  const missing = Object.values(lib.titles).filter((t) => !t.url && t.series);
  if (!missing.length) return lib;

  statusCheckRunning = true;
  try {
    const resolved = [];
    for (const t of missing) {
      const events = await runChildCapture([path.join(ROOT, "comix-dl.mjs"), "--progress", "--search", t.series]);
      const sr = events.find((e) => e.type === "searchResults");
      const pick = matchTitle(t.series, sr?.results || []);
      if (!pick) continue;
      const fresh = loadLibrary();
      const entry = Object.entries(fresh.titles).find(([, x]) => x.series === t.series && !x.url);
      if (!entry) continue;
      const [key, cur] = entry;
      fresh.titles[key] = { ...cur, url: pick.url, ...(pick.thumb ? { cover: pick.thumb } : {}) };
      saveLibrary(fresh);
      resolved.push(pick.url);
    }
    if (!resolved.length) return loadLibrary();
    const events = await fetchStatuses([...new Set(resolved)]);
    const finalLib = await applyStatuses(events);
    send({ type: "libraryChanged" });
    return finalLib;
  } finally {
    statusCheckRunning = false;
  }
});

ipcMain.handle("library:ack", (_e, key) => {
  const lib = loadLibrary();
  if (lib.titles[key]) {
    const { newChapter, newChapterAt, ...rest } = lib.titles[key];
    lib.titles[key] = rest;
    saveLibrary(lib);
  }
  return lib;
});

// build an EPUB from the chapters that completed (failed folders are skipped)
ipcMain.handle("epub:build", async (_e, dir, maxMb) => {
  if (child) return { error: "a download is running — try again when it finishes" };
  if (epubRunning) return { error: "an EPUB build is already running" };
  if (!dir || !fs.existsSync(dir)) return { error: "no completed chapters to build" };
  epubRunning = true;
  try {
    return await new Promise((resolve) => {
      const p = spawn(
        process.execPath,
        [path.join(ROOT, "comix-epub.mjs"), dir, "--max-mb", String(maxMb || 300), "--progress"],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
      );
      let buf = "";
      const onData = (d) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (line.startsWith("@@P ")) {
            try {
              send(JSON.parse(line.slice(4)));
            } catch {}
          } else if (line.trim()) {
            send({ type: "log", line, err: false });
          }
        }
      };
      p.stdout.on("data", onData);
      p.stderr.on("data", onData);
      p.on("error", (err) => resolve({ error: err.message }));
      p.on("exit", (code) => resolve({ code }));
    });
  } finally {
    epubRunning = false;
  }
});

ipcMain.handle("library:check-one", async (_e, key) => {
  if (child) return { error: "a download is running — try again when it finishes" };
  if (statusCheckRunning) return { error: "status check already running" };
  const lib = loadLibrary();
  const t = lib.titles[key];
  if (!t?.url) return { error: "no comix URL for this title" };
  statusCheckRunning = true;
  try {
    const events = await fetchStatuses([t.url]);
    const fresh = await applyStatuses(events);
    send({ type: "libraryChanged" });
    return fresh;
  } finally {
    statusCheckRunning = false;
  }
});

ipcMain.handle("library:remove", (_e, key) => {
  const lib = loadLibrary();
  if (lib.titles[key]) {
    delete lib.titles[key];
    saveLibrary(lib);
  }
  return lib;
});

ipcMain.handle("library:update", (_e, key, patch) => {
  const lib = loadLibrary();
  if (lib.titles[key]) {
    const clean = {};
    if (typeof patch?.read === "boolean") clean.read = patch.read;
    if (patch?.score === null) clean.score = null;
    else if (typeof patch?.score === "number" && patch.score >= 1 && patch.score <= 5) clean.score = patch.score;
    lib.titles[key] = { ...lib.titles[key], ...clean };
    saveLibrary(lib);
  }
  return lib;
});

app.whenReady().then(() => {
  createWindow();
  win.webContents.once("did-finish-load", () => {
    send({
      type: "log",
      line: SENTRY_DSN ? "sentry: on" : "sentry: off (add ~/.comix-dl/sentry.json with {\"dsn\": \"…\"})",
    });
    if (SMOKE) {
      win.webContents.send("autostart", {
        url: process.env.COMIX_SMOKE_URL,
        group: process.env.COMIX_SMOKE_GROUP || "Violet Scans",
        limit: Number(process.env.COMIX_SMOKE_LIMIT || 0),
        maxMb: Number(process.env.COMIX_SMOKE_MAXMB || 300),
        noEpub: process.env.COMIX_SMOKE_NOEPUB === "1",
        out: process.env.COMIX_SMOKE_OUT || path.join(app.getPath("downloads"), "comix-dl"),
      });
    }
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopRun();
  app.quit();
});

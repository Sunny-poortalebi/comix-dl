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

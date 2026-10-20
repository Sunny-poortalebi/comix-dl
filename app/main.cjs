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

  const out = cfg.out || path.join(os.homedir(), "Desktop", "Manhwa");
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

  const forward = (stream, isErr) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (line.startsWith("@@P ")) {
          try {
            send(JSON.parse(line.slice(4)));
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
        out: process.env.COMIX_SMOKE_OUT || path.join(os.homedir(), "Desktop", "Manhwa"),
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

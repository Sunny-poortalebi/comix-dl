// Renderer: renders NDJSON progress events from the CLI pipeline.

// forward UI errors to the main process → Sentry (no node integration here)
window.addEventListener("error", (e) =>
  window.api.reportError({ message: e.message, stack: e.error?.stack }),
);
window.addEventListener("unhandledrejection", (e) =>
  window.api.reportError({ message: String(e.reason), stack: e.reason?.stack }),
);

const $ = (id) => document.getElementById(id);
const els = {
  url: $("url"), group: $("group"), limit: $("limit"), maxMb: $("maxMb"), out: $("out"),
  noEpub: $("noEpub"), start: $("start"), stop: $("stop"), pickOut: $("pickOut"),
  openOut: $("openOut"), openEpub: $("openEpub"), clearLog: $("clearLog"),
  status: $("status"), seriesName: $("seriesName"), runCount: $("runCount"),
  overallFill: $("overallFill"), current: $("current"), pageFill: $("pageFill"),
  epubRow: $("epubRow"), epubFill: $("epubFill"), epubText: $("epubText"),
  chapters: $("chapters"), log: $("log"),
  tabDownload: $("tabDownload"), tabLibrary: $("tabLibrary"),
  viewDownload: $("viewDownload"), viewLibrary: $("viewLibrary"),
  libBody: $("libBody"), libEmpty: $("libEmpty"), libCount: $("libCount"), libRefresh: $("libRefresh"),
  libImport: $("libImport"),
  trackUrl: $("trackUrl"), trackBtn: $("trackBtn"), checkStatuses: $("checkStatuses"),
};

const st = {
  running: false, outDir: null, epubPath: null, series: null,
  picked: 0, queued: 0, done: 0, failed: 0, current: null, rows: new Map(),
};

function log(line, err = false) {
  const div = document.createElement("div");
  if (err) div.className = "err";
  div.textContent = line;
  els.log.appendChild(div);
  while (els.log.childElementCount > 600) els.log.removeChild(els.log.firstChild);
  els.log.scrollTop = els.log.scrollHeight;
}

function setStatus(text, cls = "") {
  els.status.textContent = text;
  els.status.className = `status ${cls}`;
}

function renderOverall() {
  const total = st.queued || 0;
  const finished = st.done + st.failed;
  els.overallFill.style.width = total ? `${Math.min(100, (finished / total) * 100)}%` : "0%";
  els.runCount.textContent = total ? `${finished}/${total} chapters` : "";
}

function chapterRow(num, group) {
  let row = st.rows.get(num);
  if (!row) {
    row = document.createElement("div");
    row.className = "ch";
    row.innerHTML = `<span class="name"></span><span class="grp"></span><span class="pg">—</span><span class="st">queued</span>`;
    row.querySelector(".name").textContent = `Ch${num}`;
    row.querySelector(".grp").textContent = group || "";
    els.chapters.appendChild(row);
    st.rows.set(num, row);
  }
  return row;
}

function currentBar(seen, total) {
  els.pageFill.style.width = total ? `${Math.min(100, (seen / total) * 100)}%` : "0%";
}

function onEvent(ev) {
  switch (ev.type) {
    case "log":
      log(ev.line, ev.err);
      break;
    case "series":
      st.series = ev.series;
      st.picked = ev.picked;
      st.queued = ev.queued;
      st.outDir = ev.out;
      els.seriesName.textContent = ev.series;
      els.out.value = els.out.value || ev.out;
      log(`series: ${ev.series} · ${ev.picked} chapters · ${ev.queued} to download`);
      renderOverall();
      break;
    case "chapterStart": {
      st.current = { num: ev.number, group: ev.group, seen: 0, total: 0, phase: "starting" };
      const row = chapterRow(ev.number, ev.group);
      row.querySelector(".st").textContent = "starting";
      row.querySelector(".st").className = "st work";
      els.current.textContent = `Ch${ev.number} (${ev.group}) — loading`;
      currentBar(0, 0);
      break;
    }
    case "chapterMeta":
      if (st.current) {
        st.current.total = ev.pages;
        els.current.textContent = `Ch${ev.number} — harvesting ${ev.pages} pages`;
        chapterRow(ev.number, ev.group).querySelector(".pg").textContent = ev.pages;
      }
      break;
    case "harvest":
      if (st.current) {
        st.current.seen = ev.seen;
        st.current.total = ev.total;
        els.current.textContent = `Ch${st.current.num} — harvesting ${ev.seen}/${ev.total} pages`;
        currentBar(ev.seen, ev.total);
      }
      break;
    case "download":
      if (st.current) {
        els.current.textContent = `Ch${st.current.num} — downloading ${ev.done}/${ev.total} pages`;
        currentBar(ev.done, ev.total);
      }
      break;
    case "chapterDone": {
      const row = chapterRow(ev.number);
      const stEl = row.querySelector(".st");
      stEl.textContent = ev.ok ? "done" : "failed";
      stEl.className = `st ${ev.ok ? "ok" : "bad"}`;
      if (ev.pages) row.querySelector(".pg").textContent = ev.pages;
      if (ev.ok) st.done++;
      else st.failed++;
      st.current = null;
      renderOverall();
      break;
    }
    case "retry":
      log(`retrying ${ev.count} failed chapter(s)`);
      break;
    case "index":
      if (ev.known > 0) log(`index: ${ev.known}/${ev.total} page URLs already known`);
      break;
    case "chapterPartial":
      log(`Ch${ev.number}: ${ev.missing} URL(s) missing — next run retries only those`, true);
      break;
    case "epubStart":
      els.epubRow.hidden = false;
      els.epubText.textContent = "encoding…";
      break;
    case "epubEncode":
      els.epubFill.style.width = ev.total ? `${(ev.done / ev.total) * 100}%` : "0%";
      els.epubText.textContent = `${ev.done}/${ev.total} pages · ${(ev.bytes / 1e6).toFixed(1)} MB`;
      break;
    case "epubReady":
      st.epubPath = ev.path;
      els.epubFill.style.width = "100%";
      els.epubText.textContent = `${(ev.bytes / 1e6).toFixed(1)} MB`;
      els.openEpub.disabled = false;
      log(`epub written: ${ev.path}`);
      break;
    case "runDone":
      log(ev.ok ? "run completed" : "run finished with failures");
      break;
    case "exit":
      st.running = false;
      els.start.disabled = false;
      els.stop.disabled = true;
      setStatus(ev.code === 0 ? "done" : "failed", ev.code === 0 ? "done" : "failed");
      els.current.textContent = ev.code === 0 ? "all done" : `exited with code ${ev.code}`;
      break;
  }
}

// --- library view -----------------------------------------------------------
const lib = { data: null, filter: "all" };

function showView(name) {
  const download = name === "download";
  els.viewDownload.hidden = !download;
  els.viewLibrary.hidden = download;
  els.tabDownload.classList.toggle("active", download);
  els.tabLibrary.classList.toggle("active", !download);
  if (!download) loadLibrary();
}

function fmtDate(ts) {
  try {
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function libraryRow(t) {
  const row = document.createElement("div");
  row.className = "librow";

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !!t.read;
  cb.title = t.read ? "mark as to read" : "mark as read";
  cb.addEventListener("change", () => updateTitle(t.key, { read: cb.checked }));

  const title = document.createElement("span");
  title.className = "title";
  title.textContent = t.series || t.key;
  if (t.url) {
    const small = document.createElement("small");
    small.textContent = t.url.replace(/^https?:\/\//, "");
    title.appendChild(small);
  }
  if (t.status || t.watching) {
    const badge = document.createElement("small");
    badge.className = `badge ${t.status === "FINISHED" ? "done" : t.status ? "ongoing" : ""}`;
    badge.textContent = t.status || "unchecked";
    title.appendChild(badge);
  }

  const stars = document.createElement("span");
  stars.className = "stars";
  for (let i = 1; i <= 5; i++) {
    const b = document.createElement("button");
    b.textContent = "★";
    b.title = `${i}/5${t.score === i ? " (click again to clear)" : ""}`;
    if ((t.score || 0) >= i) b.classList.add("on");
    b.addEventListener("click", () => updateTitle(t.key, { score: t.score === i ? null : i }));
    stars.appendChild(b);
  }

  const chapters = document.createElement("span");
  chapters.className = "meta";
  chapters.textContent = `${t.chaptersDone ?? 0}/${t.chaptersTotal ?? 0}`;

  const date = document.createElement("span");
  date.className = "meta";
  date.textContent = fmtDate(t.lastRunAt);

  const open = document.createElement("button");
  open.className = "ghost small";
  open.textContent = "epub";
  if (t.epubPath) {
    open.title = t.epubPath;
    open.addEventListener("click", () => window.api.openPath(t.epubPath));
  } else {
    open.disabled = true;
    open.title = "no EPUB built yet";
  }

  row.append(cb, title, stars, chapters, date, open);
  return row;
}

function renderLibrary() {
  const data = lib.data;
  if (!data) return;
  const all = Object.entries(data.titles || {}).map(([key, t]) => ({ key, ...t }));
  const entries = all
    .filter((t) =>
      lib.filter === "all"
        ? true
        : lib.filter === "read"
          ? !!t.read
          : lib.filter === "watching"
            ? !!t.watching
            : !t.read && !t.watching,
    )
    .sort((a, b) => (b.lastRunAt || 0) - (a.lastRunAt || 0));
  const readCount = all.filter((t) => t.read).length;
  const watchCount = all.filter((t) => t.watching).length;
  const toReadCount = all.filter((t) => !t.read && !t.watching).length;
  els.libCount.textContent = `${all.length} titles · ${readCount} read · ${toReadCount} to read · ${watchCount} incomplete`;
  els.libEmpty.hidden = entries.length > 0;
  els.libBody.innerHTML = "";
  for (const t of entries) els.libBody.appendChild(libraryRow(t));
}

async function loadLibrary() {
  try {
    lib.data = await window.api.libraryList();
  } catch {}
  renderLibrary();
}

async function updateTitle(key, patch) {
  try {
    lib.data = await window.api.libraryUpdate(key, patch);
  } catch {}
  renderLibrary();
}

async function start() {
  if (st.running) return;
  const cfg = {
    url: els.url.value.trim(),
    group: els.group.value.trim(),
    limit: Number(els.limit.value) || 0,
    maxMb: Number(els.maxMb.value) || 300,
    noEpub: els.noEpub.checked,
    out: els.out.value.trim() || null,
  };
  const res = await window.api.start(cfg);
  if (res.error) {
    log(res.error, true);
    setStatus("error", "failed");
    return;
  }
  st.running = true;
  st.done = 0; st.failed = 0; st.queued = 0; st.current = null; st.epubPath = null;
  st.rows.clear();
  els.chapters.innerHTML = "";
  els.epubRow.hidden = true;
  els.epubFill.style.width = "0%";
  els.openEpub.disabled = true;
  els.start.disabled = true;
  els.stop.disabled = false;
  els.overallFill.style.width = "0%";
  setStatus("running", "running");
  if (res.out) els.out.value = res.out;
  log(`started → ${res.out}`);
}

els.start.addEventListener("click", start);
els.stop.addEventListener("click", () => window.api.stop());
els.tabDownload.addEventListener("click", () => showView("download"));
els.tabLibrary.addEventListener("click", () => showView("library"));
document.querySelectorAll(".chip").forEach((c) =>
  c.addEventListener("click", () => {
    lib.filter = c.dataset.filter;
    document.querySelectorAll(".chip").forEach((x) => x.classList.toggle("active", x === c));
    renderLibrary();
  }),
);
els.libRefresh.addEventListener("click", loadLibrary);
els.libImport.addEventListener("click", async () => {
  const dir = await window.api.chooseOut();
  if (!dir) return;
  try {
    lib.data = await window.api.libraryImport(dir);
  } catch {}
  renderLibrary();
});
els.trackBtn.addEventListener("click", async () => {
  const res = await window.api.libraryTrack(els.trackUrl.value.trim());
  if (res?.error) return log(res.error, true);
  lib.data = res;
  els.trackUrl.value = "";
  renderLibrary();
  log("tracked — press “check status” to fetch its release status");
});
els.checkStatuses.addEventListener("click", async () => {
  els.checkStatuses.disabled = true;
  const res = await window.api.libraryCheck();
  els.checkStatuses.disabled = false;
  if (res?.error) return log(res.error, true);
  lib.data = res;
  renderLibrary();
  log("status check complete");
});
els.pickOut.addEventListener("click", async () => {
  const dir = await window.api.chooseOut();
  if (dir) els.out.value = dir;
});
els.openOut.addEventListener("click", () => window.api.openPath(st.outDir || els.out.value));
els.openEpub.addEventListener("click", () => window.api.openPath(st.epubPath));
els.clearLog.addEventListener("click", () => (els.log.innerHTML = ""));

window.api.onProgress(onEvent);
window.api.onLibraryChanged(() => loadLibrary());
window.api.onAutostart((cfg) => {
  els.url.value = cfg.url || "";
  els.group.value = cfg.group || "Violet Scans";
  els.limit.value = cfg.limit ?? 0;
  els.maxMb.value = cfg.maxMb ?? 300;
  els.noEpub.checked = !!cfg.noEpub;
  if (cfg.out) els.out.value = cfg.out;
  start();
});

els.out.value = "";
log("ready — paste a comix.to title URL and press Start");
loadLibrary();

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
els.pickOut.addEventListener("click", async () => {
  const dir = await window.api.chooseOut();
  if (dir) els.out.value = dir;
});
els.openOut.addEventListener("click", () => window.api.openPath(st.outDir || els.out.value));
els.openEpub.addEventListener("click", () => window.api.openPath(st.epubPath));
els.clearLog.addEventListener("click", () => (els.log.innerHTML = ""));

window.api.onProgress(onEvent);
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

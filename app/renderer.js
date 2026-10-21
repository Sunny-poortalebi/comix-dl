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
  trackUrl: $("trackUrl"), trackBtn: $("trackBtn"), searchResults: $("searchResults"),
  libSort: $("libSort"),
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
const lib = {
  data: null,
  filter: "all",
  sort: localStorage.getItem("libSort") || "lastRun",
  view: localStorage.getItem("libView") || "list",
  coverFetchStarted: false,
  resolveStarted: false,
  metaFetchStarted: false,
};

function showView(name) {
  const download = name === "download";
  els.viewDownload.hidden = !download;
  els.viewLibrary.hidden = download;
  els.tabDownload.classList.toggle("active", download);
  els.tabLibrary.classList.toggle("active", !download);
  if (!download) loadLibrary();
}

// imported folders have no URL; link them on demand so every feature works
async function maybeResolveLinks(force = false) {
  if (!lib.data || (lib.resolveStarted && !force)) return;
  const missing = Object.values(lib.data.titles || {}).filter((t) => !t.url && t.series);
  if (!missing.length) return;
  lib.resolveStarted = true;
  log(`linking ${missing.length} imported title(s) to comix…`);
  const res = await window.api.libraryResolve();
  if (res?.error) return log(res.error, true);
  lib.data = res;
  renderLibrary();
  log("title linking complete");
}

// entries linked before latest-chapter support have no total; fetch on demand
async function backfillMetadata(force = false) {
  if (!lib.data || (lib.metaFetchStarted && !force)) return;
  const missing = Object.values(lib.data.titles || {}).filter(
    (t) => t.url && (t.latestChapter == null || !t.cover),
  );
  if (!missing.length) return;
  lib.metaFetchStarted = true;
  log(`fetching metadata for ${missing.length} title(s)…`);
  const res = await window.api.libraryCovers();
  if (res?.error) return log(res.error, true);
  lib.data = res;
  renderLibrary();
  log("metadata refresh complete");
}

// downloaded / available, where available is the latest chapter on comix
// (the folder index only knows what was actually downloaded)
function chapterLabel(t) {
  const available = Math.max(Number(t.latestChapter) || 0, Number(t.chaptersTotal) || 0);
  return `${t.chaptersDone ?? 0}/${available || 0}`;
}

// most relevant date: download run, else last status check, else when added
const activityAt = (t) => t.lastRunAt || t.checkedAt || t.addedAt || 0;

function fmtDate(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "—";
  try {
    return new Date(n).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "—";
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
  const nameRow = document.createElement("span");
  nameRow.className = "titlerow";
  const nameText = document.createElement("span");
  nameText.textContent = t.series || t.key;
  nameRow.appendChild(nameText);
  if (t.url) {
    const link = document.createElement("button");
    link.className = "comixlink";
    link.textContent = "↗";
    link.title = `open on comix.to — ${t.url}`;
    link.addEventListener("click", (e) => {
      e.stopPropagation();
      window.api.openExternal(t.url);
    });
    nameRow.appendChild(link);
  }
  if (t.newChapter) {
    const nb = document.createElement("button");
    nb.className = "badge new";
    nb.textContent = `NEW Ch.${t.newChapter}`;
    nb.title = "chapters appeared since the last check — click to dismiss";
    nb.addEventListener("click", async (e) => {
      e.stopPropagation();
      const res = await window.api.libraryAck(t.key);
      if (res?.error) return log(res.error, true);
      lib.data = res;
      renderLibrary();
    });
    nameRow.appendChild(nb);
  }
  title.appendChild(nameRow);
  if (t.status || t.watching) {
    const s = (t.status || "").toUpperCase();
    const cls =
      s === "FINISHED"
        ? "done"
        : s === "HIATUS"
          ? "hiatus"
          : s === "CANCELLED" || s === "CANCELED"
            ? "cancelled"
            : s
              ? "ongoing"
              : "";
    const badge = document.createElement("small");
    badge.className = `badge ${cls}`;
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
  chapters.textContent = chapterLabel(t);
  chapters.title = "downloaded / available (latest chapter on comix)";

  const date = document.createElement("span");
  date.className = "meta";
  date.textContent = fmtDate(activityAt(t));
  date.title = t.lastRunAt ? "last download run" : t.checkedAt ? "last status check" : "added to library";

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

  const del = document.createElement("button");
  del.className = "ghost small del";
  del.textContent = "×";
  del.title = "remove from library (files stay on disk)";
  del.addEventListener("click", async () => {
    if (!window.confirm(`Remove “${t.series || t.key}” from the library?\nFiles on disk are not touched.`)) return;
    const res = await window.api.libraryRemove(t.key);
    if (res?.error) return log(res.error, true);
    lib.data = res;
    renderLibrary();
  });

  const actions = document.createElement("span");
  actions.className = "rowactions";
  // any title with a URL can be re-checked on demand
  if (t.url) {
    const refresh = document.createElement("button");
    refresh.className = "ghost small";
    refresh.textContent = "↻";
    refresh.title = "check status now";
    refresh.addEventListener("click", async () => {
      refresh.disabled = true;
      const res = await window.api.libraryCheckOne(t.key);
      refresh.disabled = false;
      if (res?.error) return log(res.error, true);
      lib.data = res;
      renderLibrary();
      log(`status updated: ${t.series || t.key}`);
    });
    actions.append(refresh);
  }
  actions.append(open, del);

  row.append(cb, title, stars, chapters, date, actions);
  return row;
}

function renderLibrary() {
  const data = lib.data;
  if (!data) return;
  const isFinished = (t) => (t.status || "").toUpperCase() === "FINISHED";
  const sorters = {
    lastRun: (a, b) => activityAt(b) - activityAt(a),
    addedDesc: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
    addedAsc: (a, b) => (a.addedAt || 0) - (b.addedAt || 0),
    scoreDesc: (a, b) => (b.score ?? -1) - (a.score ?? -1) || (b.addedAt || 0) - (a.addedAt || 0),
    scoreAsc: (a, b) => (a.score ?? 6) - (b.score ?? 6) || (b.addedAt || 0) - (a.addedAt || 0),
  };
  const all = Object.entries(data.titles || {}).map(([key, t]) => ({ key, ...t }));
  const entries = all
    .filter((t) =>
      lib.filter === "all"
        ? true
        : lib.filter === "read"
          ? !!t.read
          : lib.filter === "ongoing"
            ? !!t.watching && !isFinished(t)
            : !t.read && (!t.watching || isFinished(t)),
    )
    .sort(sorters[lib.sort] || sorters.lastRun);
  const readCount = all.filter((t) => t.read).length;
  const toReadCount = all.filter((t) => !t.read && (!t.watching || isFinished(t))).length;
  const ongoingCount = all.filter((t) => t.watching && !isFinished(t)).length;
  els.libCount.textContent = `${all.length} titles · ${readCount} read · ${toReadCount} to read · ${ongoingCount} ongoing`;
  els.libEmpty.hidden = entries.length > 0;
  els.libBody.className = lib.view === "covers" ? "lib-body libgrid" : "lib-body";
  els.libBody.closest(".library").classList.toggle("covers", lib.view === "covers");
  els.libBody.innerHTML = "";

  if (lib.view === "covers") {
    for (const t of entries) els.libBody.appendChild(coverCard(t));
  } else {
    for (const t of entries) els.libBody.appendChild(libraryRow(t));
  }
}

function coverCard(t) {
  const card = document.createElement("div");
  card.className = "libcard";

  const wrap = document.createElement("div");
  wrap.className = "coverwrap";
  if (t.cover) {
    const img = document.createElement("img");
    img.className = "cover";
    img.src = t.cover;
    img.alt = "";
    img.loading = "lazy";
    wrap.appendChild(img);
  } else {
    const ph = document.createElement("div");
    ph.className = "cover placeholder";
    ph.textContent = (t.series || t.key || "?").slice(0, 1).toUpperCase();
    wrap.appendChild(ph);
  }
  const read = document.createElement("label");
  read.className = "readcheck";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !!t.read;
  cb.addEventListener("change", () => updateTitle(t.key, { read: cb.checked }));
  read.append(cb, document.createTextNode("read"));
  wrap.appendChild(read);

  const title = document.createElement("div");
  title.className = "cardtitle";
  title.textContent = t.series || t.key;

  const meta = document.createElement("div");
  meta.className = "cardmeta";
  const s = (t.status || "").toUpperCase();
  const badge = document.createElement("span");
  badge.className = `badge ${
    s === "FINISHED"
      ? "done"
      : s === "HIATUS"
        ? "hiatus"
        : s === "CANCELLED" || s === "CANCELED"
          ? "cancelled"
          : s
            ? "ongoing"
            : ""
  }`;
  badge.textContent = t.status || "unchecked";
  const ch = document.createElement("span");
  ch.textContent = chapterLabel(t);
  ch.title = "downloaded / available (latest chapter on comix)";
  meta.append(badge, ch);
  if (t.newChapter) {
    const nb = document.createElement("button");
    nb.className = "badge new";
    nb.textContent = `NEW Ch.${t.newChapter}`;
    nb.title = "chapters appeared since the last check — click to dismiss";
    nb.addEventListener("click", async () => {
      const res = await window.api.libraryAck(t.key);
      if (res?.error) return log(res.error, true);
      lib.data = res;
      renderLibrary();
    });
    meta.appendChild(nb);
  }

  const stars = document.createElement("span");
  stars.className = "stars";
  for (let i = 1; i <= 5; i++) {
    const b = document.createElement("button");
    b.textContent = "★";
    if ((t.score || 0) >= i) b.classList.add("on");
    b.addEventListener("click", () => updateTitle(t.key, { score: t.score === i ? null : i }));
    stars.appendChild(b);
  }

  const actions = document.createElement("div");
  actions.className = "cardactions";
  if (t.url) {
    const refresh = document.createElement("button");
    refresh.className = "ghost small";
    refresh.textContent = "↻";
    refresh.title = "check status now";
    refresh.addEventListener("click", async () => {
      refresh.disabled = true;
      const res = await window.api.libraryCheckOne(t.key);
      refresh.disabled = false;
      if (res?.error) return log(res.error, true);
      lib.data = res;
      renderLibrary();
    });
    actions.appendChild(refresh);
  }
  const epub = document.createElement("button");
  epub.className = "ghost small";
  epub.textContent = "epub";
  if (t.epubPath) {
    epub.title = t.epubPath;
    epub.addEventListener("click", () => window.api.openPath(t.epubPath));
  } else {
    epub.disabled = true;
    epub.title = "no EPUB built yet";
  }
  actions.appendChild(epub);
  if (t.url) {
    const visit = document.createElement("button");
    visit.className = "comixlink";
    visit.textContent = "↗";
    visit.title = `open on comix.to — ${t.url}`;
    visit.addEventListener("click", () => window.api.openExternal(t.url));
    actions.appendChild(visit);
  }
  const del = document.createElement("button");
  del.className = "ghost small del";
  del.textContent = "×";
  del.title = "remove from library (files stay on disk)";
  del.addEventListener("click", async () => {
    if (!window.confirm(`Remove “${t.series || t.key}” from the library?\nFiles on disk are not touched.`)) return;
    const res = await window.api.libraryRemove(t.key);
    if (res?.error) return log(res.error, true);
    lib.data = res;
    renderLibrary();
  });
  actions.appendChild(del);

  card.append(wrap, title, meta, stars, actions);
  return card;
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

function renderSearchResults(results) {
  const box = els.searchResults;
  box.innerHTML = "";
  if (!results?.length) {
    box.hidden = true;
    return;
  }
  const head = document.createElement("div");
  head.className = "srhead";
  const label = document.createElement("span");
  label.textContent = "Results";
  const close = document.createElement("button");
  close.className = "ghost small";
  close.textContent = "×";
  close.title = "close results";
  close.addEventListener("click", () => {
    box.hidden = true;
  });
  head.append(label, close);
  box.appendChild(head);
  for (const r of results) {
    const row = document.createElement("div");
    row.className = "srrow";

    if (r.thumb) {
      const thumb = document.createElement("img");
      thumb.className = "srthumb";
      thumb.src = r.thumb;
      thumb.alt = "";
      thumb.loading = "lazy";
      row.appendChild(thumb);
    }

    const info = document.createElement("span");
    info.className = "srinfo";
    const title = document.createElement("span");
    title.className = "sr-title";
    title.textContent = r.title;

    const add = document.createElement("button");
    add.className = "ghost small";
    add.textContent = "track";
    add.addEventListener("click", async () => {
      add.disabled = true;
      add.textContent = "…";
      const res = await window.api.libraryTrack(r.url, r.title, r.thumb);
      if (res?.error) return log(res.error, true);
      lib.data = res;
      box.hidden = true;
      els.trackUrl.value = "";
      renderLibrary();
      const entry = Object.values(lib.data.titles).find((t) => t.url === r.url);
      log(`tracked ${r.title}${entry?.status ? ` — ${entry.status}` : ""}`);
    });

    const meta = document.createElement("span");
    meta.className = "sr-meta";
    meta.textContent = r.meta || r.type || "";
    info.append(title, meta);
    row.append(info, add);
    box.appendChild(row);
  }
  box.hidden = false;
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
document.querySelectorAll(".chip[data-filter]").forEach((c) =>
  c.addEventListener("click", () => {
    lib.filter = c.dataset.filter;
    document.querySelectorAll(".chip[data-filter]").forEach((x) => x.classList.toggle("active", x === c));
    renderLibrary();
  }),
);
document.querySelectorAll("[data-libview]").forEach((b) => {
  b.classList.toggle("active", b.dataset.libview === lib.view);
  b.addEventListener("click", () => {
    lib.view = b.dataset.libview;
    localStorage.setItem("libView", lib.view);
    document.querySelectorAll("[data-libview]").forEach((x) => x.classList.toggle("active", x === b));
    renderLibrary();
  });
});
els.libSort.value = lib.sort;
els.libSort.addEventListener("change", () => {
  lib.sort = els.libSort.value;
  localStorage.setItem("libSort", lib.sort);
  renderLibrary();
});
els.libRefresh.addEventListener("click", async () => {
  await loadLibrary();
  // explicit action: may open the browser to link titles / fetch metadata
  await maybeResolveLinks(true);
  await backfillMetadata(true);
});
els.libImport.addEventListener("click", async () => {
  const dir = await window.api.chooseOut();
  if (!dir) return;
  try {
    lib.data = await window.api.libraryImport(dir);
  } catch {}
  renderLibrary();
});
async function submitTrack() {
  const value = els.trackUrl.value.trim();
  if (!value) return;
  els.trackBtn.disabled = true;
  els.trackBtn.textContent = "…";
  try {
    if (/^https?:\/\//.test(value)) {
      const res = await window.api.libraryTrack(value);
      if (res?.error) return log(res.error, true);
      lib.data = res;
      els.trackUrl.value = "";
      renderLibrary();
      log("tracked — status resolved");
      return;
    }
    const res = await window.api.librarySearch(value);
    if (res?.error) return log(res.error, true);
    renderSearchResults(res.results);
    log(`${res.results.length} result(s) for “${value}”`);
  } finally {
    els.trackBtn.disabled = false;
    els.trackBtn.textContent = "track";
  }
}
els.trackBtn.addEventListener("click", submitTrack);
els.trackUrl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    submitTrack();
  }
});
els.trackUrl.addEventListener("input", () => {
  if (!els.trackUrl.value.trim()) els.searchResults.hidden = true;
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

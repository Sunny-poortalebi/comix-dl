const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  start: (cfg) => ipcRenderer.invoke("start", cfg),
  stop: () => ipcRenderer.invoke("stop"),
  chooseOut: () => ipcRenderer.invoke("chooseOut"),
  openPath: (p) => ipcRenderer.invoke("openPath", p),
  openExternal: (url) => ipcRenderer.invoke("openExternal", url),
  onProgress: (cb) => ipcRenderer.on("progress", (_e, ev) => cb(ev)),
  onAutostart: (cb) => ipcRenderer.on("autostart", (_e, cfg) => cb(cfg)),
  reportError: (payload) => ipcRenderer.send("renderer-error", payload),
  libraryList: () => ipcRenderer.invoke("library:list"),
  libraryUpdate: (key, patch) => ipcRenderer.invoke("library:update", key, patch),
  libraryRemove: (key) => ipcRenderer.invoke("library:remove", key),
  libraryImport: (dir) => ipcRenderer.invoke("library:import", dir),
  libraryTrack: (url, name) => ipcRenderer.invoke("library:track", url, name),
  librarySearch: (query) => ipcRenderer.invoke("library:search", query),
  libraryCheckOne: (key) => ipcRenderer.invoke("library:check-one", key),
  onLibraryChanged: (cb) => ipcRenderer.on("libraryChanged", () => cb()),
});

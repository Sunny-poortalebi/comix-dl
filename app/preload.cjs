const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  start: (cfg) => ipcRenderer.invoke("start", cfg),
  stop: () => ipcRenderer.invoke("stop"),
  chooseOut: () => ipcRenderer.invoke("chooseOut"),
  openPath: (p) => ipcRenderer.invoke("openPath", p),
  onProgress: (cb) => ipcRenderer.on("progress", (_e, ev) => cb(ev)),
  onAutostart: (cb) => ipcRenderer.on("autostart", (_e, cfg) => cb(cfg)),
  reportError: (payload) => ipcRenderer.send("renderer-error", payload),
});

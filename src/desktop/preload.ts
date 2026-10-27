import { contextBridge, ipcRenderer } from "electron";
import type { DashboardBridge } from "../shared/contracts";
const invoke = (name: string, ...args: unknown[]) =>
  ipcRenderer.invoke(`reels:${name}`, ...args);
const subscribe = (name: string, callback: (value: any) => void) => {
  const listener = (_event: Electron.IpcRendererEvent, value: unknown) =>
    callback(value);
  ipcRenderer.on(name, listener);
  return () => {
    ipcRenderer.removeListener(name, listener);
  };
};
const bridge: DashboardBridge = {
  mode: process.argv.includes("--reels-demo") ? "demo" : "desktop",
  request: (method, args = {}) => invoke("request", method, args),
  editor: {
    runtime: () => invoke("editor:runtime"),
    chooseVideo: () => invoke("editor:chooseVideo"),
    fromPhotos: (s) => invoke("editor:fromPhotos", s),
    list: () => invoke("editor:list"),
    load: (id) => invoke("editor:load", id),
    save: (p) => invoke("editor:save", p),
    preview: (p, t, k) => invoke("editor:preview", p, t, k),
    export: (p) => invoke("editor:export", p),
    job: (id) => invoke("editor:job", id),
    cancel: (id) => invoke("editor:cancel", id),
    reveal: (id) => invoke("editor:reveal", id),
  },
  agent: {
    reportContext: (context) => invoke("agent:context", context),
    onProjectChanged: (callback) =>
      subscribe("agent:project-changed", callback),
    onProjectOpened: (callback) => subscribe("agent:project-opened", callback),
    onRenderStarted: (callback) => subscribe("agent:render-started", callback),
  },
  saveDocument: (name, data) => invoke("saveDocument", name, data),
  openDocument: () => invoke("openDocument"),
  chooseDestination: () => invoke("chooseDestination"),
  imageURL: (p) => invoke("imageURL", p),
  loadDashboard: () => invoke("loadDashboard"),
  saveDashboard: (value) => invoke("saveDashboard", value),
  exportSnapshot: () => invoke("exportSnapshot"),
  syncSnapshot: (url, token) => invoke("syncSnapshot", url, token),
};
contextBridge.exposeInMainWorld("reels", bridge);

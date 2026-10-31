import { contextBridge, ipcRenderer } from "electron";
import type { DashboardBridge } from "../shared/contracts";
import type { WorkbenchBridge } from "../shared/workbench";
import { DEVELOPMENT_MODE_ARGUMENT } from "./development-mode";
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
const workbench: WorkbenchBridge = {
  state: () => invoke("workbench:state"),
  chooseWorkspace: () => invoke("workbench:chooseWorkspace"),
  start: (input) => invoke("workbench:start", input),
  snapshot: (id) => invoke("workbench:snapshot", id),
  write: (id, data) => invoke("workbench:write", id, data),
  resize: (id, cols, rows) => invoke("workbench:resize", id, cols, rows),
  stop: (id) => invoke("workbench:stop", id),
  remove: (id) => invoke("workbench:remove", id),
  close: (id) => invoke("workbench:close", id),
  hideWindow: () => invoke("workbench:hideWindow"),
  openPreview: () => invoke("workbench:openPreview"),
  onEvent: (callback) => subscribe("workbench:event", callback),
  onShortcut: (callback) => subscribe("workbench:shortcut", callback),
};
const bridge: DashboardBridge = {
  routeMap: { load: (id) => invoke("routeMap:load", id) },
  cardNews: {
    preview: (plan) => invoke("cardNews:preview", plan),
    list: () => invoke("cardNews:list"),
    load: (id) => invoke("cardNews:load", id),
    save: (plan) => invoke("cardNews:save", plan),
    chooseAsset: (kind) => invoke("cardNews:chooseAsset", kind),
    export: (plan, frames) => invoke("cardNews:export", plan, frames),
    job: (id) => invoke("cardNews:job", id),
    cancel: (id) => invoke("cardNews:cancel", id),
    reveal: (id) => invoke("cardNews:reveal", id),
  },
  ...(process.argv.includes(DEVELOPMENT_MODE_ARGUMENT) ? { workbench } : {}),
  mobileBriefing: {
    status: () => invoke("mobileBriefing:status"),
    open: () => invoke("mobileBriefing:open"),
  },
  mode: process.argv.includes("--reels-demo") ? "demo" : "desktop",
  contentMedia: {
    list: (id, folder, offset) =>
      invoke("contentMedia:list", id, folder, offset),
    thumbnail: (id, file) => invoke("contentMedia:thumbnail", id, file),
    open: (id, file) => invoke("contentMedia:open", id, file),
  },
  request: (method, args = {}) => invoke("request", method, args),
  editor: {
    runtime: () => invoke("editor:runtime"),
    chooseVideo: () => invoke("editor:chooseVideo"),
    fromPhotos: (s) => invoke("editor:fromPhotos", s),
    list: () => invoke("editor:list"),
    load: (id) => invoke("editor:load", id),
    save: (p) => invoke("editor:save", p),
    preview: (p, t, k) => invoke("editor:preview", p, t, k),
    export: (p, target) => invoke("editor:export", p, target),
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
  projects: {
    merge: input => invoke("projects:merge", input),
    linkEdit: input => invoke("projects:linkEdit", input),
    listEdits: () => invoke("projects:listEdits"),
  },
  loadDashboard: () => invoke("loadDashboard"),
  saveDashboard: (value, revision) => invoke("saveDashboard", value, revision),
  onDashboardChanged: (callback) => subscribe("dashboard:changed", callback),
  revealResource: (id, resource) => invoke("revealResource", id, resource),
  exportSnapshot: () => invoke("exportSnapshot"),
  syncSnapshot: (url, token) => invoke("syncSnapshot", url, token),
};
contextBridge.exposeInMainWorld("reels", bridge);

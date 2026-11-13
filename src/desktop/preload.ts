import { contextBridge, ipcRenderer } from "electron";
import type { DashboardBridge } from "../shared/contracts";
import { createWorkbenchBridge } from "./workbench-bridge";
import { DEVELOPMENT_MODE_ARGUMENT } from "./development-mode";
import { DEV_BUILD_ARGUMENT } from "./build-identity";
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
const workbench = createWorkbenchBridge(ipcRenderer);
const bridge: DashboardBridge = {
  instagramInsights: {
    get: input => invoke("instagram:get", input),
    connect: input => invoke("instagram:connect", input),
    refresh: () => invoke("instagram:refresh"),
    setTopics: input => invoke("instagram:topics", input),
    onChanged: callback => subscribe("instagram:changed", callback),
  },
  planning: { get: () => invoke("planning:get"), update: input => invoke("planning:update", input) },
  executionLogs: { list: () => invoke("executionLogs:list") },
  workflow: {
    request: (action, input) => invoke("workflow:request", action, input),
    hostStatus: () => invoke("workflow:hostStatus"),
    onOpen: (callback) => {
      let active = true;
      let delivered = 0;
      const take = () => void invoke("workflow:pendingOpen").then((request) => {
        if (!active || !request || typeof request.runId !== "string" || request.sequence <= delivered) return;
        delivered = request.sequence;
        callback(request.runId);
        void invoke("workflow:ackOpen", request.sequence).catch(() => {});
      }).catch(() => {});
      const unsubscribe = subscribe("workflow:open", take);
      take();
      return () => { active = false; unsubscribe(); };
    },
  },
  blog: { canonicalProjects: () => invoke("blog:canonicalProjects"), canonicalIssues: () => invoke("blog:canonicalIssues"), openCanonical: id => invoke("blog:openCanonical", id), closeCanonical: id => invoke("blog:closeCanonical", id), extract: input => invoke("blog:extract", input), extractDirectory: () => invoke("blog:extractDirectory"), chooseExtractDirectory: () => invoke("blog:chooseExtractDirectory"), onExtractProgress: callback => subscribe("blog:extract-progress", callback), onResultsChanged: callback => subscribe("blog:results-changed", callback), removeResult: id => invoke("blog:removeResult", id), results: () => invoke("blog:results"), addResult: () => invoke("blog:addResult"), readResult: id => invoke("blog:readResult", id), previewResult: id => invoke("blog:previewResult", id), readDocument: (id, file) => invoke("blog:readDocument", id, file), load: id => invoke("blog:load", id), save: draft => invoke("blog:save", draft) },
  analysis: {
    mosaicSample: (projectId, sampleId) => invoke("analysis:mosaicSample", projectId, sampleId),
    mosaicExport: (input) => invoke("analysis:mosaicExport", input),
    providers: () => invoke("analysis:providers"),
    start: (v) => invoke("analysis:start", v),
    search: (v) => invoke("analysis:search", v),
    correct: (v) => invoke("analysis:correct", v),
  },
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
  devBuild: process.argv.includes(DEV_BUILD_ARGUMENT),
  contentMedia: {
    list: (id, folder, offset) =>
      invoke("contentMedia:list", id, folder, offset),
    thumbnail: (id, file) => invoke("contentMedia:thumbnail", id, file),
    text: (id, file) => invoke("contentMedia:text", id, file),
    open: (id, file, options) => invoke("contentMedia:open", id, file, options),
    gif: (id, file) => invoke("contentMedia:gif", id, file),
  },
  terminalSetting: {
    get: () => invoke("terminal-setting:get"),
    set: (enabled) => invoke("terminal-setting:set", enabled),
    relaunch: () => invoke("terminal-setting:relaunch"),
  },
  coverPreferences: { get: () => invoke("cover-preferences:get"), set: input => invoke("cover-preferences:set", input) },
  clipUpload: { create: input => invoke("clip-upload:create", input) },
  icloud: {
    configure: input => invoke("icloud:configure", input),
    list: () => invoke("icloud:list"),
    status: paths => invoke("icloud:status", { paths }),
    start: input => invoke("icloud:start", input),
    get: id => invoke("icloud:get", id),
    readiness: input => invoke("icloud:readiness", input),
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
    playbackCopy: (id) => invoke("editor:playbackCopy", id),
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

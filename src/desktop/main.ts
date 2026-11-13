import { CoverPreferencesStore } from "../shared/lib/cover-preferences";
import { PlanningStore } from "../shared/lib/planning-store";
import { InstagramInsightsStore } from "../shared/lib/instagram-insights-store";
import { instagramConnectionInput } from "../shared/instagram-insights";
import {InputFormWindows} from "./input-form-window";
import { sha256Hex } from "../shared/lib/hash";
import { ExecutionLogs } from "../shared/lib/execution-logs";
import { CANONICAL_EDITOR_HELP_URL, DesktopCanonicalEditor } from "./canonical-editor";
import { BlogResults } from "./blog-results";
import { demoMaterializer } from "./demo-photos-materializer";
import { BlogComments } from "./blog-comments";
import { workflowRequest } from "../app/workflow/client";
import { workflowAction, type WorkflowAction } from "../shared/workflow";
import { DesktopWorkflowHost } from "./workflow-host";
import { liveWindow, ShutdownSequence } from "./shutdown";
import { WorkflowNotifications } from "./workflow-notifications";
import { BlogExtractor } from "./blog-extractor";
import { MediaAnalysis } from "./media-analysis";
import { BlogLibrary } from "./blog-library";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  protocol,
  nativeImage,
  Notification,
} from "electron";
import path from "node:path";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { syncSnapshot } from "./sync";
import { Workbench, PREVIEW_URL } from "./workbench";
import { TerminalSettingStore, resolveTerminalSetting } from "./terminal-setting";
import { DEFAULT_KEYMAP, matchAction, type KeyAction } from "../shared/keymap";
import { trustedIpcSender } from "./ipc-trust";
import {
  developmentModeEnabled,
  DEVELOPMENT_MODE_ARGUMENT,
} from "./development-mode";
import { readMobileBriefingStatus } from "./mobile-briefing";
import { installApplicationIdentity } from "./application-identity";
import { installCli } from "./cli-install";
import { APP_NAME, DEV_BUILD_ARGUMENT, appDisplayName } from "./build-identity";
import { connectAgent } from "../app/automation";
import { AgentSession } from "../entities/agent-session";
import { ContentLibrary, BoardMedia, ICloudDelivery, ClipUpload } from "../features/content-library";
import { GifConverter } from "../features/gif-convert";
import { icloudStatusInput, type ICloudUploadStatus } from "../shared/icloud-delivery";
import { EditorService, type BundleAsset, type MaterializedMedia } from "../features/reel-editing";
import { RouteLibrary } from "./route-library";
import { CardNewsService } from "./card-news";
import type { EditorBridge } from "../shared/editor";
import { NativeClient, validateRequest } from "./native";
import {
  LocalStore,
  resolveGrantedFile,
  safeDocumentName,
} from "../shared/lib/storage";
import { toSnapshot } from "../shared/data";
import type { Arguments, Inspection } from "../shared/contracts";
import { createDemoBridge } from "../shared/demo";
if (process.env.REELS_USER_DATA)
  app.setPath("userData", path.resolve(process.env.REELS_USER_DATA));
app.setName(APP_NAME);
// Unpackaged source builds show "Reels Dashboard Dev". Pin the userData path
// resolved under the original name first so the rename never moves app data
// or the single-instance lock.
const displayName = appDisplayName(app.isPackaged);
if (displayName !== APP_NAME) {
  const userData = app.getPath("userData");
  app.setName(displayName);
  app.setPath("userData", userData);
}
const backgroundQA = process.env.REELS_BACKGROUND_QA === "1";
if (backgroundQA && process.platform === "darwin")
  app.setActivationPolicy("accessory");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "reels-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);
let window: BrowserWindow;
/**
 * Host-scope actions (HOST_ACTIONS) are matched here in the main process, not by
 * a renderer keydown listener as upstream workdesk does: the cross-origin preview
 * iframe, the blog tab's embedded editor and xterm hold keyboard focus, so the top
 * renderer would never see these keys. Only the trusted top renderer receives the
 * action name; renderer-scope actions are left to it.
 */
function forwardHostShortcuts(
  contents: Electron.WebContents,
  send: (action: KeyAction) => void,
) {
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const action = matchAction(
      DEFAULT_KEYMAP,
      {
        code: input.code,
        metaKey: input.meta,
        ctrlKey: input.control,
        altKey: input.alt,
        shiftKey: input.shift,
        isComposing: input.isComposing,
      },
      "host",
    );
    if (!action) return;
    // Suppress native menu/iframe/xterm handling and key-repeat duplication.
    event.preventDefault();
    if (!input.isAutoRepeat) send(action);
  });
}
const fixture = process.env.REELS_DEMO === "1";
// QA only: Photos calls use the demo library while the rest of the app (agent
// MCP, store, editor) stays real. It needs an explicit QA profile
// (REELS_USER_DATA) so synthetic media never reaches the default profile.
const photosDemo =
  fixture ||
  (process.env.REELS_PHOTOS_DEMO_QA === "1" && !!process.env.REELS_USER_DATA);
const grants = new Set<string>();
const imageGrants = new Set<string>();
const destinations = new Set<string>();
if (app.requestSingleInstanceLock()) {
  void awaitReady();
} else {
  app.quit();
}
async function awaitReady() {
  await app.whenReady();
  const root = app.getPath("userData");
  const logs = new ExecutionLogs(root);
  const store = new LocalStore(root);
  await store.initialize();
  const terminalSettings = new TerminalSettingStore(root);
  // The settings toggle (or REELS_DEV_MODE=1) turns the terminal workspace on for this run.
  const developmentMode =
    developmentModeEnabled(process.env) || (await terminalSettings.get());
  const nativeRoot = app.isPackaged
    ? path.join(process.resourcesPath, "native")
    : path.join(app.getAppPath(), "native/photosindex/.build");
  const nativeBinary = path.join(
    nativeRoot,
    "PhotosIndex.app/Contents/MacOS/PhotosIndex",
  );
  const binaryFingerprint = await readFile(nativeBinary)
    .then((b) => sha256Hex(b))
    .catch(() => "missing");
  const socket = path.join(
    os.tmpdir(),
    `reels-${process.getuid?.() ?? 0}-${sha256Hex(root + "|" + nativeRoot + "|" + binaryFingerprint)
      .slice(0, 12)}.sock`,
  );
  const native = new NativeClient({
    cli: path.join(nativeRoot, "photosindex"),
    app: path.join(nativeRoot, "PhotosIndex.app"),
    socket,
    support: path.join(root, "native"),
    exportRoot: process.env.PHOTOSINDEX_EXPORT_ROOT,
  });
  const demo = createDemoBridge();
  const agentSession = new AgentSession();
  const inputForms = new InputFormWindows(backgroundQA);
  // Embedded workflow server: started before anything reads REELS_WORKFLOW_URL.
  const workflowHost = new DesktopWorkflowHost({
    webRoot: path.join(app.getAppPath(), "dist"),
    openForm: (formId) => inputForms.open({ formId }),
  });
  const workflowStatus = await workflowHost.start();
  if (workflowStatus.message)
    console.warn(`Workflow server (${workflowStatus.state}): ${workflowStatus.message}`);
  const requestWorkflow = (action: WorkflowAction, input?: unknown) =>
    workflowHost.request(() => workflowRequest(action, input));
  let closeAgent: (() => Promise<void>) | undefined;
  const emit = (name: string, value: unknown) => {
    if (window && !window.isDestroyed()) window.webContents.send(name, value);
  };
  let workflowOpen: { runId: string; sequence: number } | null = null;
  let workflowOpenSequence = 0;
  const workflowToasts = new Set<Notification>();
  const workflowNotifications = new WorkflowNotifications({
    enabled: !backgroundQA && !fixture,
    list: () => requestWorkflow("list"),
    isActive: () => !!window && !window.isDestroyed() && window.isVisible() && window.isFocused(),
    setBadge: (count) => { app.setBadgeCount(count); },
    open: (runId) => {
      workflowOpen = { runId, sequence: ++workflowOpenSequence };
      showWindow();
      emit("workflow:open", null);
    },
    notify: (notice, count, onClick) => {
      if (!Notification.isSupported()) return;
      const state = notice.status === "completed" ? "완료" : notice.status === "interrupted" ? "중단" : "실패";
      const toast = new Notification({
        title: count > 1 ? `워크플로 ${count}건 상태 변경` : `워크플로 ${state}`,
        body: notice.title.replace(/[\r\n\t]/g, " ").slice(0, 160),
        silent: true,
      });
      workflowToasts.add(toast);
      toast.once("click", onClick);
      toast.once("close", () => workflowToasts.delete(toast));
      toast.show();
    },
  });
  const workbench = developmentMode
    ? new Workbench(root, (event) => emit("workbench:event", event))
    : undefined;
  let workbenchError: unknown;
  if (workbench) {
    try {
      await workbench.initialize(
        app.isPackaged
          ? path.join(os.homedir(), "side/reels-dashboard")
          : app.getAppPath(),
      );
    } catch (error) {
      workbenchError = error;
    }
  }
  const contentLibrary = new ContentLibrary(store, (value) =>
    emit("dashboard:changed", value),
    async () => [
      ...(await editorService.list()).map(p => ({ kind: "video" as const, id: p.id, title: p.name })),
      ...(await cardNews.list()).map(p => ({ kind: "card-news" as const, id: p.id, title: p.title })),
    ],
    path.resolve(process.env.PHOTOSINDEX_EXPORT_ROOT ?? path.join(os.homedir(), "Library/Mobile Documents/com~apple~CloudDocs/Naver Clip")),
  );
  const routeLibrary = new RouteLibrary(contentLibrary);
  const blogs = new BlogLibrary(store, contentLibrary);
  // QA only: with REELS_QA_STUBBED_DIALOGS=1 a background-QA spec that stubbed
  // dialog.showMessageBoxSync reaches the real unsaved-change dialog branches.
  const canonicalEditor = new DesktopCanonicalEditor(
    root,
    path.join(app.getAppPath(), "dist"),
    backgroundQA && process.env.REELS_QA_STUBBED_DIALOGS !== "1",
  );
  const blogResults = new BlogResults(store, () => emit("blog:results-changed", null));
  const blogComments = new BlogComments(store);
  const blogExtractor = new BlogExtractor({
    store,
    viewerAssets: path.join(app.getAppPath(), "dist-electron/blog-restore-viewer"),
    register: (directory) => blogResults.register(directory),
    preview: (id) => blogResults.preview(id),
    progress: (event) => emit("blog:extract-progress", event),
  });
  // Shared by the Blog tab and MCP; counted as an active operation so quitting waits for it.
  const extractBlog = async (input: unknown) => {
    activeOperations++;
    try {
      return await blogExtractor.extract(input);
    } finally {
      activeOperations--;
    }
  };
  const analysis = new MediaAnalysis(
    store,
    contentLibrary,
    app.isPackaged
      ? path.join(process.resourcesPath, "editor-runtime")
      : path.join(app.getAppPath(), "native/editor-engine/.build/runtime"),
    logs,
    undefined,
    path.join(app.getAppPath(), "dist-electron/analysis-context-mcp.cjs"),
  );
  const coverPreferences = new CoverPreferencesStore(root);
  const planning = new PlanningStore(root);
  const instagramInsights = new InstagramInsightsStore(root, undefined, () => emit("instagram:changed", null));
  const refreshInstagramInsights = () => fixture ? demo.instagramInsights!.refresh() : instagramInsights.startRefresh();
  const clipUpload = new ClipUpload(contentLibrary, async bytes => {
    const image = nativeImage.createFromBuffer(Buffer.from(bytes));
    if (image.isEmpty()) throw new Error("UPLOAD_COVER_INVALID: 표지 이미지를 읽지 못했어요.");
    return image.toJPEG(95);
  });
  const gifConverter = new GifConverter(
    app.isPackaged
      ? path.join(process.resourcesPath, "editor-runtime")
      : path.join(app.getAppPath(), "native/editor-engine/.build/runtime"),
    logs,
  );
  const convertGif = async (input: unknown) => {
    activeOperations++;
    try { return await gifConverter.convert(input); }
    finally { activeOperations--; }
  };
  const createClipBundle = async (input: unknown) => {
    agentSession.assertWritable();
    activeOperations++;
    try { return await clipUpload.create(input); }
    finally { activeOperations--; }
  };
  const icloudDelivery = new ICloudDelivery(
    contentLibrary,
    path.resolve(process.env.PHOTOSINDEX_EXPORT_ROOT ?? path.join(os.homedir(), "Library/Mobile Documents/com~apple~CloudDocs/Naver Clip")),
    paths => native.request("icloud.status", { paths: JSON.stringify(paths) }) as Promise<ICloudUploadStatus>,
    path.join(root,"outbound-history"),
  );
  // Read-only group membership for the Photos bundle import.
  const photosGroupAssets = async (selection: {
    groupID: string;
    indexRunID: string;
  }) => {
    const args = { id: selection.groupID, "index-run": selection.indexRunID };
    const detail = (await (photosDemo
      ? demo.request("groups.show", args)
      : native.request("groups.show", args))) as {
      indexRunID: string;
      assets: BundleAsset[];
    };
    if (detail.indexRunID !== selection.indexRunID)
      throw new Error("stale-index-run: 날짜를 다시 색인하고 그룹을 다시 조회해주세요.");
    return detail.assets;
  };
  const demoMedia = demoMaterializer({
    supportRoot: path.join(root, "native"),
    ffmpeg: path.join(
      app.isPackaged
        ? path.join(process.resourcesPath, "editor-runtime")
        : path.join(app.getAppPath(), "native/editor-engine/.build/runtime"),
      "bin/ffmpeg",
    ),
    assets: async () =>
      ((await demo.request("groups.show", {})) as { assets: BundleAsset[] }).assets,
  });
  const editorService = new EditorService({
    logs,
    dashboardChanged: (value) => emit("dashboard:changed", value),
    root,
    store,
    runtime: app.isPackaged
      ? path.join(process.resourcesPath, "editor-runtime")
      : path.join(app.getAppPath(), "native/editor-engine/.build/runtime"),
    chooseVideo: async () => {
      const result = await dialog.showOpenDialog(window, {
        properties: ["openFile"],
        filters: [{ name: "영상", extensions: ["mov", "mp4", "m4v"] }],
      });
      return result.canceled ? null : result.filePaths[0];
    },
    chooseOutput: async (name) => {
      const result = await dialog.showSaveDialog(window, {
        defaultPath: name,
        filters: name.endsWith(".png")
          ? [{ name: "카드 이미지", extensions: ["png"] }]
          : [{ name: "영상", extensions: ["mov", "mp4"] }],
      });
      return result.canceled ? null : (result.filePath ?? null);
    },
    materialize: async (selection) =>
      (await native.request("editor.materialize", {
        id: selection.groupID,
        "index-run": selection.indexRunID,
        "asset-id": selection.assetID,
      })) as { sourcePath: string },
    materializeMedia: async (selection) =>
      photosDemo
        ? demoMedia(selection)
        : ((await native.request("media.materialize", {
            id: selection.groupID,
            "index-run": selection.indexRunID,
            "asset-id": selection.assetID,
          })) as MaterializedMedia),
    groupAssets: photosGroupAssets,
    reveal: (file) => shell.showItemInFolder(file),
    changed: (project) => emit("agent:project-changed", project),
    renderStarted: (job) => emit("agent:render-started", job),
  });
  const boardMedia = new BoardMedia(
    contentLibrary,
    path.join(root, "board-media"),
    app.isPackaged
      ? path.join(process.resourcesPath, "editor-runtime")
      : path.join(app.getAppPath(), "native/editor-engine/.build/runtime"),
    logs,
    async (file, width) =>
      (
        await nativeImage.createThumbnailFromPath(file, {
          width,
          height: width,
        })
      ).toDataURL(),
  );
  const editor: EditorBridge = fixture ? demo.editor : editorService;
  const cardNews = new CardNewsService({
    logs,
    root,
    store,
    runtime: app.isPackaged
      ? path.join(process.resourcesPath, "editor-runtime")
      : path.join(app.getAppPath(), "native/editor-engine/.build/runtime"),
    chooseAsset: async (kind) => {
      const result = await dialog.showOpenDialog(window, {
        properties: ["openFile"],
        filters: [
          {
            name:
              kind === "image" ? "사진" : kind === "video" ? "영상" : "음악",
            extensions:
              kind === "image"
                ? ["jpg", "jpeg", "png", "webp"]
                : kind === "video"
                  ? ["mp4", "mov", "m4v"]
                  : ["mp3", "m4a", "wav", "aac"],
          },
        ],
      });
      return result.canceled ? null : result.filePaths[0];
    },
    chooseOutput: async (name) => {
      const result = await dialog.showSaveDialog(window, {
        defaultPath: name,
        filters: [{ name: "MP4 영상", extensions: ["mp4"] }],
      });
      return result.canceled ? null : (result.filePath ?? null);
    },
    normalizeImage: (data) => {
      const image = nativeImage.createFromBuffer(data);
      if (image.isEmpty())
        throw new Error(
          "사진을 읽을 수 없어요. JPG·PNG·WebP 파일을 선택해주세요.",
        );
      const size = image.getSize();
      return (
        Math.max(size.width, size.height) > 1920
          ? image.resize(
              size.width > size.height ? { width: 1920 } : { height: 1920 },
            )
          : image
      ).toPNG();
    },
    validateFrame: (data) => {
      const image = nativeImage.createFromBuffer(data),
        size = image.getSize();
      if (image.isEmpty() || size.width !== 1080 || size.height !== 1920)
        throw new Error("카드 이미지는 1080×1920이어야 해요.");
    },
    reveal: (file) => shell.showItemInFolder(file),
    changed: (value) => emit("dashboard:changed", value),
  });
  protocol.handle("reels-media", (request) =>
    new URL(request.url).host === "content"
      ? boardMedia.media(request)
      : editorService.media(request),
  );
  const demoDocuments = new Map<string, string>();
  let queue: Promise<unknown> = Promise.resolve();
  let activeOperations = 0;
  const shutdown = new ShutdownSequence();
  // The dashboard window may already be destroyed (only editor windows left, or
  // none at all), so dialogs fall back to no parent instead of a dead window.
  const messageBox = (options: Electron.MessageBoxSyncOptions) => {
    const parent = liveWindow(window);
    return parent
      ? dialog.showMessageBoxSync(parent, options)
      : dialog.showMessageBoxSync(options);
  };
  const workBusy = () =>
    activeOperations > 0 || editorService.busy || cardNews.busy || icloudDelivery.busy || instagramInsights.busy;
  const confirmAbortJobs = () =>
    messageBox({
      type: "warning",
      buttons: ["취소", "종료"],
      defaultId: 0,
      cancelId: 0,
      message: "실행 중인 AI 작업이 있어요.",
      detail:
        "지금 종료하면 진행 중인 AI 작업이 중단되고, 다음 실행 때 중단됨으로 표시돼요.",
    }) === 1;
  // Set when the dashboard close guard already asked; consumed by the next before-quit.
  let jobAbortConfirmed = false;
  /**
   * "그래도 닫기" for the blog tab's embedded editors (and the dashboard page, probed with
   * them) holds for this one close or quit attempt only: every branch that cancels the
   * attempt calls cancelCloseAttempt(), and it expires on its own as a backstop.
   */
  let discardConfirmedAt = 0;
  const DISCARD_CONFIRM_TTL_MS = 5000;
  const discardConfirmed = () =>
    discardConfirmedAt > 0 && Date.now() - discardConfirmedAt < DISCARD_CONFIRM_TTL_MS;
  const cancelCloseAttempt = () => {
    discardConfirmedAt = 0;
  };
  let askingEditorDiscard = false;
  /** With embedded editors open, asks once (async) and calls `then` to retry the close or quit. */
  const editorsMayClose = (then: () => void) => {
    const host = liveWindow(window);
    if (
      discardConfirmed() ||
      !host ||
      !canonicalEditor.frames(host.webContents).length
    )
      return true;
    if (!askingEditorDiscard) {
      askingEditorDiscard = true;
      void canonicalEditor
        .confirmDiscard(host.webContents, host, undefined, true)
        .then(({ close }) => {
          if (!close) return;
          discardConfirmedAt = Date.now();
          then();
        })
        .finally(() => {
          askingEditorDiscard = false;
        });
    }
    return false;
  };
  app.on("before-quit", (event) => {
    if (shutdown.mayQuit()) return;
    // Every quit during cleanup (e.g. window-all-closed after the editors close) waits.
    event.preventDefault();
    if (shutdown.started) return;
    const confirmed = jobAbortConfirmed;
    jobAbortConfirmed = false;
    if (workBusy()) {
      cancelCloseAttempt();
      messageBox({
        type: "info",
        message: "진행 중인 작업이 끝난 뒤 종료해주세요.",
      });
      return;
    }
    if (workflowHost.runningJobs() > 0 && !confirmed && !confirmAbortJobs()) {
      cancelCloseAttempt();
      return;
    }
    if (
      !editorsMayClose(() => {
        // The job question (if any) was already answered in this quit.
        jobAbortConfirmed = true;
        app.quit();
      })
    )
      return;
    workflowNotifications.dispose();
    for (const toast of workflowToasts) toast.close();
    workflowToasts.clear();
    workbench?.dispose();
    blogResults.dispose();
    boardMedia.dispose();
    void shutdown.run(
      () =>
        editorService
          .dispose()
          .then(() => canonicalEditor.dispose())
          .then(() =>
            workflowHost
              .dispose()
              .catch((error) => console.error("Workflow server close failed:", error)),
          )
          .then(() => closeAgent?.())
          .then(() => native.dispose()),
      () => app.quit(),
    );
  });
  // Only the dashboard window's main frame: the blog tab's embedded editors are subframes.
  const handle = (name: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(`reels:${name}`, async (event, ...args) => {
      const dashboard = liveWindow(window);
      if (
        !trustedIpcSender({
          sender: event.sender,
          frame: event.senderFrame,
          dashboard: dashboard && {
            sender: dashboard.webContents,
            frame: dashboard.webContents.mainFrame,
          },
        })
      )
        throw new Error("Untrusted IPC sender");
      return fn(...args);
    });
  handle("executionLogs:list", () => logs.list());
  handle("workflow:request", (action, input) => requestWorkflow(workflowAction.parse(action), input));
  handle("workflow:hostStatus", () => workflowHost.status());
  handle("workflow:pendingOpen", () => workflowOpen);
  handle("workflow:ackOpen", (sequence) => {
    if (workflowOpen?.sequence === sequence) workflowOpen = null;
  });
  handle("blog:canonicalProjects", () => canonicalEditor.projects());
  handle("blog:canonicalIssues", () => canonicalEditor.issues());
  handle("blog:openCanonical", (projectId) =>
    canonicalEditor.open(String(projectId), liveWindow(window)?.webContents),
  );
  handle("blog:closeCanonical", (projectId) => {
    const host = liveWindow(window);
    if (!host) return { close: true, unsaved: false };
    return canonicalEditor
      .confirmDiscard(host.webContents, host, String(projectId))
      .then((result) => {
        // The renderer removes the iframe next; the server goes once no frame is left.
        if (result.close) canonicalEditor.release(String(projectId), host.webContents);
        return result;
      });
  });
  handle("blog:readDocument", (projectId, file) => blogs.readDocument(projectId, file));
  handle("blog:results", () => blogResults.list());
  handle("blog:readResult", (id) => blogResults.read(id));
  handle("blog:previewResult", (id) => blogResults.preview(id));
  handle("blog:addResult", async () => {
    const result = await dialog.showOpenDialog(window, {title:"블로그 분석 결과 폴더 연결", properties:["openDirectory"]});
    return result.canceled ? null : blogResults.register(result.filePaths[0]);
  });
  handle("blog:extract", (input) => extractBlog(input));
  handle("blog:removeResult", (id) => blogResults.remove(id));
  handle("blog:extractDirectory", () => blogExtractor.defaultParent());
  handle("blog:chooseExtractDirectory", async () => {
    const result = await dialog.showOpenDialog(window, { title: "블로그 추출 결과 저장 위치", properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : blogExtractor.setDefaultParent(result.filePaths[0]);
  });
  handle("blog:load", (projectId) => blogs.load(projectId));
  handle("blog:save", (draft) => blogs.save(draft));
  handle("analysis:mosaicSample", (projectId, sampleId) => analysis.mosaicSample(projectId, sampleId));
  handle("analysis:mosaicExport", async (input) => {
    const result = await dialog.showSaveDialog(window, { defaultPath: "mosaic.png", filters: [{ name: "PNG 이미지", extensions: ["png"] }] });
    if (result.canceled || !result.filePath) return null;
    return analysis.mosaicExport(input, result.filePath);
  });
  for (const method of ["providers", "start", "search", "correct"] as const) {
    handle(`analysis:${method}`, (...args: unknown[]) =>
      (analysis[method] as (...values: unknown[]) => unknown).apply(
        analysis,
        args,
      ),
    );
  }
  for (const method of [
    "list",
    "load",
    "save",
    "chooseAsset",
    "preview",
    "export",
    "job",
    "cancel",
    "reveal",
  ] as const) {
    handle(`cardNews:${method}`, (...args: unknown[]) =>
      (cardNews[method] as (...values: unknown[]) => unknown).apply(
        cardNews,
        args,
      ),
    );
  }
  if (workbench) {
    for (const method of [
      "state",
      "start",
      "snapshot",
      "write",
      "resize",
      "stop",
      "remove",
      "close",
      "setTerminalBackend",
      "reattach",
    ] as const) {
      handle(`workbench:${method}`, (...args: unknown[]) => {
        if (workbenchError)
          throw new Error(
            "개발 작업공간 설정을 읽지 못했어요. 소스 폴더를 다시 연결해주세요.",
          );
        return (workbench[method] as (...values: unknown[]) => unknown).apply(
          workbench,
          args,
        );
      });
    }
    handle("workbench:chooseWorkspace", async () => {
      const result = await dialog.showOpenDialog(window, {
        title: "Reels Dashboard 소스 폴더",
        properties: ["openDirectory"],
      });
      if (result.canceled) return workbench.state();
      const state = await workbench.chooseWorkspace(result.filePaths[0]);
      workbenchError = undefined;
      return state;
    });
    handle("workbench:openPreview", () => shell.openExternal(PREVIEW_URL));
    handle("workbench:hideWindow", () => window.hide());
  }
  for (const method of [
    "runtime",
    "chooseVideo",
    "fromPhotos",
    "list",
    "load",
    "save",
    "preview",
    "export",
    "job",
    "cancel",
    "reveal",
    "playbackCopy",
  ] as const) {
    handle(`editor:${method}`, (...args: unknown[]) =>
      (editor[method] as (...values: unknown[]) => unknown).apply(editor, args),
    );
  }
  const requestPhotos = async (method: unknown, args: unknown = {}) => {
    validateRequest(method, args);
    const input = { ...(args as Arguments) };
    const work = async () => {
      for (const key of ["file", "decision", "plan"])
        if (input[key]) await resolveGrantedFile(input[key], grants);
      if (input.to && !destinations.has(input.to))
        throw new Error("Choose a destination directory first");
      if (method === "move.apply") {
        const result = await dialog.showMessageBox(window, {
          type: "warning",
          buttons: ["취소", "검증 후 원본 이동"],
          defaultId: 0,
          cancelId: 0,
          message: "Photos 원본을 최근 삭제된 항목으로 이동할까요?",
          detail:
            "대상 업로드와 해시 검증 후 선택한 원본을 삭제합니다. 복사만 원하면 취소하세요.",
        });
        if (result.response !== 1) throw new Error("이동을 취소했어요.");
      }
      if (method === "groups.inspect" && !photosDemo) {
        const base = path.join(root, "evidence");
        await mkdir(base, { recursive: true, mode: 0o700 });
        input.output = await realpath(await mkdtemp(path.join(base, "page-")));
      }
      const demoInput = { ...input };
      for (const key of ["file", "decision", "plan"])
        if (demoDocuments.has(demoInput[key]))
          demoInput[key] = demoDocuments.get(demoInput[key])!;
      const result = photosDemo
        ? await demo.request(method, demoInput)
        : await native.request(method, input);
      if (method === "groups.inspect" && !photosDemo) {
        const inspection = result as Inspection;
        for (const sample of inspection.sampleFiles) {
          const resolved = await realpath(sample);
          if (!resolved.startsWith(input.output + path.sep))
            throw new Error("Evidence escaped output directory");
          imageGrants.add(resolved);
        }
      }
      if (method.endsWith(".apply"))
        await store.document(method.replace(".", "-") + "-receipt", result);
      return result;
    };
    if (method === "status") return work();
    activeOperations++;
    const result = queue.then(work).finally(() => {
      activeOperations--;
    });
    queue = result.catch(() => {});
    return result;
  };
  handle("request", requestPhotos);
  const terminalSetting = async () =>
    resolveTerminalSetting(process.env, await terminalSettings.get(), developmentMode);
  handle("terminal-setting:get", terminalSetting);
  handle("terminal-setting:set", async (enabled: unknown) => {
    await terminalSettings.set(enabled);
    return terminalSetting();
  });
  handle("terminal-setting:relaunch", () => {
    if (workBusy() || workflowHost.runningJobs() > 0)
      throw new Error("진행 중인 작업이 끝난 뒤 다시 시작해주세요.");
    app.relaunch();
    app.quit();
  });
  handle("cover-preferences:get", () => coverPreferences.get());
  handle("planning:get", () => planning.get());
  handle("planning:update", (input: unknown) => planning.update(input));
  handle("instagram:get", (input: unknown) => fixture ? demo.instagramInsights!.get() : instagramInsights.get(input ?? {}));
  handle("instagram:topics", (input: unknown) => fixture ? demo.instagramInsights!.setTopics(input as Record<string,string>) : instagramInsights.setTopics(input));
  handle("instagram:refresh", refreshInstagramInsights);
  handle("instagram:connect", async (value: unknown) => {
    const input = instagramConnectionInput.parse(value);
    if (fixture) return demo.instagramInsights!.connect(input);
    const selected = await dialog.showOpenDialog(window, {
      title: "Instagram 조회 토큰 파일 선택",
      properties: ["openFile", "showHiddenFiles"],
      defaultPath: path.join(os.homedir(), ".private", "meta-ig-token"),
    });
    if (selected.canceled || !selected.filePaths[0]) return null;
    activeOperations++;
    try { return await instagramInsights.connect(input, selected.filePaths[0]); }
    finally { activeOperations--; }
  });
  handle("cover-preferences:set", (input: unknown) => coverPreferences.set(input));
  handle("clip-upload:create", createClipBundle);
  handle("icloud:status", (value: unknown) => icloudDelivery.status(icloudStatusInput.parse(value).paths));
  handle("icloud:list", () => icloudDelivery.list());
  handle("icloud:configure", (input: unknown) => {
    agentSession.assertWritable();
    return icloudDelivery.configure(input);
  });
  handle("icloud:start", (input: unknown) => {
    agentSession.assertWritable();
    return icloudDelivery.start(input);
  });
  handle("icloud:get", (jobId: string) => icloudDelivery.get(jobId));
  handle("icloud:readiness", (input: unknown) => icloudDelivery.readiness(input));
  handle("agent:context", (context) => agentSession.update(context));
  handle("saveDocument", async (name: string, data: unknown) => {
    safeDocumentName(name);
    const file = await store.document(name, data);
    grants.add(file);
    if (fixture) {
      demoDocuments.set(
        file,
        await demo.saveDocument(path.basename(file), data),
      );
    }
    return file;
  });
  handle("openDocument", async () => {
    const result = await dialog.showOpenDialog(window, {
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled) return null;
    const file = await realpath(result.filePaths[0]);
    const content = await readFile(file, "utf8");
    if (content.length > 1024 * 1024) throw new Error("Document too large");
    const data = JSON.parse(content);
    grants.add(file);
    if (fixture)
      demoDocuments.set(
        file,
        await demo.saveDocument(path.basename(file), data),
      );
    return { path: file, data };
  });
  handle("chooseDestination", async () => {
    if (fixture) {
      const destination = await demo.chooseDestination();
      if (destination) destinations.add(destination);
      return destination;
    }
    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory", "createDirectory"],
      defaultPath:
        process.env.PHOTOSINDEX_EXPORT_ROOT ??
        path.join(
          os.homedir(),
          "Library/Mobile Documents/com~apple~CloudDocs/Naver Clip",
        ),
    });
    if (result.canceled) return null;
    const destination = await realpath(result.filePaths[0]);
    destinations.add(destination);
    return destination;
  });
  handle("imageURL", async (file: string) => {
    if (fixture) {
      if (!file.startsWith("/demo/"))
        throw new Error("Image access was not granted");
      return demo.imageURL(file);
    }
    const resolved = await resolveGrantedFile(file, imageGrants);
    const image = await readFile(resolved);
    if (image.length > 20 * 1024 * 1024) throw new Error("Image too large");
    return `data:image/jpeg;base64,${image.toString("base64")}`;
  });
  handle("loadDashboard", () => store.load());
  handle("projects:listEdits", () => contentLibrary.listEdits());
  handle("projects:merge", (input) => {
    agentSession.assertWritable();
    if (editorService.busy || cardNews.busy) throw new Error("편집·내보내기가 끝난 뒤 합쳐주세요.");
    return contentLibrary.merge(input);
  });
  handle("projects:linkEdit", (input) => {
    agentSession.assertWritable();
    if (editorService.busy || cardNews.busy) throw new Error("편집·내보내기가 끝난 뒤 연결해주세요.");
    return contentLibrary.linkEdit(input);
  });
  handle("mobileBriefing:status", () => readMobileBriefingStatus(root));
  handle("mobileBriefing:open", async () => {
    const status = await readMobileBriefingStatus(root);
    if (!status.siteUrl)
      throw new Error("브리핑 사이트 연결 정보를 확인해주세요.");
    await shell.openExternal(status.siteUrl);
  });
  handle("saveDashboard", async (value: unknown, revision: unknown) => {
    if (typeof revision !== "string")
      throw new Error("현재 현황을 다시 조회해주세요.");
    await store.save(value, revision);
    emit("dashboard:changed", await store.load());
  });
  handle("routeMap:load", (id: string) => fixture ? demo.routeMap!.load(id) : routeLibrary.load(id));
  handle("contentMedia:list", (id: string, folder?: string, offset?: number) =>
    fixture
      ? demo.contentMedia!.list(id, folder, offset)
      : contentLibrary.mediaPage(id, folder, offset),
  );
  handle("contentMedia:thumbnail", (id: string, file: string) =>
    fixture
      ? demo.contentMedia!.thumbnail(id, file)
      : boardMedia.thumbnail(id, file),
  );
  handle("contentMedia:text", (id: string, file: string) =>
    fixture ? demo.contentMedia!.text(id, file) : contentLibrary.documentText(id, file),
  );
  handle("contentMedia:open", (id: string, file: string, options?: unknown) => {
    // Only an explicit boolean asks for a playback copy; anything else streams the original.
    const copy =
      typeof options === "object" &&
      options !== null &&
      (options as { copy?: unknown }).copy === true;
    return fixture
      ? demo.contentMedia!.open(id, file, { copy })
      : boardMedia.open(id, file, { copy });
  });
  handle("contentMedia:gif", async (id: string, file: string) => {
    if (fixture) throw new Error("UNSUPPORTED: 데모 화면에서는 GIF를 만들 수 없어요.");
    const checked = await contentLibrary.resolveMedia(id, file);
    if (!checked.info.isFile()) throw new Error("GIF_SOURCE: 영상 파일을 선택해주세요.");
    const parsed = path.parse(checked.path);
    const chosen = await dialog.showSaveDialog(window, {
      title: "무음 GIF 저장",
      defaultPath: path.join(parsed.dir, `${parsed.name}.gif`),
      filters: [{ name: "GIF 이미지", extensions: ["gif"] }],
    });
    if (chosen.canceled || !chosen.filePath) return null;
    const outputPath = /\.gif$/i.test(chosen.filePath) ? chosen.filePath : `${chosen.filePath}.gif`;
    // The save panel already confirmed replacing an existing file.
    return convertGif({ sourcePath: checked.path, outputPath, overwrite: true });
  });
  handle("revealResource", async (id: unknown, resource: unknown) => {
    if (typeof id !== "string" || typeof resource !== "string")
      throw new Error("Invalid resource request");
    shell.showItemInFolder(await contentLibrary.resolveLinked(id, resource));
  });
  handle("exportSnapshot", async () => {
    const snapshot = toSnapshot(await store.load());
    const result = await dialog.showSaveDialog(window, {
      defaultPath: "snapshot.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, JSON.stringify(snapshot, null, 2) + "\n", {
      mode: 0o600,
    });
    return result.filePath;
  });
  handle("syncSnapshot", async (endpoint: unknown, token: unknown) =>
    syncSnapshot(await store.load(), endpoint, token),
  );
  const createWindow = () => {
    window = new BrowserWindow({
      show: !backgroundQA,
      focusable: !backgroundQA,
      ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 17 } } : {}),
      width: 1600,
      height: 1000,
      minWidth: 760,
      minHeight: 600,
      backgroundColor: "#10131c",
      title: displayName,
      webPreferences: {
        ...(backgroundQA ? { backgroundThrottling: false } : {}),
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        additionalArguments: [
          ...(fixture ? ["--reels-demo"] : []),
          ...(developmentMode ? [DEVELOPMENT_MODE_ARGUMENT] : []),
          ...(app.isPackaged ? [] : [DEV_BUILD_ARGUMENT]),
        ],
      },
    });
    if (developmentMode) {
      forwardHostShortcuts(window.webContents, (action) =>
        emit("workbench:shortcut", action),
      );
    }
    window.webContents.setWindowOpenHandler(({ url, referrer }) => {
      // An embedded editor may open only its help page. The handler is not told which
      // frame asked: a clicked editor link has focus, a script call sends the editor as referrer.
      if (
        canonicalEditor.owns(window.webContents.focusedFrame?.url) ||
        canonicalEditor.owns(referrer.url)
      ) {
        if (url === CANONICAL_EDITOR_HELP_URL) void shell.openExternal(url);
        return { action: "deny" };
      }
      try {
        const parsed = new URL(url);
        if (
          ["https:", "http:"].includes(parsed.protocol) &&
          !parsed.username &&
          !parsed.password
        )
          void shell.openExternal(parsed.href);
      } catch {
        /* Reject invalid and local URLs. */
      }
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    // An embedded editor frame stays on its own server's origin.
    window.webContents.on("will-frame-navigate", (event) => {
      if (event.isMainFrame || !canonicalEditor.owns(event.frame?.url)) return;
      if (new URL(event.frame!.url).origin !== new URL(event.url).origin)
        event.preventDefault();
    });
    // A real beforeunload refusal (an editor, the 원고·배치 draft or the experience form)
    // that this attempt's probe did not already settle; quit cleanup already asked.
    window.webContents.on("will-prevent-unload", (event) => {
      if (
        shutdown.started ||
        discardConfirmed() ||
        canonicalEditor.confirmUnload(window)
      )
        event.preventDefault();
      else cancelCloseAttempt();
    });
    window.on("focus", () => workflowNotifications.clearUnread());
    window.webContents.session.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );
    // Embedded editors had a partition that refused every permission check too.
    window.webContents.session.setPermissionCheckHandler(
      (_webContents, _permission, requestingOrigin) =>
        !canonicalEditor.owns(requestingOrigin),
    );
    window.on("close", (event) => {
      if (shutdown.started) return;
      if (workBusy()) {
        event.preventDefault();
        cancelCloseAttempt();
        messageBox({
          type: "info",
          message: "진행 중인 작업이 끝난 뒤 닫아주세요.",
        });
        return;
      }
      // Closing the dashboard quits the app, which aborts embedded SDK jobs: ask here,
      // while the window still exists, and quit only on 종료.
      const host = window;
      if (!editorsMayClose(() => host.close())) {
        event.preventDefault();
        return;
      }
      if (workflowHost.runningJobs() > 0) {
        event.preventDefault();
        if (confirmAbortJobs()) {
          jobAbortConfirmed = true;
          app.quit();
        } else cancelCloseAttempt();
      }
    });
    void window.loadFile(path.join(app.getAppPath(), "dist/index.html"));
  };
  createWindow();
  const showWindow = () => {
    if (backgroundQA) return;
    if (window.isDestroyed()) createWindow();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  if (!backgroundQA) installApplicationIdentity(showWindow, displayName, !app.isPackaged);
  if (app.isPackaged && !backgroundQA)
    void installCli({
      executable: process.execPath,
      bundle: path.join(process.resourcesPath, "cli/reels.mjs"),
      binDir: path.join(os.homedir(), ".local/bin"),
    }).then(
      (result) => console.info("[cli-install]", result.status, result.target, "reason" in result ? result.reason : ""),
      (error: unknown) => console.warn("[cli-install] failed", error instanceof Error ? error.message : error),
    );
  workflowNotifications.start();
  app.on("second-instance", showWindow);
  if (!fixture)
    closeAgent = await connectAgent(root, {
      coverPreferences,
      planning,
      instagramInsights: { get: input => instagramInsights.get(input), refresh: refreshInstagramInsights, setTopics: input => instagramInsights.setTopics(input) },
      clipUpload: { create: createClipBundle },
      gif: { convert: convertGif },
      icloud: icloudDelivery,
      editor: editorService,
      session: agentSession,
      dashboard: () => store.load(),
      content: contentLibrary,
      inputForms,
      forms: { request: requestWorkflow },
      analysis,
      blog: { extract: extractBlog, results: () => blogResults.list(), link: (directory) => blogResults.register(directory), unlink: (id) => blogResults.remove(id) },
      blogComments,
      preview: async (project, time, kind) => {
        const artifact = await editorService.previewArtifact(
          project,
          time,
          kind,
        );
        let image = nativeImage.createFromDataURL(artifact.image);
        if (image.isEmpty()) throw new Error("미리보기 PNG를 읽지 못했어요.");
        const size = image.getSize();
        if (Math.max(size.width, size.height) > 1280)
          image = image.resize(
            size.width >= size.height ? { width: 1280 } : { height: 1280 },
          );
        return {
          image: image.toDataURL(),
          manifest: artifact.manifest,
          displaySize: image.getSize(),
        };
      },
      open: (project) => emit("agent:project-opened", project),
      photos: requestPhotos,
    });
  app.on("activate", () => {
    showWindow();
  });
}
app.on("window-all-closed", () => app.quit());

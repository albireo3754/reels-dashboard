import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  protocol,
  nativeImage,
} from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
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
import { matchWorkbenchShortcut } from "../shared/workbench-shortcuts";
import {
  developmentModeEnabled,
  DEVELOPMENT_MODE_ARGUMENT,
} from "./development-mode";
import { readMobileBriefingStatus } from "./mobile-briefing";
import { connectAgent } from "../app/automation";
import { AgentSession } from "../entities/agent-session";
import { EditorService } from "../features/reel-editing";
import type { EditorBridge } from "../shared/editor";
import { NativeClient, validateRequest } from "./native";
import {
  LocalStore,
  resolveGrantedFile,
  safeDocumentName,
} from "../shared/lib/storage";
import { toSnapshot, validateDashboard } from "../shared/data";
import type { Arguments, CommandMethod, Inspection } from "../shared/contracts";
import { createDemoBridge } from "../shared/demo";
if (process.env.REELS_USER_DATA)
  app.setPath("userData", path.resolve(process.env.REELS_USER_DATA));
app.setName("Reels Dashboard");
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
const fixture = process.env.REELS_DEMO === "1";
const developmentMode = developmentModeEnabled(process.env);
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
  const store = new LocalStore(root);
  await store.initialize();
  const nativeRoot = app.isPackaged
    ? path.join(process.resourcesPath, "native")
    : path.join(app.getAppPath(), "native/photosindex/.build");
  const nativeBinary = path.join(
    nativeRoot,
    "PhotosIndex.app/Contents/MacOS/PhotosIndex",
  );
  const binaryFingerprint = await readFile(nativeBinary)
    .then((b) => createHash("sha256").update(b).digest("hex"))
    .catch(() => "missing");
  const socket = path.join(
    os.tmpdir(),
    `reels-${process.getuid?.() ?? 0}-${createHash("sha256")
      .update(root + "|" + nativeRoot + "|" + binaryFingerprint)
      .digest("hex")
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
  let closeAgent: (() => Promise<void>) | undefined;
  const emit = (name: string, value: unknown) => {
    if (window && !window.isDestroyed()) window.webContents.send(name, value);
  };
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
  const editorService = new EditorService({
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
        filters: [{ name: "영상", extensions: ["mov", "mp4"] }],
      });
      return result.canceled ? null : (result.filePath ?? null);
    },
    materialize: async (selection) =>
      (await native.request("editor.materialize", {
        id: selection.groupID,
        "index-run": selection.indexRunID,
        "asset-id": selection.assetID,
      })) as { sourcePath: string },
    reveal: (file) => shell.showItemInFolder(file),
    changed: (project) => emit("agent:project-changed", project),
    renderStarted: (job) => emit("agent:render-started", job),
  });
  const editor: EditorBridge = fixture ? demo.editor : editorService;
  protocol.handle("reels-media", (request) => editorService.media(request));
  const demoDocuments = new Map<string, string>();
  let queue: Promise<unknown> = Promise.resolve();
  let activeOperations = 0;
  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    if (activeOperations > 0 || editorService.busy) {
      dialog.showMessageBoxSync(window, {
        type: "info",
        message: "진행 중인 작업이 끝난 뒤 종료해주세요.",
      });
      return;
    }
    quitting = true;
    workbench?.dispose();
    void editorService
      .dispose()
      .then(() => closeAgent?.())
      .then(() => native.dispose())
      .finally(() => app.quit());
  });
  const handle = (name: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(`reels:${name}`, async (event, ...args) => {
      if (
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("Untrusted IPC sender");
      return fn(...args);
    });
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
      if (method === "groups.inspect" && !fixture) {
        const base = path.join(root, "evidence");
        await mkdir(base, { recursive: true, mode: 0o700 });
        input.output = await realpath(await mkdtemp(path.join(base, "page-")));
      }
      const demoInput = { ...input };
      for (const key of ["file", "decision", "plan"])
        if (demoDocuments.has(demoInput[key]))
          demoInput[key] = demoDocuments.get(demoInput[key])!;
      const result = fixture
        ? await demo.request(method, demoInput)
        : await native.request(method, input);
      if (method === "groups.inspect" && !fixture) {
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
  handle("mobileBriefing:status", () => readMobileBriefingStatus(root));
  handle("mobileBriefing:open", async () => {
    const status = await readMobileBriefingStatus(root);
    if (!status.siteUrl) throw new Error("브리핑 사이트 연결 정보를 확인해주세요.");
    await shell.openExternal(status.siteUrl);
  });
  handle("saveDashboard", (value: unknown) => store.save(value));
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
      width: 1440,
      height: 940,
      minWidth: 760,
      minHeight: 600,
      backgroundColor: "#10131c",
      title: "Reels Dashboard",
      webPreferences: {
        ...(backgroundQA ? { backgroundThrottling: false } : {}),
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        additionalArguments: [
          ...(fixture ? ["--reels-demo"] : []),
          ...(developmentMode ? [DEVELOPMENT_MODE_ARGUMENT] : []),
        ],
      },
    });
    if (developmentMode) {
      // Capture at the host so shortcuts also work while the cross-origin
      // preview iframe has focus. Only the trusted top renderer receives actions.
      window.webContents.on("before-input-event", (event, input) => {
        if (input.type !== "keyDown") return;
        const action = matchWorkbenchShortcut({
          code: input.code,
          metaKey: input.meta,
          ctrlKey: input.control,
          altKey: input.alt,
          shiftKey: input.shift,
          isComposing: input.isComposing,
        });
        if (!action) return;
        // Suppress native menu/iframe/xterm handling and key-repeat duplication.
        event.preventDefault();
        if (!input.isAutoRepeat) emit("workbench:shortcut", action);
      });
    }
    window.webContents.setWindowOpenHandler(({ url }) => {
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
    window.webContents.session.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );
    window.on("close", (event) => {
      if ((activeOperations > 0 || editorService.busy) && !quitting) {
        event.preventDefault();
        dialog.showMessageBoxSync(window, {
          type: "info",
          message: "진행 중인 작업이 끝난 뒤 닫아주세요.",
        });
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
  app.on("second-instance", showWindow);
  if (!fixture)
    closeAgent = await connectAgent(root, {
      editor: editorService,
      session: agentSession,
      dashboard: () => store.load(),
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
  app.on("activate", showWindow);
}
app.on("window-all-closed", () => app.quit());

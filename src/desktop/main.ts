import { app, BrowserWindow, dialog, ipcMain, shell, protocol } from "electron";
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
import { EditorService } from "./editor";
import type { EditorBridge } from "../shared/editor";
import { NativeClient, validateRequest } from "./native";
import { LocalStore, resolveGrantedFile, safeDocumentName } from "./storage";
import { toSnapshot, validateDashboard } from "../shared/data";
import type { Arguments, CommandMethod, Inspection } from "../shared/contracts";
import { createDemoBridge } from "../shared/demo";
if (process.env.REELS_USER_DATA)
  app.setPath("userData", path.resolve(process.env.REELS_USER_DATA));
app.setName("Reels Dashboard");
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
    void editorService
      .dispose()
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
  handle("request", async (method: unknown, args: unknown = {}) => {
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
  });
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
      width: 1440,
      height: 940,
      minWidth: 760,
      minHeight: 600,
      backgroundColor: "#10131c",
      title: "Reels Dashboard",
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        additionalArguments: fixture ? ["--reels-demo"] : [],
      },
    });
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
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
app.on("window-all-closed", () => app.quit());

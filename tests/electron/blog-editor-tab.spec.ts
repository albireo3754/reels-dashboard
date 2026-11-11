import { test, expect, type ElectronApplication } from "@playwright/test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { markupFixture } from "../fixtures/markup-editor";
import { cleanProfile, closeApp, launchApp, makeProfile, pressWorkbenchKey } from "./helpers";
import { closeEditorTab, editorIframe, openBlogEditor, windowCount } from "./blog-editor-helpers";
import { chooseEditorMenu } from "../web/canonical-editor-helpers";

const HELP_URL = "https://help.naver.com/service/5593/contents/15529?lang=ko";

async function writeProjects(profile: string, ids: string[]) {
  const projects = [];
  for (const id of ids) {
    const root = path.join(profile, id);
    await mkdir(root);
    projects.push({ id, title: `${id} project`, config: await markupFixture(root) });
  }
  await writeFile(path.join(profile, "blog-projects.json"), JSON.stringify({ version: 1, projects }));
  return projects;
}

/**
 * Calls the real registered `reels:<channel>` handler with a given sender frame of the
 * dashboard window, as Electron would for an IPC that reached the main process.
 * The embedded editor has no ipcRenderer at all; this checks the main-process rule
 * that would still refuse a subframe sender.
 */
function invokeAs(app: ElectronApplication, channel: string, frame: "editor" | "main") {
  return app.evaluate(async ({ BrowserWindow, ipcMain }, { channel, frame }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/dist/index.html"))!;
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, (event: unknown) => Promise<unknown>> })._invokeHandlers;
    const handler = handlers?.get(`reels:${channel}`);
    if (!handler) throw new Error("ipcMain invoke handler map unavailable");
    const senderFrame =
      frame === "main"
        ? win.webContents.mainFrame
        : win.webContents.mainFrame.framesInSubtree.find((f) => f.url.includes("/?blogEditor=1"));
    if (!senderFrame) throw new Error("editor frame missing");
    try {
      return { ok: true, value: JSON.stringify(await handler({ sender: win.webContents, senderFrame })) };
    } catch (error) {
      return { ok: false, value: String((error as Error).message) };
    }
  }, { channel, frame });
}

test("blog projects open as tabs inside the blog workspace, keep edits across menus and close", async ({}, testInfo) => {
  const profile = await makeProfile();
  let app;
  try {
    const projects = await writeProjects(profile, ["first", "second"]);
    app = await launchApp(profile);
    const main = await app.firstWindow();
    const windows = await windowCount(app);
    await main.getByRole("button", { name: "블로그", exact: true }).click();
    const card = (id: string) => main.getByRole("article", { name: `${id} project`, exact: true });

    const first = await openBlogEditor(app, main, "first", card("first"));
    await expect(main.getByRole("button", { name: "first project", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(editorIframe(main, "first")).toHaveAttribute("title", "first project 스마트에디터");
    await expect(editorIframe(main, "first")).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-modals allow-popups");
    expect(new URL(first.url()).pathname + new URL(first.url()).search).toBe("/?blogEditor=1");

    // No preload, no bridge, no Node in the embedded page; the dashboard is cross-origin to it.
    expect(
      await first.evaluate(() => [typeof (window as any).reels, typeof (window as any).require, typeof (window as any).process, window.top === window]),
    ).toEqual(["undefined", "undefined", "undefined", false]);
    expect(await first.evaluate(() => { try { return String(window.top!.location.href); } catch { return "blocked"; } })).toBe("blocked");
    expect(await main.evaluate(() => typeof window.reels!.blog!.closeCanonical)).toBe("function");
    // The main process accepts the dashboard main frame and refuses the editor subframe.
    expect(await invokeAs(app, "blog:canonicalProjects", "main")).toEqual({ ok: true, value: JSON.stringify(projects.map(({ id, title }) => ({ id, title }))) });
    expect(await invokeAs(app, "blog:canonicalProjects", "editor")).toEqual({ ok: false, value: "Untrusted IPC sender" });
    expect(await invokeAs(app, "loadDashboard", "editor")).toEqual({ ok: false, value: "Untrusted IPC sender" });

    // An unsaved edit and the page itself survive switching menus (the iframe is never reloaded).
    await first.evaluate(() => { (window as any).qaMarker = "kept"; });
    const manuscript = first.frameLocator('iframe[title="정본 본문 편집"]');
    await manuscript.locator('[data-tid="P2"]').fill("Edited inside the tab");
    await main.getByRole("button", { name: "대시보드", exact: true }).click();
    await expect(editorIframe(main, "first")).toBeHidden();
    await main.getByRole("button", { name: "블로그", exact: true }).click();
    await expect(editorIframe(main, "first")).toBeVisible();
    expect(await first.evaluate(() => (window as any).qaMarker)).toBe("kept");
    await expect(manuscript.locator('[data-tid="P2"]')).toHaveText("Edited inside the tab");
    await expect(first.locator("#ce-save-status")).toContainText("✓ 저장 완료", { timeout: 15000 });
    await expect.poll(() => readFile(projects[0].config.canon, "utf8")).toContain("Edited inside the tab");

    // A second project gets its own tab and server; the first stays mounted but hidden.
    const second = await openBlogEditor(app, main, "second", card("second"));
    expect(new URL(second.url()).origin).not.toBe(new URL(first.url()).origin);
    await expect(editorIframe(main, "first")).toBeHidden();
    await expect(second.frameLocator('iframe[title="정본 본문 편집"]').locator('[data-tid="P2"]')).toHaveText("Second line");
    await main.getByRole("button", { name: "first project", exact: true }).click();
    await expect(editorIframe(main, "first")).toBeVisible();
    await expect(editorIframe(main, "second")).toBeHidden();
    // Reopening an open project selects its tab instead of reloading it.
    await main.getByRole("button", { name: "프로젝트", exact: true }).click();
    await card("first").getByRole("button", { name: "프로젝트 열기", exact: true }).click();
    await expect(editorIframe(main, "first")).toBeVisible();
    await expect(main.locator("iframe.blog-editor-frame")).toHaveCount(2);
    expect(await first.evaluate(() => (window as any).qaMarker)).toBe("kept");
    await main.screenshot({ path: testInfo.outputPath("blog-editor-tab.png") });

    await closeEditorTab(main, "second project");
    await expect(main.locator("iframe.blog-editor-frame")).toHaveCount(1);
    await expect(editorIframe(main, "first")).toBeVisible();
    await closeEditorTab(main, "first project");
    await expect(main.locator("iframe.blog-editor-frame")).toHaveCount(0);
    await expect(card("first")).toBeVisible();
    expect(await windowCount(app)).toBe(windows);
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

test("embedded editor keeps its navigation, popup and permission limits", async () => {
  const profile = await makeProfile();
  let app;
  try {
    await writeProjects(profile, ["only"]);
    app = await launchApp(profile);
    await app.evaluate(({ shell }) => {
      (globalThis as any).qaOpened = [];
      shell.openExternal = async (url: string) => { (globalThis as any).qaOpened.push(url); };
    });
    const opened = () => app!.evaluate(() => (globalThis as any).qaOpened as string[]);
    const main = await app.firstWindow();
    await main.getByRole("button", { name: "블로그", exact: true }).click();
    const windows = await windowCount(app);
    const editor = await openBlogEditor(app, main, "only");
    await editor.evaluate(() => { (window as any).qaMarker = "kept"; });

    // Scripted popups (with or without the editor focused) never open anything.
    expect(await editor.evaluate(() => window.open("https://example.com/from-script"))).toBeNull();
    await editor.locator("#ce-save-status").click();
    expect(await editor.evaluate(() => window.open("https://example.com/focused", "_blank", "noreferrer"))).toBeNull();
    // The help link is the one page that goes to the external browser.
    await chooseEditorMenu(editor, "스티커 (0)");
    await editor.getByText("네이버에서 기본 스티커 넣는 방법", { exact: true }).click();
    await editor.getByRole("link", { name: "네이버 공식 스티커 첨부 안내 ↗" }).click();
    await expect.poll(opened).toEqual([HELP_URL]);
    expect(await windowCount(app)).toBe(windows);

    // The frame cannot leave its server or move the dashboard.
    await editor.evaluate(() => { location.href = "https://example.com/away"; });
    await main.waitForTimeout(500);
    expect(new URL(editor.url()).pathname).toBe("/");
    expect(await editor.evaluate(() => (window as any).qaMarker)).toBe("kept");
    expect(await editor.evaluate(() => { try { window.top!.location.href = "https://example.com/top"; return "moved"; } catch { return "blocked"; } })).toBe("blocked");
    expect(main.url()).toMatch(/\/dist\/index\.html/);

    // Permissions stay refused.
    expect(await editor.evaluate(async () => (await navigator.permissions.query({ name: "notifications" as PermissionName })).state)).toBe("denied");
    expect(await editor.evaluate(() => navigator.clipboard.readText().then(() => "read", () => "refused"))).toBe("refused");
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

test("closing a tab with changes not in the file reports them; background QA proceeds without a dialog", async () => {
  const profile = await makeProfile();
  let app;
  const root = path.join(profile, "only");
  try {
    const [project] = await writeProjects(profile, ["only"]);
    app = await launchApp(profile);
    await app.evaluate(({ dialog }) => {
      (globalThis as any).qaDialogs = 0;
      const original = dialog.showMessageBoxSync;
      dialog.showMessageBoxSync = ((...args: Parameters<typeof original>) => { (globalThis as any).qaDialogs++; return original(...args); }) as typeof original;
    });
    const main = await app.firstWindow();
    await main.getByRole("button", { name: "블로그", exact: true }).click();
    const editor = await openBlogEditor(app, main, "only");
    const close = () => main.evaluate(() => window.reels!.blog!.closeCanonical!("only"));
    expect(await close()).toEqual({ close: true, unsaved: false });

    // A save that cannot reach the file keeps the page's beforeunload warning armed.
    await chmod(root, 0o555);
    await editor.frameLocator('iframe[title="정본 본문 편집"]').locator('[data-tid="P2"]').fill("Not in the file yet");
    await expect(editor.locator("#ce-save-status")).toContainText("저장 실패", { timeout: 15000 });
    expect(await close()).toEqual({ close: true, unsaved: true });
    expect(await app.evaluate(() => (globalThis as any).qaDialogs)).toBe(0);
    // The renderer only asked; the tab is still there with the edit.
    await expect(editorIframe(main, "only")).toBeVisible();

    await chmod(root, 0o755);
    await editor.getByRole("button", { name: "정본 저장", exact: true }).click();
    await expect(editor.locator("#ce-save-status")).toContainText("✓ 저장 완료", { timeout: 15000 });
    expect(await readFile(project.config.canon, "utf8")).toContain("Not in the file yet");
    expect(await close()).toEqual({ close: true, unsaved: false });
    await closeEditorTab(main, "only project");
  } finally {
    await chmod(root, 0o755).catch(() => {});
    await closeApp(app);
    await cleanProfile(profile);
  }
});

test("dev mode: the terminal panel opens over the blog tab and the editor shrinks above it", async ({}, testInfo) => {
  const profile = await makeProfile();
  let app;
  try {
    await writeProjects(profile, ["only"]);
    app = await launchApp(profile, true, { REELS_DEV_MODE: "1" });
    const main = await app.firstWindow();
    await main.getByRole("button", { name: "블로그", exact: true }).click();
    const editor = await openBlogEditor(app, main, "only");
    const iframe = editorIframe(main, "only");
    const drawer = main.getByRole("region", { name: "터미널", exact: true });
    await expect(drawer).toBeHidden();
    const closedHeight = (await iframe.boundingBox())!.height;

    // ⌘N while the keyboard is inside the embedded editor still reaches the host shortcut.
    await editor.frameLocator('iframe[title="정본 본문 편집"]').locator('[data-tid="P2"]').click();
    await pressWorkbenchKey(app, "n");
    await expect(drawer).toBeVisible();
    await expect(iframe).toBeVisible();
    await expect.poll(async () => {
      const frame = (await iframe.boundingBox())!, panel = (await drawer.boundingBox())!;
      return frame.y + frame.height <= panel.y + 1;
    }).toBe(true);
    expect((await iframe.boundingBox())!.height).toBeLessThan(closedHeight);
    await main.screenshot({ path: testInfo.outputPath("blog-editor-terminal.png") });

    // The editor's own ⌘S still saves from inside the frame.
    await editor.frameLocator('iframe[title="정본 본문 편집"]').locator('[data-tid="P2"]').fill("Saved with Cmd+S");
    await editor.frameLocator('iframe[title="정본 본문 편집"]').locator('[data-tid="P2"]').press("Meta+s");
    await expect(editor.locator("#ce-save-status")).toContainText("✓ 저장 완료", { timeout: 15000 });

    // ⌘N again folds the panel to its bar; the editor grows back but stays above it.
    const openHeight = (await iframe.boundingBox())!.height;
    await pressWorkbenchKey(app, "n");
    await expect(drawer).toHaveAttribute("data-drawer-state", "folded");
    await expect.poll(async () => {
      const frame = (await iframe.boundingBox())!, panel = (await drawer.boundingBox())!;
      return frame.y + frame.height <= panel.y + 1 && frame.height > openHeight;
    }).toBe(true);
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

test("stubbed real dialogs: 계속 편집 keeps the tab and the window, and the next attempt asks again; 그래도 닫기 closes", async () => {
  const profile = await makeProfile();
  let app;
  const root = path.join(profile, "only");
  try {
    await writeProjects(profile, ["only"]);
    // Background QA stays on (no visible window); this switch only lets the dialog branches run against the stub below.
    app = await launchApp(profile, true, { REELS_QA_STUBBED_DIALOGS: "1" });
    const qaApp: ElectronApplication = app;
    await app.evaluate(({ dialog }) => {
      const qa = globalThis as any;
      qa.qaChoice = 1;
      qa.qaDialogs = [];
      dialog.showMessageBoxSync = ((...args: any[]) => {
        const options = args.length > 1 ? args[1] : args[0];
        qa.qaDialogs.push(`${options.message}|${options.buttons.join("/")}`);
        return qa.qaChoice;
      }) as typeof dialog.showMessageBoxSync;
    });
    const dialogs = () => qaApp.evaluate(() => (globalThis as any).qaDialogs as string[]);
    const choose = (choice: number) => qaApp.evaluate((_e, choice) => { (globalThis as any).qaChoice = choice; }, choice);
    const EDITOR_DIALOG = "아직 파일에 저장되지 않은 변경이 있어요.|그래도 닫기/계속 편집";
    const main = await app.firstWindow();
    await main.getByRole("button", { name: "블로그", exact: true }).click();
    const editor = await openBlogEditor(app, main, "only");

    // Clean editor: closing the window region / tab asks nothing.
    expect(await main.evaluate(() => window.reels!.blog!.closeCanonical!("only"))).toEqual({ close: true, unsaved: false });
    expect(await dialogs()).toEqual([]);

    await chmod(root, 0o555);
    await editor.frameLocator('iframe[title="정본 본문 편집"]').locator('[data-tid="P2"]').fill("Still unsaved");
    await expect(editor.locator("#ce-save-status")).toContainText("저장 실패", { timeout: 15000 });

    // Tab ×, 계속 편집: the tab stays.
    await main.getByRole("button", { name: "only project 탭 닫기", exact: true }).click();
    await expect.poll(dialogs).toEqual([EDITOR_DIALOG]);
    await expect(editorIframe(main, "only")).toBeVisible();

    // Window close, 계속 편집 twice: the window stays and the second attempt asks again.
    const closeWindow = () => qaApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/dist/index.html"))!.close();
    });
    for (const expected of [2, 3]) {
      await closeWindow();
      await expect.poll(async () => (await dialogs()).length).toBe(expected);
      expect((await dialogs()).at(-1)).toBe(EDITOR_DIALOG);
      await main.waitForTimeout(300);
      expect(await windowCount(app)).toBe(1);
      await expect(editorIframe(main, "only")).toBeVisible();
    }

    // Tab ×, 그래도 닫기: the tab goes.
    await choose(0);
    await main.getByRole("button", { name: "only project 탭 닫기", exact: true }).click();
    await expect(main.getByRole("button", { name: "only project", exact: true })).toHaveCount(0);
    expect(await dialogs()).toEqual([EDITOR_DIALOG, EDITOR_DIALOG, EDITOR_DIALOG, EDITOR_DIALOG]);

    // Another screen's guard (as the 원고·배치 draft or the experience form register) gets the general wording,
    // whether the editor probe finds it (editor tab open) or Electron's own beforeunload does (no editor).
    await chmod(root, 0o755);
    const GENERAL_DIALOG = "저장하지 않은 변경이 있어요.|그래도 닫기/계속 편집";
    await main.evaluate(() => addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = ""; }));
    await choose(1);
    await openBlogEditor(app, main, "only");
    await closeWindow();
    await expect.poll(async () => (await dialogs()).at(-1)).toBe(GENERAL_DIALOG);
    expect(await dialogs()).toHaveLength(5);
    await closeEditorTab(main, "only project");
    await main.getByRole("button", { name: "프로젝트", exact: true }).click();
    await closeWindow();
    await expect.poll(async () => (await dialogs()).length).toBe(6);
    expect((await dialogs()).at(-1)).toBe(GENERAL_DIALOG);
    await main.waitForTimeout(300);
    expect(await windowCount(app)).toBe(1);
  } finally {
    await chmod(root, 0o755).catch(() => {});
    await closeApp(app);
    await cleanProfile(profile);
  }
});

test("a changed connection opens with the new config once its tabs are closed (old server stopped)", async () => {
  const profile = await makeProfile();
  let app;
  try {
    const [project] = await writeProjects(profile, ["only"]);
    app = await launchApp(profile);
    const main = await app.firstWindow();
    await main.getByRole("button", { name: "블로그", exact: true }).click();
    const old = await openBlogEditor(app, main, "only");
    const oldOrigin = new URL(old.url()).origin;

    // Point the project at another manuscript while its tab is open.
    const moved = path.join(profile, "moved");
    await mkdir(moved);
    const config = await markupFixture(moved);
    await writeFile(config.canon, (await readFile(config.canon, "utf8")).replace("Second line", "New connection line"));
    await writeFile(path.join(profile, "blog-projects.json"), JSON.stringify({ version: 1, projects: [{ ...project, config }] }));

    await main.getByRole("button", { name: "프로젝트", exact: true }).click();
    await main.getByRole("button", { name: "프로젝트 열기", exact: true }).click();
    await expect(main.getByRole("alert")).toContainText("프로젝트 연결이 변경됐어요");
    await expect(main.locator("iframe.blog-editor-frame")).toHaveCount(1);

    await closeEditorTab(main, "only project");
    // The pagehide grace passes, then the old server is gone.
    await expect.poll(() => fetch(oldOrigin + "/api/blog/document").then(() => "up", () => "down"), { timeout: 15000 }).toBe("down");

    const fresh = await openBlogEditor(app, main, "only");
    expect(new URL(fresh.url()).origin).not.toBe(oldOrigin);
    await expect(fresh.frameLocator('iframe[title="정본 본문 편집"]').locator('[data-tid="P2"]')).toHaveText("New connection line");
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

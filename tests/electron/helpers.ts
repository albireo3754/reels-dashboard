import {
  _electron,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export async function makeProfile(): Promise<string> {
  return mkdtemp(join(tmpdir(), "reels-electron-qa-"));
}

// Direct terminal sessions run the product's `/bin/zsh -l` / `-lc`. Pointing ZDOTDIR at an
// empty folder keeps that login path but skips the developer's own ~/.zshenv, ~/.zprofile and
// ~/.zshrc (conda hooks, ssh-add, prompts), which otherwise cost CPU per PTY and make QA depend on
// the local profile. The empty .zshenv also stops zsh-newuser-install from prompting.
let qaZdotdir: string | undefined;
function emptyZdotdir(): string {
  if (!qaZdotdir) {
    const dir = mkdtempSync(join(tmpdir(), "reels-electron-qa-zsh-"));
    writeFileSync(join(dir, ".zshenv"), "");
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
    qaZdotdir = dir;
  }
  return qaZdotdir;
}

export async function launchApp(
  profile: string,
  demo = true,
  envOverrides: Record<string, string | undefined> = {},
): Promise<ElectronApplication> {
  const env: Record<string, string> = {};
  // The app embeds a workflow server unless REELS_WORKFLOW_URL is set. Never let a
  // parent shell's workflow settings point QA at the user's real server (4318) or data.
  const workflowKeys = [
    "REELS_WORKFLOW_URL",
    "REELS_WORKFLOW_PORT",
    "REELS_WORKFLOW_DATA",
  ];
  for (const [key, value] of Object.entries(process.env)) {
    if (
      typeof value === "string" &&
      key !== "ELECTRON_RUN_AS_NODE" &&
      !workflowKeys.includes(key)
    )
      env[key] = value;
  }
  if (envOverrides.REELS_WORKFLOW_URL === undefined) {
    env.REELS_WORKFLOW_PORT = "0";
    env.REELS_WORKFLOW_DATA = join(profile, "workflow-data");
  }
  env.REELS_BACKGROUND_QA =
    process.env.REELS_ELECTRON_HEADED === "1" ? "0" : "1";
  env.REELS_USER_DATA = profile;
  env.REELS_DEMO = demo ? "1" : "0";
  // Terminal sessions default to herdr when installed. Keep existing scenarios
  // deterministic (and off the user's herdr server); herdr scenarios opt in below.
  env.REELS_TERMINAL_BACKEND = "direct";
  env.ZDOTDIR = emptyZdotdir();
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const executablePath = process.env.REELS_ELECTRON_EXECUTABLE;
  return _electron.launch({
    ...(executablePath
      ? { executablePath, args: [] }
      : { args: [resolve(".")] }),
    cwd: resolve("."),
    env,
    timeout: 30_000,
  });
}

export type SharedApp = {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly profile: string;
};

/**
 * One demo app for every test in the calling file (or describe). Use it only for tests whose
 * state lives in the renderer and in workbench sessions: before each test every session is
 * closed, the window size and renderer storage are reset and the page reloads. Tests that seed
 * the profile, stub main-process handlers or dialogs, or restart the app keep their own launch.
 */
export function useSharedApp(
  envOverrides: Record<string, string | undefined> = {},
): SharedApp {
  let current: { app: ElectronApplication; page: Page; profile: string } | undefined;
  const get = () => {
    if (!current) throw new Error("The shared app is only available inside a test.");
    return current;
  };
  test.beforeAll(async () => {
    const profile = await makeProfile();
    const app = await launchApp(profile, true, envOverrides);
    current = { app, profile, page: await app.firstWindow() };
  });
  test.beforeEach(async () => {
    const { app, page } = get();
    await page.evaluate(async () => {
      const workbench = window.reels?.workbench;
      if (!workbench) return;
      for (const session of (await workbench.state()).sessions)
        await workbench.close(session.id);
    });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setSize(1600, 1000);
    });
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.reload();
  });
  test.afterAll(async () => {
    await closeApp(current?.app);
    if (current) await cleanProfile(current.profile);
    current = undefined;
  });
  return {
    get app() {
      return get().app;
    },
    get page() {
      return get().page;
    },
    get profile() {
      return get().profile;
    },
  };
}

export async function closeApp(
  app: ElectronApplication | undefined,
): Promise<void> {
  if (app) await app.close();
}

// Playwright's CDP keyboard events skip Electron's before-input-event hook.
// Send native Electron input while keeping the QA window hidden/unfocusable.
export async function pressWorkbenchKey(
  app: ElectronApplication,
  key: string,
  modifiers: readonly ("meta" | "shift" | "control" | "alt")[] = ["meta"],
) {
  await app.evaluate(({ BrowserWindow }, { keyCode, modifiers }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => {
      const url = candidate.webContents.getURL();
      return (
        url.startsWith("file:") &&
        new URL(url).pathname.endsWith("/dist/index.html")
      );
    });
    if (!window)
      throw new Error("The app's trusted renderer window is unavailable.");
    window.webContents.sendInputEvent({
      type: "keyDown",
      keyCode,
      modifiers,
    });
    window.webContents.sendInputEvent({
      type: "keyUp",
      keyCode,
      modifiers,
    });
  }, { keyCode: key.toUpperCase(), modifiers: [...modifiers] });
}

export async function cleanProfile(profile: string): Promise<void> {
  await rm(profile, { recursive: true, force: true });
}

export function editorRuntime(): string {
  return process.env.REELS_ELECTRON_EXECUTABLE
    ? resolve(
        dirname(process.env.REELS_ELECTRON_EXECUTABLE),
        "../Resources/editor-runtime",
      )
    : resolve("native/editor-engine/.build/runtime");
}

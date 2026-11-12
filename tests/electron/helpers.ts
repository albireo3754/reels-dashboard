import { _electron, type ElectronApplication } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export async function makeProfile(): Promise<string> {
  return mkdtemp(join(tmpdir(), "reels-electron-qa-"));
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

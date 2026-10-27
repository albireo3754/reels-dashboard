import { _electron, type ElectronApplication } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export async function makeProfile(): Promise<string> {
  return mkdtemp(join(tmpdir(), "reels-electron-qa-"));
}

export async function launchApp(
  profile: string,
  demo = true,
): Promise<ElectronApplication> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && key !== "ELECTRON_RUN_AS_NODE")
      env[key] = value;
  }
  env.REELS_USER_DATA = profile;
  env.REELS_DEMO = demo ? "1" : "0";
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

export async function cleanProfile(profile: string): Promise<void> {
  await rm(profile, { recursive: true, force: true });
}

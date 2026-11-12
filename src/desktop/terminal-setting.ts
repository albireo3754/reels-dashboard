import path from "node:path";
import { mkdir } from "node:fs/promises";
import { readJsonFile, writeJsonAtomic } from "../shared/lib/fs";
import type { TerminalSetting } from "../shared/contracts";
import { developmentModeEnabled } from "./development-mode";

/**
 * Settings toggle for the terminal workspace, stored per Mac in userData.
 * The workspace is decided once at startup (PTY IPC is registered only when on),
 * so a change applies on the next launch.
 */
export class TerminalSettingStore {
  constructor(private root: string) {}
  private get file() {
    return path.join(this.root, "terminal-settings.json");
  }
  async get(): Promise<boolean> {
    return readJsonFile(
      this.file,
      (value) =>
        typeof value === "object" && value !== null &&
        (value as { enabled?: unknown }).enabled === true,
      () => false,
    ).catch(() => false);
  }
  async set(enabled: unknown): Promise<boolean> {
    if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean.");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(this.file, { enabled }, { mode: 0o600 });
    return enabled;
  }
}

/** REELS_DEV_MODE=1 forces the workspace on; otherwise the saved toggle decides. */
export function resolveTerminalSetting(
  env: Readonly<Record<string, string | undefined>>,
  saved: boolean,
  active: boolean,
): TerminalSetting {
  const forced = developmentModeEnabled(env);
  return { enabled: saved, forcedByEnvironment: forced, active };
}

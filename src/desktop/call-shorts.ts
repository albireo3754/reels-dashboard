import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { loadConfig } from "../../pipelines/call-shorts/src/config";
import { isProcessable } from "../../pipelines/call-shorts/src/watcher";
import { notesErrorStatus, syncNotesRecordings } from "./notes-recordings-sync";
import type { CallShortsSnapshot, NotesRecordingStatus } from "../shared/call-shorts";

const stateSchema = z.object({
  files: z.record(z.string(), z.object({
    sourcePath: z.string(), status: z.string(), updatedAt: z.string(),
  })),
});

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function callShortsSource(repo: string, profile: string, probe: string, active: boolean) {
  const config = () => loadConfig({ dotenvPath: path.join(repo, "pipelines/call-shorts/.env") });
  let syncing: Promise<NotesRecordingStatus> | undefined;
  const sync = (): Promise<NotesRecordingStatus> => {
    if (!active) return Promise.resolve("waiting");
    syncing ??= Promise.resolve().then(() => syncNotesRecordings(config().inboxDir, profile, probe))
      .catch(notesErrorStatus).finally(() => { syncing = undefined; });
    return syncing;
  };
  const timer = active ? setInterval(() => void sync(), 60_000) : undefined;
  if (active) void sync();
  return {
    status: async () => callShortsStatus(config(), await sync()),
    stop: () => clearInterval(timer),
  };
}

async function callShortsStatus(config: ReturnType<typeof loadConfig>, notes: NotesRecordingStatus): Promise<CallShortsSnapshot> {
  const cloud = path.join(homedir(), "Library/Mobile Documents/com~apple~CloudDocs");
  const inbox = config.inboxDir.startsWith(cloud + path.sep)
    ? path.join("iCloud Drive", path.relative(cloud, config.inboxDir)) : config.inboxDir;
  let inboxCount: number | null = null;
  try {
    const entries = await readdir(config.inboxDir, { withFileTypes: true });
    inboxCount = entries.filter(entry => entry.isFile() && isProcessable(entry.name, config.allowedExtensions)).length;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  let recent: CallShortsSnapshot["recent"] = [];
  try {
    const state = stateSchema.parse(JSON.parse(await readFile(config.stateFile, "utf8")));
    recent = Object.values(state.files).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 10).map(file => ({ name: path.basename(file.sourcePath), status: file.status }));
  } catch (error) {
    if (!missing(error)) throw error;
  }
  return { notes, inbox, inboxCount, recent };
}

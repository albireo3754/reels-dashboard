import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { NotesRecordingStatus } from "../shared/call-shorts";

const exec = promisify(execFile);
// Match on the Mac, then return attachment references only from the recording folder.
const notesScript = `
function run(args) {
  const notes = Application("com.apple.Notes");
  if (args[0] === "save") {
    const attachment = notes.notes.byId(args[1]).attachments.byId(args[2]);
    notes.save(attachment, {in: Path(args[3])});
    return;
  }
  const result = { folders: 0, notes: 0, attachments: [] };
  for (const account of notes.accounts()) {
    const folders = account.folders.whose({_or:[{name:"통화 녹음"},{name:"Call Recordings"}]})();
    for (const folder of folders) {
      result.folders++;
      for (const note of folder.notes()) {
        result.notes++;
        if (note.passwordProtected()) continue;
        for (const attachment of note.attachments()) {
          result.attachments.push({ note: note.id(), id: attachment.id(), name: attachment.name() || "" });
        }
      }
    }
  }
  return JSON.stringify(result);
}`;
const listing = z.object({ folders: z.number(), notes: z.number(), attachments: z.array(
  z.object({ note: z.string(), id: z.string(), name: z.string() }),
) });
type Listing = z.infer<typeof listing>;
type Attachment = Listing["attachments"][number];

async function appleNotes(args: string[]) {
  return (await exec("/usr/bin/osascript", ["-l", "JavaScript", "-e", notesScript, ...args], {
    timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  })).stdout;
}

export const macRecordings = {
  list: async () => listing.parse(JSON.parse(await appleNotes(["list"]))),
  save: async (attachment: Attachment, target: string) => {
    await appleNotes(["save", attachment.note, attachment.id, target]);
  },
};

async function hasFile(file: string) {
  try { return (await stat(file)).isFile(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// Export to a hidden staging directory. The inbox scanner only sees complete recordings.
export async function syncNotesRecordings(inbox: string, profile: string, probe: string, source = macRecordings): Promise<NotesRecordingStatus> {
  const entries = await source.list();
  if (!entries.folders) return "waiting";
  const ledger = path.join(profile, "notes-recordings", createHash("sha256").update(path.resolve(inbox)).digest("hex"));
  let pending = entries.notes > 0 && entries.attachments.length === 0;
  for (const item of entries.attachments) {
    const ext = path.extname(item.name).toLowerCase();
    if (ext && ![".m4a", ".mp4", ".aac", ".wav", ".caf", ".mp3", ".aif", ".aiff"].includes(ext)) continue;
    const id = createHash("sha256").update(item.note).update("\0").update(item.id).digest("hex");
    const marker = path.join(ledger, id);
    if (await hasFile(marker)) continue;
    try {
      await mkdir(inbox, { recursive: true, mode: 0o700 });
      const staging = await mkdtemp(path.join(inbox, ".notes-"));
      try {
        const tmp = path.join(staging, "recording" + (ext || ".m4a"));
        await source.save(item, tmp);
        if (!(await stat(tmp)).size) throw new Error("empty attachment");
        const { stdout } = await exec(probe, ["-v", "error", "-select_streams", "a:0", "-show_entries",
          "stream=codec_type:format=format_name", "-of", "json", tmp], { timeout: 30_000 });
        const media = JSON.parse(stdout);
        if (media.streams?.[0]?.codec_type !== "audio") throw new Error("audio not downloaded");
        const format = String(media.format?.format_name).split(",");
        const suffix = format.includes("m4a") ? ".m4a" : [".aac", ".wav", ".caf", ".mp3"].find(e => format.includes(e.slice(1)));
        if (!suffix) throw new Error("unsupported audio");
        const dest = path.join(inbox, "통화녹음-" + id.slice(0, 20) + suffix);
        await chmod(tmp, 0o600);
        if (!(await hasFile(dest))) await rename(tmp, dest);
        await mkdir(ledger, { recursive: true, mode: 0o700 });
        await writeFile(marker, "", { mode: 0o600 });
      } finally { await rm(staging, { recursive: true, force: true }); }
    } catch { pending = true; }
  }
  return pending ? "pending" : "connected";
}

export function notesErrorStatus(error: unknown): NotesRecordingStatus {
  const message = String((error as { stderr?: string })?.stderr ?? "");
  return /-1743|-1744|not authorized|not permitted/i.test(message) ? "denied" : "error";
}

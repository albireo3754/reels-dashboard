import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { callNotesPrefix, type CallNoteRecording } from "../shared/call-shorts";

// This is a narrow read-only adapter to the local copy of Notes. Do not pull
// bodies, account names, other attachments, or undownloaded cloud files.
const sql = `
  SELECT a.ZIDENTIFIER attachment, m.ZIDENTIFIER media, acct.ZIDENTIFIER account,
    m.ZFILENAME filename, a.ZFILESIZE size, n.ZCREATIONDATE3 created
  FROM ZICCLOUDSYNCINGOBJECT n
    JOIN Z_PRIMARYKEY nt ON nt.Z_ENT=n.Z_ENT AND nt.Z_NAME='ICNote'
    JOIN ZICCLOUDSYNCINGOBJECT a ON a.ZNOTE=n.Z_PK AND a.ZACCOUNT1=n.ZACCOUNT7
    JOIN Z_PRIMARYKEY at ON at.Z_ENT=a.Z_ENT AND at.Z_NAME='ICAttachment'
    JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK=n.ZFOLDER AND f.ZACCOUNT8=n.ZACCOUNT7
    JOIN Z_PRIMARYKEY ft ON ft.Z_ENT=f.Z_ENT AND ft.Z_NAME='ICFolder'
    JOIN ZICCLOUDSYNCINGOBJECT m ON m.Z_PK=a.ZMEDIA AND m.ZACCOUNT6=n.ZACCOUNT7
    JOIN Z_PRIMARYKEY mt ON mt.Z_ENT=m.Z_ENT AND mt.Z_NAME='ICMedia'
    JOIN ZICCLOUDSYNCINGOBJECT acct ON acct.Z_PK=n.ZACCOUNT7
    JOIN Z_PRIMARYKEY acctt ON acctt.Z_ENT=acct.Z_ENT AND acctt.Z_NAME='ICAccount'
  WHERE n.ZISPASSWORDPROTECTED=0
    AND n.ZMARKEDFORDELETION=0 AND a.ZMARKEDFORDELETION=0
    AND f.ZMARKEDFORDELETION=0 AND m.ZMARKEDFORDELETION=0 AND acct.ZMARKEDFORDELETION=0
    AND (f.ZIDENTIFIER='DefaultFolder-CloudKit' OR f.ZTITLE2 IN ('통화 녹음','Call Recordings'))
    AND substr(n.ZTITLE1, 1, length(?1)) = ?1
    AND n.ZCREATIONDATE3 IS NOT NULL
    AND a.ZTYPEUTI IN ('public.mpeg-4-audio','com.apple.quicktime-movie','public.mpeg-4','public.movie')
    AND lower(m.ZFILENAME) GLOB 'moments_*-audio.mov'
  ORDER BY n.ZCREATIONDATE3 DESC, a.Z_PK DESC LIMIT 2`;
const uuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
const row = z.object({
  attachment: uuid, media: uuid, account: uuid,
  filename: z.string().regex(/^moments_[-0-9_]{1,80}-audio\.mov$/i),
  size: z.number().int().positive().max(256_000_000),
  created: z.number().gt(0).lt(3_000_000_000),
});
export const callNotesPrefixSchema = z.string().max(80).refine(value => value.startsWith(callNotesPrefix)
  && !/[\p{Cc}\p{Cf}]/u.test(value));
export const callNotesSelection = z.object({ prefix: callNotesPrefixSchema,
  ids: z.array(z.string().regex(/^[a-f0-9]{24}$/)).min(1).max(2) });
const millis = (n: number) => Math.round((n + 978307200) * 1000);
const storageDir = /^\d+_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

type Candidate = CallNoteRecording & { sourcePath?: string; size: number; outputStem: string };
async function strictDir(directory: string) {
  return (await lstat(directory)).isDirectory() && await realpath(directory) === directory;
}
async function mediaPath(notesRoot: string, payload: z.infer<typeof row>) {
  const mediaDir = path.join(notesRoot, "Accounts", payload.account, "Media", payload.media);
  if (!mediaDir.startsWith(notesRoot + path.sep)) return;
  try {
    if (!await strictDir(mediaDir)) return;
    const children = await readdir(mediaDir, { withFileTypes: true });
    const good: string[] = [];
    for (const child of children) {
      if (!child.isDirectory() || !storageDir.test(child.name)) continue;
      const candidate = path.join(mediaDir, child.name, payload.filename);
      const st = await lstat(candidate).catch(() => undefined);
      if (!st?.isFile() || st.size !== payload.size ||
          await realpath(candidate) !== candidate) continue;
      good.push(candidate);
    }
    if (good.length === 1) return good[0];
  } catch { /* Non-local or ambiguous attachment. */ }
}
export async function recentNotesRecordings(root: string, prefix: string): Promise<Candidate[]> {
  const safePrefix = callNotesPrefixSchema.parse(prefix);
  let rows: unknown[];
  try {
    const notesRoot = await realpath(root);
    if (!await strictDir(notesRoot)) throw new Error();
    const file = path.join(notesRoot, "NoteStore.sqlite");
    if (!(await lstat(file)).isFile() || await realpath(file) !== file) throw new Error();
    const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
    try {
      db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1500");
      rows = db.prepare(sql).all(safePrefix);
    } finally { db.close(); }
    const candidates: Candidate[] = [];
    for (const item of rows) {
      const a = row.parse(item);
      const sourcePath = await mediaPath(notesRoot, a);
      const createdAt = new Date(millis(a.created)).toISOString();
      const id = createHash("sha256").update(a.account).update("\0").update(a.attachment).digest("hex").slice(0, 24);
      const stamp = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul",
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
        hourCycle: "h23" }).format(new Date(createdAt)).replace(" ", "-").replaceAll(":", "_");
      candidates.push({ id, createdAt, available: !!sourcePath, sourcePath, size: a.size,
        outputStem: "통화녹음-" + stamp + "-" + id.slice(0, 8) });
    }
    return candidates;
  } catch {
    throw new Error("Mac에 동기화된 메모를 읽을 수 없어요. 메모가 이 Mac에 표시되는지 확인해 주세요.");
  }
}
export async function withImportedCallNotes<T>(
  notesRoot: string, localRoot: string, raw: unknown,
  transfer: (inputs: Array<{ sourcePath: string; outputStem: string }>, outputDir: string) => Promise<T>,
) {
  const { prefix, ids } = callNotesSelection.parse(raw);
  const actual = await recentNotesRecordings(notesRoot, prefix);
  if (JSON.stringify(ids) !== JSON.stringify(actual.map(item => item.id)))
    throw new Error("최근 녹음이 바뀌었어요. 먼저 목록을 다시 확인해 주세요.");
  if (actual.some(item => !item.available)) throw new Error("일부 파일이 아직 Mac에 내려오지 않았어요. 메모에서 확인한 뒤 다시 시도해 주세요.");
  await mkdir(localRoot, { recursive: true, mode: 0o700 });
  const dir = await lstat(localRoot);
  const resolved = await realpath(localRoot);
  if (!dir.isDirectory() || (dir.mode & 0o077) || (process.getuid && dir.uid !== process.getuid()))
    throw new Error("로컬 전사 저장 폴더는 소유자만 접근할 수 있어야 해요.");
  const staging = await mkdtemp(path.join(resolved, ".import-"));
  try {
    const inputs = [];
    for (const item of actual) {
      const sourcePath = path.join(staging, item.outputStem + ".mov");
      // Revalidate before copying: cannot replace a Notes file with a link.
      const original = item.sourcePath!;
      const st = await lstat(original);
      if (!st.isFile() || st.size !== item.size || await realpath(original) !== original)
        throw new Error("동기화 중 녹음 파일이 바뀌었어요. 다시 확인해 주세요.");
      await copyFile(original, sourcePath, constants.COPYFILE_EXCL);
      await chmod(sourcePath, 0o600);
      if ((await lstat(sourcePath)).size !== item.size) throw new Error("메모 사본의 크기를 확인하지 못했어요.");
      inputs.push({ sourcePath, outputStem: item.outputStem });
    }
    return await transfer(inputs, resolved);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

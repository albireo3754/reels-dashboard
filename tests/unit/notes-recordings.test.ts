import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { recentNotesRecordings, withImportedCallNotes } from "../../src/desktop/notes-recordings";

const id = (n: number) => `11111111-1111-1111-1111-${String(n).padStart(12, "0")}`;
async function fixture<T>(fn: (notes: string, output: string, setUnavailable: () => Promise<void>) => Promise<T>) {
  const dir = await mkdtemp(path.join(tmpdir(), "notes-import-"));
  const notes = path.join(dir, "Notes");
  const output = path.join(dir, "Output");
  await mkdir(notes, { mode: 0o700 });
  const db = new DatabaseSync(path.join(notes, "NoteStore.sqlite"));
  try {
    db.exec(`CREATE TABLE Z_PRIMARYKEY(Z_ENT INT, Z_NAME TEXT);
      INSERT INTO Z_PRIMARYKEY VALUES (11,'ICNote'),(4,'ICAttachment'),(14,'ICFolder'),(10,'ICMedia'),(13,'ICAccount');
      CREATE TABLE ZICCLOUDSYNCINGOBJECT (
        Z_PK INT, Z_ENT INT, ZMARKEDFORDELETION INT DEFAULT 0, ZIDENTIFIER TEXT,
        ZTITLE1 TEXT, ZTITLE2 TEXT, ZISPASSWORDPROTECTED INT DEFAULT 0,
        ZNOTE INT, ZACCOUNT1 INT, ZACCOUNT6 INT, ZACCOUNT7 INT, ZACCOUNT8 INT,
        ZFOLDER INT, ZMEDIA INT, ZFILESIZE INT, ZFILENAME TEXT, ZTYPEUTI TEXT, ZCREATIONDATE3 REAL
      );
      INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK,Z_ENT,ZIDENTIFIER,ZACCOUNT8) VALUES (1,14,'DefaultFolder-CloudKit',2),(204,14,'UnrelatedFolder',2);
      INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK,Z_ENT,ZIDENTIFIER) VALUES (2,13,'${id(2)}');`);
    const note = db.prepare("INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK,Z_ENT,ZCREATIONDATE3,ZTITLE1,ZFOLDER,ZACCOUNT7,ZISPASSWORDPROTECTED) VALUES (?,11,?,?,?,?,?)");
    const attach = db.prepare("INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK,Z_ENT,ZIDENTIFIER,ZNOTE,ZACCOUNT1,ZMEDIA,ZTYPEUTI,ZFILESIZE) VALUES (?,4,?,?,2,?,'public.mpeg-4-audio',7)");
    const media = db.prepare("INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK,Z_ENT,ZIDENTIFIER,ZACCOUNT6,ZFILENAME) VALUES (?,10,?,2,?)");
    let latest = "";
    for (const [i, title, folder, locked] of [
      [3, "Call with Mock", 1, 0], [4, "Call with Mock", 1, 0], [5, "Call with Mock", 1, 0],
      [6, "Different Mock", 1, 0], [7, "Call with Mock", 1, 1], [8, "Call with Mock", 204, 0],
    ] as const) {
      const name = `moments_11_22_00_00_0${i}-audio.MOV`;
      note.run(i, 817_000_000 + i, title, folder, 2, locked);
      attach.run(10+i, id(10+i), i, 20+i);
      media.run(20+i, id(20+i), name);
      const storage = path.join(notes, "Accounts", id(2), "Media", id(20+i), "1_" + id(30+i));
      await mkdir(storage, { recursive: true });
      const attachment = path.join(storage, name);
      await writeFile(attachment, `audio.${i}`);
      if (i === 5) latest = attachment;
    }
    return await fn(notes, output, async () => {
      await rm(latest);
      // Do not follow an attachment symlink, even to identical-sized bytes.
      const replacement = path.join(dir, "external.bin");
      await writeFile(replacement, "audio.5");
      await symlink(replacement, latest);
    });
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
}

test("Notes selection is prefix-bound, latest two, excludes locked and other folders", async () => fixture(async notes => {
  const list = await recentNotesRecordings(notes, "Call with ");
  assert.equal(list.length, 2);
  assert.ok(list[0].createdAt > list[1].createdAt);
  assert.ok(list.every((r) => r.available && r.outputStem.startsWith("통화녹음-")));
  assert.ok(list[0].sourcePath?.endsWith("05-audio.MOV"));
  assert.ok(list[1].sourcePath?.endsWith("04-audio.MOV"));
  assert.deepEqual(await recentNotesRecordings(notes, "Call with x' OR 1=1"), []);
  await assert.rejects(recentNotesRecordings(notes, ""));
}));
test("transcribe uses only ids previewed, private revision-matched copies and cleans staging", async () => fixture(async (notes, output) => {
  const list = await recentNotesRecordings(notes, "Call with ");
  const ids = list.map(x => x.id);
  await assert.rejects(withImportedCallNotes(notes, output, { prefix: "Call with ", ids: [...ids].reverse() },
    async () => assert.fail("stale request must not dispatch")), /바뀌었어요/);
  assert.equal(await withImportedCallNotes(notes, output, { prefix: "Call with ", ids }, async (files, dest) => {
    assert.equal((await stat(dest)).mode & 0o777, 0o700);
    assert.equal((await stat(files[0].sourcePath)).mode & 0o777, 0o600);
    assert.deepEqual(await Promise.all(files.map(x => readFile(x.sourcePath, "utf8"))), ["audio.5", "audio.4"]);
    assert.ok(files.every(x => !x.sourcePath.startsWith(notes)));
    await writeFile(path.join(dest, "synthetic.txt"), "result");
    return files.length;
  }), 2);
  assert.deepEqual(await readdir(output), ["synthetic.txt"]);
  assert.equal(await readFile(list[0].sourcePath!, "utf8"), "audio.5");
}));
test("unavailable newest is not skipped or copied and symlinks are rejected", async () => fixture(async (notes, output, setUnavailable) => {
  await setUnavailable();
  const list = await recentNotesRecordings(notes, "Call with ");
  assert.deepEqual(list.map(x => x.available), [false, true]);
  await assert.rejects(withImportedCallNotes(notes, output, { prefix: "Call with ", ids: list.map(x => x.id) },
    async () => assert.fail("non-local request must not dispatch")), /내려오지/);
}));

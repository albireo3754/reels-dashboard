import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncNotesRecordings } from "../../src/desktop/notes-recordings-sync";

test("메모 첨부는 실패 후 재시도하고 완성된 녹음만 한 번 전달한다", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "notes-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inbox = path.join(root, "inbox");
  const probe = path.join(root, "probe");
  await writeFile(probe, '#!/bin/sh\necho \'{"streams":[{"codec_type":"audio"}],"format":{"format_name":"mov,mp4,m4a"}}\'\n', { mode: 0o700 });
  const item = { note: "note", id: "audio", name: "전화.m4a" };
  let tries = 0;
  const reader = {
    list: async () => ({ folders: 1, notes: 1, attachments: [item, { ...item, id: "pdf", name: "file.pdf" }] }),
    save: async (_: typeof item, target: string) => {
      tries++;
      await writeFile(target, tries === 1 ? "" : "synthetic audio");
    },
  };
  await mkdir(inbox);
  const sync = () => syncNotesRecordings(inbox, root, probe, reader);
  assert.equal(await sync(), "pending");
  assert.deepEqual(await readdir(inbox), []);
  assert.equal(await sync(), "connected");
  const files = await readdir(inbox);
  assert.equal(files.length, 1);
  assert.match(files[0], /^통화녹음-[0-9a-f]+\.m4a$/);
  await rm(path.join(inbox, files[0]));
  await sync();
  assert.deepEqual(await readdir(inbox), []);
  assert.equal(tries, 2);
});

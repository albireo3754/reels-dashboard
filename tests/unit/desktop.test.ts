import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readFile,
  symlink,
  writeFile,
  mkdir,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:net";
import {
  LocalStore,
  safeDocumentName,
  resolveGrantedFile,
} from "../../src/shared/lib/storage";
import { validateRequest, sendNative } from "../../src/desktop/native";
test("request validation rejects arbitrary methods, flags, NUL and untyped args", () => {
  assert.throws(() => validateRequest("shell", {}));
  assert.throws(() => validateRequest("status", { output: "/tmp/a" }));
  assert.throws(() => validateRequest("sync", { date: 1 }));
  assert.throws(() => validateRequest("sync", { date: "x\0y" }));
  validateRequest("groups.inspect", { id: "a", "index-run": "b", page: "1" });
});
test("private storage persists and refuses unsafe documents or ungranted file access", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reels-unit-"));
  try {
    const store = new LocalStore(root);
    await store.initialize();
    const d = await store.load();
    await store.save(d);
    assert.deepEqual(await new LocalStore(root).load(), d);
    assert.throws(() => safeDocumentName("../escape"));
    const file = await store.document("decision", { valid: true });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { valid: true });
    await assert.rejects(resolveGrantedFile(file, new Set()));
    assert.equal(await resolveGrantedFile(file, new Set([file])), file);
    const link = path.join(root, "link.json");
    await symlink(file, link);
    await assert.rejects(resolveGrantedFile(link, new Set([link])));
    await writeFile(path.join(root, "dashboard.json"), "broken");
    await assert.rejects(store.load());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("granted files remain readable through canonical parent aliases without granting other files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reels-alias-"));
  try {
    const directory = path.join(root, "evidence");
    await mkdir(directory);
    const file = path.join(directory, "preview.jpg");
    await writeFile(file, "synthetic-preview");
    const canonical = await realpath(file);
    const alias = path.join(root, "alias");
    await symlink(directory, alias, "dir");
    const grants = new Set([canonical]);
    assert.equal(
      await resolveGrantedFile(path.join(alias, "preview.jpg"), grants),
      canonical,
    );
    const other = path.join(directory, "ungranted.jpg");
    await writeFile(other, "ungranted");
    await assert.rejects(
      resolveGrantedFile(path.join(alias, "ungranted.jpg"), grants),
    );
    const directLink = path.join(directory, "link.jpg");
    await symlink(canonical, directLink);
    await assert.rejects(resolveGrantedFile(directLink, grants));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("native protocol unwraps Swift Data and preserves code/recovery errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reels-net-"));
  const sock = path.join(root, "s");
  const server = createServer((client) => {
    let input = "";
    client.on("data", (b) => {
      input += b;
      if (!input.includes("\n")) return;
      const r = JSON.parse(input);
      client.end(
        JSON.stringify(
          r.method === "status"
            ? {
                protocolVersion: 1,
                id: r.id,
                ok: true,
                payload: Buffer.from(
                  JSON.stringify({ permission: "authorized" }),
                ).toString("base64"),
              }
            : {
                protocolVersion: 1,
                id: r.id,
                ok: false,
                error: {
                  code: "stale-index-run",
                  message: "old",
                  recovery: "sync again",
                },
              },
        ) + "\n",
      );
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  try {
    assert.deepEqual(await sendNative(sock, "status", {}), {
      permission: "authorized",
    });
    await assert.rejects(
      sendNative(sock, "groups.show", {}),
      /stale-index-run.*sync again/,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});

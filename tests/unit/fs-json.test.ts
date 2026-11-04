import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isMissing, readJsonFile, writeJsonAtomic } from "../../src/shared/lib/fs";

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "fs-json-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const identity = (value: unknown) => value;

test("writeJsonAtomic round-trips through readJsonFile with 2-space JSON and a trailing newline", () =>
  withDir(async (dir) => {
    const file = path.join(dir, "data.json");
    const value = { a: 1, list: ["x", { y: true }], text: "한글" };
    await writeJsonAtomic(file, value);
    assert.equal(await readFile(file, "utf8"), JSON.stringify(value, null, 2) + "\n");
    assert.deepEqual(await readJsonFile(file, identity, () => null), value);
    await writeJsonAtomic(file, { replaced: true });
    assert.deepEqual(await readJsonFile(file, identity, () => null), { replaced: true });
  }));

test("readJsonFile returns the fallback only for a missing file and passes the parsed value to parse", () =>
  withDir(async (dir) => {
    const file = path.join(dir, "missing.json");
    let calls = 0;
    const fallback = () => {
      calls++;
      return [] as string[];
    };
    const first = await readJsonFile(file, () => ["parsed"], fallback);
    const second = await readJsonFile(file, () => ["parsed"], fallback);
    assert.deepEqual(first, []);
    assert.notEqual(first, second, "each miss gets a fresh fallback");
    assert.equal(calls, 2);
    await writeFile(file, JSON.stringify({ n: 2 }));
    assert.equal(await readJsonFile(file, (v) => (v as { n: number }).n * 10, () => 0), 20);
    // A directory is a read error other than ENOENT and propagates.
    const folder = path.join(dir, "folder.json");
    await mkdir(folder);
    await assert.rejects(readJsonFile(folder, identity, () => null), (e) => !isMissing(e));
  }));

test("readJsonFile propagates the bare SyntaxError for corrupt JSON and errors thrown by parse", () =>
  withDir(async (dir) => {
    const file = path.join(dir, "corrupt.json");
    await writeFile(file, "{not json");
    await assert.rejects(readJsonFile(file, identity, () => null), (e) => {
      assert.ok(e instanceof SyntaxError);
      assert.ok(!String((e as Error).message).includes(file), "message is not wrapped with the file name");
      return true;
    });
    await writeFile(file, "{}");
    await assert.rejects(
      readJsonFile(file, () => {
        throw new Error("invalid shape");
      }, () => null),
      /^Error: invalid shape$/,
    );
  }));

test("writeJsonAtomic applies the requested mode", { skip: process.platform === "win32" }, () =>
  withDir(async (dir) => {
    const file = path.join(dir, "secret.json");
    await writeJsonAtomic(file, { ok: true }, { mode: 0o600 });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }));

test("writeJsonAtomic leaves no temp file after a successful write", () =>
  withDir(async (dir) => {
    const file = path.join(dir, "data.json");
    await writeJsonAtomic(file, { one: 1 }, { mode: 0o600 });
    await writeJsonAtomic(file, { two: 2 }, { mode: 0o600 });
    assert.deepEqual(await readdir(dir), ["data.json"]);
  }));

test("writeJsonAtomic removes its temp file when the rename fails", () =>
  withDir(async (dir) => {
    const target = path.join(dir, "taken");
    await mkdir(path.join(target, "child"), { recursive: true });
    await assert.rejects(writeJsonAtomic(target, { lost: true }));
    assert.deepEqual(await readdir(dir), ["taken"]);
  }));

test("isMissing recognises only ENOENT", () => {
  assert.equal(isMissing(Object.assign(new Error("x"), { code: "ENOENT" })), true);
  assert.equal(isMissing(Object.assign(new Error("x"), { code: "EACCES" })), false);
  assert.equal(isMissing(new SyntaxError("x")), false);
  assert.equal(isMissing(null), false);
  assert.equal(isMissing(undefined), false);
});

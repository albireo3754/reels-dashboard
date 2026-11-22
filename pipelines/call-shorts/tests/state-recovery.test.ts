import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { StateCorruptError, StateStore } from "../src/state.js";

function stateFile(): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "callshorts-state-"));
  return { dir, file: path.join(dir, "state", "pipeline-state.json") };
}

test("every save keeps the previous generation as state.json.bak", () => {
  const { file } = stateFile();
  const store = new StateStore(file);
  store.claimFile("a", "/tmp/a.m4a", 1);
  store.claimFile("b", "/tmp/b.m4a", 1);

  const backup = JSON.parse(readFileSync(`${file}.bak`, "utf8")) as { files: Record<string, unknown> };
  assert.deepEqual(Object.keys(backup.files), ["a"]);
  assert.deepEqual(Object.keys((JSON.parse(readFileSync(file, "utf8")) as { files: object }).files), ["a", "b"]);
});

test("a truncated state file is blocked instead of silently reset", () => {
  const { file } = stateFile();
  const store = new StateStore(file);
  store.claimFile("keep", "/tmp/a.m4a", 1);
  store.saveSpeakerMap("/p1", { SPEAKER_00: "GF", SPEAKER_01: "BF" });
  const original = readFileSync(file, "utf8");
  writeFileSync(file, original.slice(0, Math.ceil(original.length * 0.6)), "utf8");
  const corrupted = readFileSync(file, "utf8");

  assert.throws(
    () => new StateStore(file),
    (error: Error) => error instanceof StateCorruptError && error.exitCode === 2,
  );
  assert.equal(readFileSync(file, "utf8"), corrupted, "손상된 state.json 을 덮어쓰지 않습니다");
  assert.ok(existsSync(`${file}.bak`), "직전 정상 상태는 .bak 에 남습니다");
  const preserved = readdirSync(path.dirname(file)).filter((name) => name.includes(".corrupt-"));
  assert.equal(preserved.length, 1, "손상 원본을 따로 보관합니다");
});

test("non-object JSON is also treated as corruption", () => {
  const { file } = stateFile();
  new StateStore(file).claimFile("keep", "/tmp/a.m4a", 1);
  writeFileSync(file, "null", "utf8");
  assert.throws(() => new StateStore(file), StateCorruptError);
  assert.equal(readFileSync(file, "utf8"), "null");
});

test("a corrupted state is recoverable from the .bak copy", () => {
  const { file } = stateFile();
  const store = new StateStore(file);
  store.claimFile("keep", "/tmp/a.m4a", 1);
  store.claimFile("later", "/tmp/b.m4a", 1);
  writeFileSync(file, "{ broken", "utf8");
  assert.throws(() => new StateStore(file), StateCorruptError);

  writeFileSync(file, readFileSync(`${file}.bak`), "utf8");
  const restored = new StateStore(file);
  assert.equal(restored.hasHash("keep"), true);
  assert.equal(restored.getFile("keep")?.status, "processing");
});

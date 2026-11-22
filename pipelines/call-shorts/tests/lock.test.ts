import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { acquireLock, DEFAULT_STALE_MS, LockHeldError, lockFileFor } from "../src/lock.js";

function stateFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "callshorts-lock-")), "state", "pipeline-state.json");
}

test("a lock records its holder and is released afterwards", () => {
  const state = stateFile();
  const lock = acquireLock(state, { command: "run-once" });
  const file = lockFileFor(state);
  assert.ok(existsSync(file));
  const record = JSON.parse(readFileSync(file, "utf8")) as { pid: number; command: string; startedAt: string };
  assert.equal(record.pid, process.pid);
  assert.equal(record.command, "run-once");
  assert.ok(record.startedAt);

  lock.release();
  assert.ok(!existsSync(file));
  lock.release(); // 두 번 불러도 안전
});

test("a second acquire is refused while the lock is held", () => {
  const state = stateFile();
  const first = acquireLock(state, { command: "run-once" });
  try {
    assert.throws(
      () => acquireLock(state, { command: "watch" }),
      (error: Error) => error instanceof LockHeldError && /이미 진행 중/.test(error.message),
    );
    assert.ok(existsSync(lockFileFor(state)), "남의 락을 지우면 안 됩니다");
  } finally {
    first.release();
  }
  const second = acquireLock(state, { command: "watch" });
  second.release();
});

test("a lock from a dead process is taken over", () => {
  const state = stateFile();
  const file = lockFileFor(state);
  const held = acquireLock(state, { command: "run-once" });
  const record = { ...held.record, pid: 999_999, command: "crashed" };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(record), "utf8");

  const recovered = acquireLock(state, { command: "run-once", isAlive: () => false });
  assert.equal(recovered.record.command, "run-once");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, process.pid);
  recovered.release();
});

test("an old lock is taken over even if the pid is still alive", () => {
  const state = stateFile();
  const file = lockFileFor(state);
  const now = Date.now();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ pid: process.pid, startedAt: new Date(now - DEFAULT_STALE_MS - 1000).toISOString(), command: "stuck" }),
    "utf8",
  );
  const lock = acquireLock(state, { command: "run-once", now, isAlive: () => true });
  assert.equal(lock.record.command, "run-once");
  lock.release();
});

test("a broken lock file is taken over only after the grace period", () => {
  const state = stateFile();
  const file = lockFileFor(state);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "", "utf8");

  // 방금 만들어진 깨진 파일은 아직 다른 실행이 쓰는 중일 수 있으므로 기다립니다.
  assert.throws(() => acquireLock(state, { command: "run-once" }), LockHeldError);

  const old = (Date.now() - 5 * 60_000) / 1000;
  utimesSync(file, old, old);
  const lock = acquireLock(state, { command: "run-once" });
  assert.equal(lock.record.pid, process.pid);
  lock.release();
});

test("release leaves a lock that another process has already re-taken", () => {
  const state = stateFile();
  const file = lockFileFor(state);
  const lock = acquireLock(state, { command: "run-once" });
  const other = { pid: process.pid + 1, startedAt: new Date().toISOString(), command: "watch" };
  writeFileSync(file, JSON.stringify(other), "utf8");

  lock.release();
  assert.ok(existsSync(file), "내 락이 아니면 지우지 않습니다");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).command, "watch");
});

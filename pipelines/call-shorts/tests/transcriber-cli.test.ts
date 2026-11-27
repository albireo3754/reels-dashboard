import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { TranscribeError } from "../src/errors.js";
import { runTranscriber } from "../src/transcribe.js";

const shellUnavailable = process.platform === "win32";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function fakeCli(body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "callshorts-cli-"));
  const file = path.join(dir, "fake-whisperx");
  writeFileSync(file, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(file, 0o755);
  return file;
}

function ticks(file: string): number {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

test("a transcriber that exits 0 resolves", { skip: shellUnavailable }, async () => {
  await runTranscriber(fakeCli("exit 0"), [], { timeoutMs: 5_000 });
});

test("a failing transcriber reports its exit code and stderr", { skip: shellUnavailable }, async () => {
  await assert.rejects(
    runTranscriber(fakeCli('echo "model download failed" >&2\nexit 3'), [], { timeoutMs: 5_000 }),
    (error: Error) =>
      error instanceof TranscribeError && /exit 3/.test(error.message) && /model download failed/.test(error.message),
  );
});

test("a missing binary fails instead of hanging", async () => {
  await assert.rejects(
    runTranscriber(path.join(tmpdir(), "callshorts-missing-cli"), [], { timeoutMs: 5_000 }),
    (error: Error) => error instanceof TranscribeError && /실행 실패/.test(error.message),
  );
});

test("a timeout ends a SIGTERM-ignoring transcriber and its grandchild", { skip: shellUnavailable }, async () => {
  const script = fakeCli(
    [
      "trap '' TERM",
      'TICKS="$(dirname "$0")/ticks.txt"',
      '( i=0; while [ $i -lt 400 ]; do echo tick >> "$TICKS"; sleep 0.05; i=$((i+1)); done ) &',
      "sleep 60",
    ].join("\n"),
  );
  const tickFile = path.join(path.dirname(script), "ticks.txt");

  const started = Date.now();
  await assert.rejects(
    runTranscriber(script, [], { timeoutMs: 300, killGraceMs: 100 }),
    (error: Error) => error instanceof TranscribeError && /시간 초과/.test(error.message),
  );
  assert.ok(Date.now() - started < 3_000, "close 를 무한히 기다리면 안 됩니다");

  const stoppedAt = ticks(tickFile);
  assert.ok(stoppedAt > 0, "손자 프로세스가 실제로 돌았어야 합니다");
  await sleep(400);
  assert.equal(ticks(tickFile), stoppedAt, "손자 프로세스가 남아 계속 돌고 있습니다");
});

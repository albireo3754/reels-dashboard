import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ExecutionLogs } from "../../src/shared/lib/execution-logs";
import {
  loggedSpawn,
  loggedExecFile,
} from "../../src/shared/lib/logged-process";

const context = {
  source: "test-sdk",
  label: "합성 처리",
  projectId: "fixture-project",
};
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "execution-log-test-"));
  return {
    root,
    logs: new ExecutionLogs(root),
    close: () => rm(root, { recursive: true, force: true }),
  };
}
test("registered child reports real progress, output, exit and survives reopening; unrelated child is absent", async () => {
  const f = await fixture();
  try {
    const unrelated = spawn(process.execPath, [
      "-e",
      "setTimeout(()=>{},2000)",
    ]);
    const child = loggedSpawn(
      f.logs,
      context,
      process.execPath,
      [
        "-e",
        'console.log(JSON.stringify({type:"progress",percent:45})); setTimeout(()=>{console.error("완료 진단");},1400)',
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      assert.equal(f.logs.list().length, 1);
      assert.equal(f.logs.list()[0].pid, child.pid);
      await new Promise((r) => setTimeout(r, 1200));
      assert.equal(f.logs.list()[0].status, "running");
      assert.equal(f.logs.list()[0].progress, 45);
      await new Promise((r) => child.once("close", r));
      const done = f.logs.list()[0];
      assert.equal(done.status, "completed");
      assert.equal(done.exitCode, 0);
      assert.equal(done.progress, 100);
      assert.match(done.output, /완료 진단/);
      assert(done.endedAt);
      assert.deepEqual(new ExecutionLogs(f.root).list(), [done]);
      assert.equal(
        (await stat(path.join(f.root, "execution-logs", done.id + ".json")))
          .mode & 0o777,
        0o600,
      );
    } finally {
      unrelated.kill();
      child.kill();
    }
  } finally {
    await f.close();
  }
});
test("exec failures and signals persist terminal state before returning to callers", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      loggedExecFile(
        f.logs,
        context,
        process.execPath,
        ["-e", 'console.error("bad media");process.exit(7)'],
        {},
      ),
    );
    assert.equal(f.logs.list()[0].exitCode, 7);
    assert.equal(f.logs.list()[0].status, "failed");
    assert.match(f.logs.list()[0].output, /bad media/);
    await assert.rejects(
      loggedExecFile(f.logs, context, path.join(f.root, "missing"), [], {}),
    );
    assert(f.logs.list().every((r) => r.status === "failed"));
    const child = loggedSpawn(
      f.logs,
      context,
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const closed = new Promise((r) => child.once("close", r));
    child.kill("SIGTERM");
    await closed;
    assert.equal(
      f.logs.list().find((r) => r.pid === child.pid)!.signal,
      "SIGTERM",
    );
    assert.equal(
      f.logs.list().find((r) => r.pid === child.pid)!.status,
      "failed",
    );
  } finally {
    await f.close();
  }
});
test("restart marks unfinished observations interrupted, and bounded logs redact credentials", async () => {
  const f = await fixture();
  try {
    const id = f.logs.start({ ...context, executable: "ffmpeg" });
    f.logs.update(id, {
      output:
        "x".repeat(20000) + " Bearer abc123 api_key=hidden sk-test-secret",
    });
    for (let i = 0; i < 110; i++) f.logs.update(id, {}, "event " + i);
    const disk = await readFile(
      path.join(f.root, "execution-logs", id + ".json"),
      "utf8",
    );
    assert(!disk.includes("abc123"));
    assert(!disk.includes("hidden"));
    assert(!disk.includes("sk-test-secret"));
    assert.equal(f.logs.list()[0].output.length, 16000);
    assert.equal(f.logs.list()[0].events.length, 100);
    const reopened = new ExecutionLogs(f.root).list()[0];
    assert.equal(reopened.status, "interrupted");
    assert(reopened.endedAt);
    assert.match(reopened.events.at(-1)!.message, /종료 여부는 확인되지/);
  } finally {
    await f.close();
  }
});
test("retention removes only old terminal records", async () => {
  const f = await fixture();
  try {
    const active = f.logs.start({ ...context, executable: "ffmpeg" });
    for (let i = 0; i < 205; i++) {
      const id = f.logs.start({ ...context, executable: "ffmpeg" });
      f.logs.finish(id, "completed", "done");
    }
    assert.equal(f.logs.list().length, 201);
    assert.equal(f.logs.list().find((r) => r.id === active)?.status, "running");
    assert.equal(new ExecutionLogs(f.root).list().length, 200);
  } finally {
    await f.close();
  }
});

test("noninteractive commands receive EOF and stdout payloads are not copied into diagnostics", async () => {
  const f = await fixture();
  try {
    const result = await loggedExecFile(
      f.logs,
      context,
      process.execPath,
      [
        "-e",
        'process.stdin.resume(); process.stdin.on("end",()=>console.log(JSON.stringify({type:"result",image:"private-base64-payload"})))',
      ],
      { timeout: 2000 },
    );
    assert.match(result.stdout, /private-base64-payload/);
    assert.equal(f.logs.list()[0].status, "completed");
    assert(!f.logs.list()[0].output.includes("private-base64-payload"));
    assert.match(f.logs.list()[0].output, /엔진 결과 수신/);
  } finally {
    await f.close();
  }
});

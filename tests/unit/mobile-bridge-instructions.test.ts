import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ApiError,
  acquireDispatchLock,
  conflictOutcome,
  readResultFile,
  InstructionRunner,
  MASKED_LINE,
  PASEO_BIN,
  PaseoLauncher,
  buildPreamble,
  childEnv,
  createInstructionApi,
  detectScreenLock,
  interpretConsole,
  isSuspicious,
  parseConfig,
  type Exec,
  type InstructionApi,
  type LockState,
  type StatusBody,
} from "../../scripts/mobile-briefing/instructions";
import { FakeLauncher } from "../../scripts/mobile-briefing/fake-launcher";

const ID = (n: number) =>
  "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const BODY = "BODY-SENTINEL 본문은 로그에 남으면 안 됨";

class FakeApi implements InstructionApi {
  queue: Record<string, unknown>[] = [];
  claims: number[] = [];
  statuses: { id: string; body: StatusBody }[] = [];
  failStatus = 0;
  rejectStatus = 0;
  rejectCode = 409;
  rejectCurrent: { status?: string; errorCode?: string } = {};
  onClaim?: () => Promise<void>;
  async claim(capacity: number) {
    this.claims.push(capacity);
    const items = this.queue.splice(0, capacity);
    await this.onClaim?.();
    return { enabled: true, items };
  }
  async status(id: string, body: StatusBody) {
    if (this.failStatus > 0) {
      this.failStatus--;
      throw new ApiError(503);
    }
    if (this.rejectStatus > 0) {
      this.rejectStatus--;
      throw new ApiError(this.rejectCode, this.rejectCurrent);
    }
    this.statuses.push({ id, body });
  }
  add(
    n: number,
    text = BODY + " [fake:done]",
    extra: Record<string, unknown> = {},
  ) {
    this.queue.push({
      id: ID(n),
      text,
      target: null,
      end_level: null,
      created_at: "x",
      ...extra,
    });
  }
}

const temps: string[] = [];
test.after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function setup(
  config: Record<string, unknown> = {},
  opts: { lock?: LockState } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "instructions-"));
  temps.push(root);
  const home = path.join(root, "home");
  await mkdir(path.join(home, "Obsidian"), { recursive: true });
  await mkdir(path.join(home, "side", "reels-dashboard"), { recursive: true });
  await writeFile(
    path.join(root, "instructions.json"),
    JSON.stringify({ enabled: true, ...config }),
  );
  const api = new FakeApi();
  const launcher = new FakeLauncher();
  const clock = { t: Date.parse("2026-11-21T00:00:00Z") };
  const logs: string[] = [];
  const lock = { value: opts.lock ?? { locked: false, known: true } };
  const make = () =>
    new InstructionRunner({
      root,
      api,
      launcher,
      home,
      lockState: async () => lock.value,
      now: () => clock.t,
      log: (m) => logs.push(m),
      graceMs: 30000,
      retryDelayMs: 0,
    });
  const runner = make();
  const advance = async (ms = 15000) => {
    clock.t += ms;
    await runner.tick();
  };
  const ledger = async (id: string) =>
    JSON.parse(
      await readFile(path.join(root, "instructions", id, "state.json"), "utf8"),
    );
  return {
    root,
    home,
    api,
    launcher,
    clock,
    logs,
    lock,
    runner,
    make,
    advance,
    ledger,
  };
}
const launches = (l: FakeLauncher) =>
  l.calls.filter((c) => c.method === "launch").length;
const agentFor = (l: FakeLauncher, id: string) =>
  [...l.agents.values()].find((a) => a.labels.instruction === id)!;

test("config: missing file is off, unsafe values turn the feature off", () => {
  assert.equal(parseConfig({}).enabled, false);
  assert.equal(parseConfig({ enabled: true }).valid, true);
  for (const bad of [
    { enabled: true, mode: "bypassPermissions" },
    { enabled: true, mode: "full-access" },
    { enabled: true, enable: true },
    { enabled: "yes" },
    { enabled: true, maxActive: 3 },
    { enabled: true, cwd: "relative/path" },
    { enabled: true, model: "x; rm -rf /" },
    [],
    null,
  ]) {
    const c = parseConfig(bad);
    assert.equal(c.valid && c.enabled, false, JSON.stringify(bad));
  }
  const c = parseConfig({ enabled: true }, "/home/example");
  assert.deepEqual(
    [
      c.provider,
      c.model,
      c.mode,
      c.maxActive,
      c.stopAfterMinutes,
      c.cwd,
      c.preMergeCwd,
    ],
    [
      "claude",
      "claude-sonnet-5-5",
      "auto",
      1,
      0,
      "/home/example/Obsidian",
      "/home/example/side/reels-dashboard",
    ],
  );
});

test("readiness: switch off, launcher down, locked, unknown lock and no slot never claim", async () => {
  const off = await setup({ enabled: false });
  off.api.add(1);
  await off.runner.tick();
  assert.deepEqual(off.runner.heartbeat(), {
    instructions: { ready: false, reason: "disabled" },
  });
  assert.equal(
    off.launcher.calls.length,
    0,
    "launcher untouched while off and idle",
  );
  assert.equal(off.api.claims.length, 0);

  const herdr = await setup({ launcher: "herdr" });
  herdr.api.add(1);
  await herdr.runner.tick();
  assert.equal(herdr.runner.heartbeat().instructions.reason, "disabled");
  assert.equal(herdr.api.claims.length, 0);

  const down = await setup();
  down.launcher.readyValue = false;
  down.api.add(1);
  await down.runner.tick();
  assert.equal(down.runner.heartbeat().instructions.reason, "launcher_down");
  assert.equal(
    down.launcher.calls.filter((c) => c.method === "ready").length,
    2,
    "one retry",
  );
  assert.equal(down.api.claims.length, 0);

  for (const lock of [
    { locked: true, known: true },
    { locked: true, known: false },
  ]) {
    const s = await setup({}, { lock });
    s.api.add(1);
    await s.runner.tick();
    assert.equal(s.runner.heartbeat().instructions.reason, "locked");
    assert.equal(s.api.claims.length, 0);
  }

  const zero = await setup({ maxActive: 0 });
  zero.api.add(1);
  await zero.runner.tick();
  assert.equal(zero.runner.heartbeat().instructions.reason, "busy");
  assert.equal(zero.api.claims.length, 0);
});

test("claim → ledger → launch → running → done, private files, no body in logs", async () => {
  const s = await setup({ maxActive: 2 });
  s.api.add(1);
  let phaseAtLaunch: string | null = null;
  const launch = s.launcher.launch.bind(s.launcher);
  s.launcher.launch = async (spec) => {
    phaseAtLaunch = (await s.ledger(ID(1))).phase;
    return launch(spec);
  };
  await s.runner.tick();
  assert.deepEqual(s.api.claims, [2], "capacity is the free slots");
  assert.equal(phaseAtLaunch, "launching", "ledger written before launch");
  assert.deepEqual(s.api.statuses[0], {
    id: ID(1),
    body: { status: "running", sessionName: "sites-00000000" },
  });
  const dir = path.join(s.root, "instructions", ID(1));
  assert.equal((await lstat(dir)).mode & 0o777, 0o700);
  assert.equal(
    (await lstat(path.join(s.root, "instructions"))).mode & 0o777,
    0o700,
  );
  for (const f of ["state.json", "instruction.md"])
    assert.equal((await lstat(path.join(dir, f))).mode & 0o777, 0o600, f);
  assert.equal(
    await readFile(path.join(dir, "instruction.md"), "utf8"),
    BODY + " [fake:done]",
  );

  await s.advance();
  assert.equal(s.api.statuses.length, 1, "still running");
  await s.launcher.complete(agentFor(s.launcher, ID(1)).id);
  await s.advance();
  const done = s.api.statuses[1];
  assert.equal(done.body.status, "done");
  assert.equal(done.body.sessionName, "sites-00000000");
  assert.equal(
    done.body.summary,
    "가짜 실행기 결과 done\n문서 두 개를 읽고 초안을 만들었어요\n검증: 하지 않음",
  );
  assert.equal(done.body.errorCode, undefined);
  assert.equal((await s.ledger(ID(1))).finalReported, true);
  assert.deepEqual(s.runner.heartbeat(), { instructions: { ready: true } });

  const logText = s.logs.join("\n");
  assert.ok(!logText.includes("BODY-SENTINEL"));
  assert.ok(!logText.includes(s.root));
  for (const line of s.logs) assert.match(line, /^instruction (\S+) [A-Z_ ]+$/);
  for (const st of s.api.statuses)
    assert.ok(!JSON.stringify(st).includes("BODY-SENTINEL"));
});

test("needs_user and failed results; permission requests are never auto-approved", async () => {
  const s = await setup();
  s.api.add(1, "[fake:needs_user]");
  await s.runner.tick();
  await s.launcher.complete(agentFor(s.launcher, ID(1)).id);
  await s.advance();
  assert.deepEqual(
    s.api.statuses.at(-1)!.body.question,
    "어느 쪽을 먼저 할까요?",
  );
  assert.equal(s.api.statuses.at(-1)!.body.status, "needs_user");

  s.api.add(2, "[fake:failed]");
  await s.advance();
  await s.launcher.complete(agentFor(s.launcher, ID(2)).id);
  await s.advance();
  assert.equal(s.api.statuses.at(-1)!.body.status, "failed");
  assert.equal(s.api.statuses.at(-1)!.body.errorCode, "AGENT_FAILED");

  s.api.add(3, "[fake:permission]");
  await s.advance();
  await s.launcher.complete(agentFor(s.launcher, ID(3)).id);
  await s.advance();
  const last = s.api.statuses.at(-1)!;
  assert.equal(last.id, ID(3));
  assert.equal(last.body.status, "needs_user");
  assert.match(last.body.question!, /sites-00000000에서 권한 요청/);
  assert.ok(!s.launcher.calls.some((c) => c.method === "stop"));
});

test("Paseo argv: fixed preamble and file paths only, absolute binary, minimal env", async () => {
  const s = await setup();
  const calls: { file: string; args: string[] }[] = [];
  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    if (args[0] === "status")
      return {
        stdout: JSON.stringify({
          localDaemon: "running",
          connectedDaemon: "reachable",
        }),
      };
    if (args[0] === "run")
      return {
        stdout: JSON.stringify({
          agentId: "agent-" + calls.length,
          status: "running",
        }),
      };
    if (args[0] === "inspect")
      return {
        stdout: JSON.stringify({ Status: "running", PendingPermissions: [] }),
      };
    return { stdout: "[]" };
  };
  const runner = new InstructionRunner({
    root: s.root,
    api: s.api,
    launcher: new PaseoLauncher(exec),
    home: s.home,
    lockState: async () => ({ locked: false, known: true }),
    retryDelayMs: 0,
    now: () => s.clock.t,
  });
  s.api.add(1, BODY, { target: "project:abc", end_level: "draft" });
  await runner.tick();
  const run = calls.find((c) => c.args[0] === "run")!;
  assert.equal(run.file, PASEO_BIN);
  assert.ok(calls.every((c) => c.file === PASEO_BIN));
  assert.ok(
    !run.args.some((a) => a.includes("BODY-SENTINEL")),
    "body never in argv",
  );
  const opt = (name: string) => run.args[run.args.indexOf(name) + 1];
  assert.equal(opt("--provider"), "claude");
  assert.equal(opt("--model"), "claude-sonnet-5-5");
  assert.equal(opt("--mode"), "auto");
  assert.equal(opt("--cwd"), path.join(s.home, "Obsidian"));
  assert.equal(opt("--title"), "sites-00000000");
  assert.ok(!run.args.includes("--new-workspace"));
  assert.ok(
    run.args.includes("instruction=" + ID(1)) &&
      run.args.includes("source=sites"),
  );
  assert.ok(!run.args.includes("--env"));
  const prompt = run.args.at(-1)!;
  assert.match(prompt, /대상: project:abc\. 끝: 초안\./);
  assert.ok(
    prompt.includes(
      JSON.stringify(
        path.join(s.root, "instructions", ID(1), "instruction.md"),
      ),
    ),
  );
  assert.match(prompt, /git push, 배포, 게시·업로드·예약, 결제, 삭제/);

  s.api.add(2, BODY, { end_level: "pre_merge" });
  s.clock.t += 15000;
  // slot is still held by instruction 1; finish it first through the ledger
  const st = JSON.parse(
    await readFile(
      path.join(s.root, "instructions", ID(1), "state.json"),
      "utf8",
    ),
  );
  st.final = { status: "done", summary: "x", question: null, errorCode: null };
  st.finalReported = true;
  st.agentEnded = true;
  await writeFile(
    path.join(s.root, "instructions", ID(1), "state.json"),
    JSON.stringify(st),
  );
  await runner.tick();
  const run2 = calls.filter((c) => c.args[0] === "run")[1];
  assert.equal(run2.args[run2.args.indexOf("--new-workspace") + 1], "worktree");
  assert.equal(
    run2.args[run2.args.indexOf("--cwd") + 1],
    path.join(s.home, "side", "reels-dashboard"),
  );

  process.env.REELS_BRIDGE_KEY_FILE = "/tmp/should-not-leak";
  try {
    const env = childEnv();
    assert.ok(
      Object.keys(env).every((k) =>
        ["PATH", "LANG", "HOME", "USER", "LOGNAME", "TMPDIR"].includes(k),
      ),
    );
  } finally {
    delete process.env.REELS_BRIDGE_KEY_FILE;
  }
});

test("pre_merge worktree launch failure fails without falling back to the main tree", async () => {
  const s = await setup();
  s.launcher.launchFails = "before";
  s.api.add(1, BODY, { end_level: "pre_merge" });
  await s.runner.tick();
  assert.equal(launches(s.launcher), 1);
  const last = s.api.statuses.at(-1)!.body;
  assert.equal(last.status, "failed");
  assert.equal(last.errorCode, "LAUNCH_FAILED");
  assert.match(last.summary!, /메인 작업 트리에서 대신 실행하지 않았어요/);
  await s.advance();
  await s.advance();
  assert.equal(launches(s.launcher), 1, "never relaunched");
});

test("at-most-once: restart never relaunches; adopts the labelled session or fails", async () => {
  const write = async (root: string, id: string, phase: string) => {
    const dir = path.join(root, "instructions", id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(dir, "state.json"),
      JSON.stringify({
        schemaVersion: 1,
        id,
        attemptId: "a-1",
        sessionName: "sites-" + id.slice(0, 8),
        phase,
        target: null,
        endLevel: null,
        claimedAt: "2026-11-21T00:00:00Z",
        agentId: null,
        launchedAt: null,
        runningReported: false,
        idleSince: null,
        resultRequestedAt: null,
        final: null,
        finalReported: false,
        finishedAt: null,
      }),
      { mode: 0o600 },
    );
  };
  // crash right after the claim was recorded
  const a = await setup();
  await write(a.root, ID(1), "claimed");
  await a.runner.tick();
  assert.equal(launches(a.launcher), 0);
  assert.deepEqual(
    a.api.statuses.map((x) => [x.body.status, x.body.errorCode]),
    [["failed", "LAUNCH_FAILED"]],
  );

  // crash after launch, before the agent id was recorded
  const b = await setup();
  await write(b.root, ID(2), "launching");
  const agent = b.launcher.seed({ source: "sites", instruction: ID(2) });
  await b.runner.tick();
  assert.equal(launches(b.launcher), 0);
  assert.equal((await b.ledger(ID(2))).agentId, agent);
  assert.deepEqual(b.api.statuses[0].body, {
    status: "running",
    sessionName: "sites-00000000",
  });

  // the launch response was lost in-process: adopt instead of a second launch
  const c = await setup();
  c.launcher.launchFails = "after";
  c.api.add(3);
  await c.runner.tick();
  assert.equal(launches(c.launcher), 1);
  assert.equal(c.launcher.agents.size, 1);
  assert.equal(c.api.statuses[0].body.status, "running");

  // two sessions with our label: uncertain → failed, nothing launched
  const d = await setup();
  await write(d.root, ID(4), "launching");
  d.launcher.seed({ instruction: ID(4) });
  d.launcher.seed({ instruction: ID(4) });
  await d.runner.tick();
  assert.equal(launches(d.launcher), 0);
  assert.equal(d.api.statuses[0].body.errorCode, "LAUNCH_FAILED");
  assert.match(
    d.api.statuses[0].body.summary!,
    /확인하지 못해 다시 실행하지 않았어요/,
  );

  // a second runner on the same data cannot dispatch while the first holds the lock
  const e = await setup();
  await e.runner.tick();
  const other = new InstructionRunner({
    root: e.root,
    api: e.api,
    launcher: e.launcher,
    home: e.home,
    lockState: async () => ({ locked: false, known: true }),
    retryDelayMs: 0,
  });
  await writeFile(
    path.join(e.root, "instructions", ".dispatch.lock"),
    String(process.ppid),
  );
  e.api.add(5);
  await other.tick();
  assert.equal(other.heartbeat().instructions.reason, "busy");
  assert.equal(e.api.queue.length, 1);
  await writeFile(
    path.join(e.root, "instructions", ".dispatch.lock"),
    "99999999",
  );
  await other.tick();
  assert.equal(e.api.queue.length, 0, "stale lock is taken over");
});

test("result collection: missing → one re-request → RESULT_MISSING; late result after re-request", async () => {
  const s = await setup();
  s.api.add(1, "[fake:missing]");
  await s.runner.tick();
  await s.launcher.complete(agentFor(s.launcher, ID(1)).id);
  await s.advance(); // idle seen
  await s.advance(20000); // still in grace
  assert.equal(s.launcher.calls.filter((c) => c.method === "send").length, 0);
  await s.advance(15000); // grace over → one request
  const sends = s.launcher.calls.filter((c) => c.method === "send");
  assert.equal(sends.length, 1);
  const requestFile = sends[0].args[1] as string;
  assert.equal((await lstat(requestFile)).mode & 0o777, 0o600);
  await s.advance();
  await s.advance(31000);
  assert.equal(
    s.launcher.calls.filter((c) => c.method === "send").length,
    1,
    "only once",
  );
  assert.equal(s.api.statuses.at(-1)!.body.errorCode, "RESULT_MISSING");

  const late = await setup();
  late.api.add(2, "[fake:late]");
  await late.runner.tick();
  agentFor(late.launcher, ID(2)).status = "idle";
  await late.advance();
  await late.advance(31000);
  await late.advance();
  assert.equal(late.api.statuses.at(-1)!.body.status, "done");
});

test("result validation: invalid, oversize, symlink, extra key, wrong attempt are RESULT_INVALID", async () => {
  for (const [scenario, over] of [
    ["invalid", {}],
    ["oversize", {}],
    ["symlink", {}],
    ["done", { extra: 1 }],
    ["done", { attemptId: "someone-else" }],
    ["done", { summaryLines: [] }],
    ["done", { summaryLines: Array(11).fill("a") }],
    ["done", { summaryLines: ["x".repeat(201)] }],
    ["done", { question: "only for needs_user" }],
    ["needs_user", { question: "q".repeat(501) }],
    ["done", { verification: "skipped" }],
  ] as const) {
    const s = await setup();
    s.api.add(1, "[fake:" + scenario + "]");
    await s.runner.tick();
    await s.launcher.complete(agentFor(s.launcher, ID(1)).id, over);
    await s.advance();
    assert.equal(
      s.api.statuses.at(-1)!.body.errorCode,
      "RESULT_INVALID",
      scenario + " " + JSON.stringify(over).slice(0, 60),
    );
  }
});

test("summary lines with paths, control characters or token shapes are replaced", async () => {
  const s = await setup();
  s.api.add(1, "[fake:needs_user]");
  await s.runner.tick();
  const lines = [
    "docs/mobile-briefing.md 에 절을 추가했어요",
    "/Users/example/secret.txt 를 고쳤어요",
    "~/Obsidian 정리",
    "file:///etc/hosts 확인",
    "C:\\Users\\example 경로",
    "token: abc",
    "ghp_" + "a".repeat(30),
    "보이지\u200b않는 문자",
    "탭\t포함",
  ];
  await s.launcher.complete(agentFor(s.launcher, ID(1)).id, {
    summaryLines: lines,
    question: "/Users/example/x 를 지워도 될까요?",
  });
  await s.advance();
  const body = s.api.statuses.at(-1)!.body;
  const out = body.summary!.split("\n");
  assert.equal(out[0], lines[0]);
  assert.deepEqual(out.slice(1, 9), Array(8).fill(MASKED_LINE));
  assert.equal(out[9], "검증: 하지 않음");
  assert.equal(
    body.question,
    "Paseo 세션 sites-00000000에서 질문을 확인해 주세요.",
  );
  assert.equal(isSuspicious("Sk-learn 메모 3줄"), false);
  assert.equal(isSuspicious("sk-" + "A1".repeat(10)), true);
  assert.equal(isSuspicious("eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0"), true);
  assert.equal(isSuspicious("Authorization: x"), true);
  assert.equal(isSuspicious("\\\\server\\share"), true);
});

test("upload failures retry the same result without relaunching", async () => {
  const s = await setup();
  s.api.add(1);
  await s.runner.tick();
  await s.launcher.complete(agentFor(s.launcher, ID(1)).id);
  s.api.failStatus = 2;
  await s.advance();
  await s.advance();
  assert.equal(
    s.api.statuses.filter((x) => x.body.status === "done").length,
    0,
  );
  await s.advance();
  assert.equal(
    s.api.statuses.filter((x) => x.body.status === "done").length,
    1,
  );
  await s.advance();
  assert.equal(
    s.api.statuses.filter((x) => x.body.status === "done").length,
    1,
  );
  assert.equal(launches(s.launcher), 1);
  assert.ok(s.logs.some((l) => l.endsWith("REPORT_RETRY")));

  // a 409 is final: recorded once, not retried forever
  const r = await setup();
  r.api.add(2);
  await r.runner.tick();
  await r.launcher.complete(agentFor(r.launcher, ID(2)).id);
  r.api.rejectStatus = 1;
  await r.advance();
  assert.equal((await r.ledger(ID(2))).finalReported, true);
  assert.ok(r.logs.some((l) => l.endsWith("REPORT_REJECTED")));

  // a 400 on the final body is replaced once by a fixed failure so the site row does not stay running
  const f = await setup();
  f.api.add(3);
  await f.runner.tick();
  await f.launcher.complete(agentFor(f.launcher, ID(3)).id);
  f.api.rejectStatus = 1;
  f.api.rejectCode = 400;
  await f.advance();
  const last = f.api.statuses.at(-1)!;
  assert.equal(last.id, ID(3));
  assert.deepEqual(
    [last.body.status, last.body.errorCode],
    ["failed", "RESULT_INVALID"],
  );
  assert.ok(f.logs.some((l) => l.endsWith("REPORT_FALLBACK")));
});

test("long runs: stopAfterMinutes 0 keeps the run and its slot; >0 stops and reports TIMEOUT", async () => {
  const keep = await setup();
  keep.api.add(1, "[fake:hang]");
  keep.api.add(2);
  await keep.runner.tick();
  await keep.advance(3 * 3600_000);
  assert.ok(!keep.launcher.calls.some((c) => c.method === "stop"));
  assert.equal(keep.api.statuses.length, 1, "still running, nothing reported");
  assert.equal(
    keep.runner.heartbeat().instructions.reason,
    "busy",
    "delayed run holds the slot",
  );
  assert.equal(keep.api.queue.length, 1);

  const stop = await setup({ stopAfterMinutes: 60 });
  stop.api.add(1, "[fake:hang]");
  await stop.runner.tick();
  await stop.advance(59 * 60_000);
  assert.equal(stop.api.statuses.length, 1);
  await stop.advance(2 * 60_000);
  assert.equal(
    stop.launcher.calls.filter((c) => c.method === "stop").length,
    1,
  );
  assert.equal(stop.api.statuses.at(-1)!.body.errorCode, "TIMEOUT");
});

test("local switch is checked again right before launch", async () => {
  const s = await setup();
  s.api.add(1);
  s.api.onClaim = () =>
    writeFile(
      path.join(s.root, "instructions.json"),
      JSON.stringify({ enabled: false }),
    );
  await s.runner.tick();
  assert.equal(launches(s.launcher), 0);
  assert.deepEqual(
    [s.api.statuses[0].body.status, s.api.statuses[0].body.errorCode],
    ["failed", "BRIDGE_DISABLED"],
  );
  await rm(path.join(s.root, "instructions", ID(1), "instruction.md"), {
    force: true,
  });
});

test("screen lock: console state decides, unreadable state counts as locked", async () => {
  const me = {
    kCGSSessionUserIDKey: 501,
    kCGSSessionOnConsoleKey: true,
    kCGSessionLoginDoneKey: true,
  };
  assert.deepEqual(interpretConsole([me], false, 501), {
    locked: false,
    known: true,
  });
  assert.equal(
    interpretConsole([{ ...me, CGSSessionScreenIsLocked: true }], false, 501)
      .locked,
    true,
  );
  assert.equal(interpretConsole([me], true, 501).locked, true);
  assert.equal(
    interpretConsole([{ ...me, kCGSSessionOnConsoleKey: false }], null, 501)
      .locked,
    true,
  );
  assert.equal(interpretConsole([me], false, 502).locked, true);
  assert.deepEqual(interpretConsole("x", false, 501), {
    locked: true,
    known: false,
  });
  const failing: Exec = async () => {
    throw new Error("no ioreg");
  };
  assert.deepEqual(await detectScreenLock(failing, 501), {
    locked: true,
    known: false,
  });
  const ok: Exec = async (file, args) => {
    if (file === "/usr/sbin/ioreg") return { stdout: "<plist/>" };
    if (args[1] === "IOConsoleUsers") return { stdout: JSON.stringify([me]) };
    return { stdout: "false\n" };
  };
  assert.deepEqual(await detectScreenLock(ok, 501), {
    locked: false,
    known: true,
  });
});

test("preamble carries the boundaries and no instruction text", () => {
  const p = buildPreamble({
    id: ID(9),
    attemptId: "att",
    instructionFile: "/data/x/instruction.md",
    resultFile: "/data/x/result.json",
    target: null,
    endLevel: "pre_merge",
  });
  for (const must of [
    "사용자는 지금 자리에 없다",
    "권한이 아니다",
    "AGENTS.md",
    "git push",
    "설치본 교체",
    "LaunchAgent·설정 변경",
    "git commit은 하지 않는다",
    "pre_merge",
    "~/Obsidian은 자동 백업이라 커밋하지 않는다",
    "외부 서비스 쓰기",
    "추정하지 않는다",
    "기다리지 말고 needs_user",
    "result.json.tmp",
    "새 작업을 시작하지 않는다",
    "앱 병합 전",
    '"attemptId":"att"',
  ])
    assert.ok(p.includes(must), must);
});

// ---------------------------------------------------------------- integration

type SiteItem = {
  id: string;
  text: string;
  target: string | null;
  end_level: string | null;
  status: string;
  [k: string]: unknown;
};
function fakeSite(key: string) {
  /** Commit a status report, then drop the connection before answering. */
  const ctl: { drop: null | ((id: string, status: string) => boolean) } = {
    drop: null,
  };
  const items: SiteItem[] = [];
  const heartbeats: unknown[] = [];
  const claims: unknown[] = [];
  const statusBodies: string[] = [];
  const allowed: Record<string, string[]> = {
    claimed: ["running", "failed"],
    running: ["needs_user", "done", "failed"],
  };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers["x-reels-bridge-key"] !== key)
      return send(401, { error: "UNAUTHORIZED" });
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/api/bridge/heartbeat" && req.method === "POST") {
      heartbeats.push(raw ? JSON.parse(raw) : null);
      return send(200, { mediaEnabled: false });
    }
    if (url.pathname === "/api/briefing")
      return send(200, { contents: [], assets: [], syncedAt: null });
    if (
      url.pathname === "/api/bridge/instructions/claim" &&
      req.method === "POST"
    ) {
      const { capacity } = JSON.parse(raw);
      claims.push(capacity);
      const active = items.filter(
        (i) => i.status === "claimed" || i.status === "running",
      ).length;
      const free = Math.max(0, Math.min(capacity, 1 - active));
      const out = items.filter((i) => i.status === "queued").slice(0, free);
      for (const i of out) i.status = "claimed";
      return send(200, {
        enabled: true,
        items: out.map(({ id, text, target, end_level }) => ({
          id,
          text,
          target,
          end_level,
          created_at: "t",
        })),
      });
    }
    const m = /^\/api\/bridge\/instructions\/([^/]+)\/status$/.exec(
      url.pathname,
    );
    if (m && req.method === "POST") {
      statusBodies.push(raw);
      const body = JSON.parse(raw);
      const item = items.find((i) => i.id === m[1]);
      if (!item) return send(404, { error: "NOT_FOUND" });
      if (!allowed[item.status]?.includes(body.status))
        return send(409, {
          error: "TRANSITION_NOT_ALLOWED",
          status: item.status,
          error_code: item.error_code ?? null,
        });
      Object.assign(item, {
        status: body.status,
        session_name: body.sessionName ?? item.session_name,
        summary: body.summary ?? null,
        question: body.question ?? null,
        error_code: body.errorCode ?? null,
      });
      if (ctl.drop?.(m[1], body.status)) {
        ctl.drop = null;
        req.socket.destroy();
        return;
      }
      return send(200, { ok: true });
    }
    send(404, { error: "NOT_FOUND" });
  });
  return { items, heartbeats, claims, statusBodies, server, ctl };
}
const listen = (server: http.Server) =>
  new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(
        "http://127.0.0.1:" + (server.address() as { port: number }).port,
      ),
    ),
  );

test("integration: fake site round trip claim → running → done / needs_user / failed", async () => {
  const site = fakeSite("bridge-key");
  const base = await listen(site.server);
  try {
    const s = await setup();
    const api = createInstructionApi((route, init) =>
      fetch(new URL(route, base), {
        ...init,
        headers: { ...init.headers, "X-Reels-Bridge-Key": "bridge-key" },
      }),
    );
    const runner = new InstructionRunner({
      root: s.root,
      api,
      launcher: s.launcher,
      home: s.home,
      now: () => s.clock.t,
      lockState: async () => ({ locked: false, known: true }),
      retryDelayMs: 0,
      log: (m) => s.logs.push(m),
    });
    const kinds = ["done", "needs_user", "failed"];
    kinds.forEach((k, i) =>
      site.items.push({
        id: ID(i + 1),
        text: BODY + " [fake:" + k + "]",
        target: null,
        end_level: null,
        status: "queued",
      }),
    );
    for (let i = 0; i < kinds.length; i++) {
      s.clock.t += 15000;
      await runner.tick();
      assert.equal(site.items[i].status, "running");
      assert.equal(
        site.items[i].session_name,
        "sites-" + ID(i + 1).slice(0, 8),
      );
      assert.equal(
        site.items[i + 1]?.status ?? "queued",
        "queued",
        "limit 1 keeps the next one queued",
      );
      await s.launcher.complete(agentFor(s.launcher, ID(i + 1)).id);
      s.clock.t += 15000;
      await runner.tick();
      assert.equal(site.items[i].status, kinds[i]);
    }
    assert.equal(site.items[1].question, "어느 쪽을 먼저 할까요?");
    assert.equal(site.items[2].error_code, "AGENT_FAILED");
    assert.ok(
      site.statusBodies.every(
        (b) => !b.includes("BODY-SENTINEL") && !b.includes(s.root),
      ),
    );
  } finally {
    site.server.close();
  }
});

test("integration: bridge.mjs with injected credentials reports readiness in the heartbeat", async () => {
  const site = fakeSite("bridge-key-2");
  const base = await listen(site.server);
  const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-e2e-"));
  const keyFile = path.join(dir, "key");
  await writeFile(keyFile, "bridge-key-2\n");
  await chmod(keyFile, 0o600);
  const bridge = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../scripts/mobile-briefing/bridge.mjs",
  );
  const child = spawn(process.execPath, [bridge], {
    env: {
      ...process.env,
      REELS_BRIDGE_URL: base,
      REELS_BRIDGE_KEY_FILE: keyFile,
      REELS_BRIDGE_DATA_DIR: path.join(dir, "data"),
      REELS_MCP_URL: "http://127.0.0.1:9/mcp",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  try {
    const deadline = Date.now() + 20000;
    while (!site.heartbeats.length && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(
      site.heartbeats[0],
      { instructions: { ready: false, reason: "disabled" } },
      output,
    );
    assert.equal(site.claims.length, 0, "switch off: no claim");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    site.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- security review fixes

test("F1: a permission wait reported as needs_user keeps its slot until the agent ends", async () => {
  const s = await setup();
  s.api.add(1, "[fake:permission]");
  s.api.add(2);
  await s.runner.tick();
  const agent = agentFor(s.launcher, ID(1));
  await s.launcher.complete(agent.id); // pending permission, still running
  await s.advance();
  assert.equal(s.api.statuses.at(-1)!.body.status, "needs_user");
  assert.equal(s.api.queue.length, 1);
  await s.advance();
  await s.advance();
  assert.equal(
    launches(s.launcher),
    1,
    "no second run while the first waits on permission",
  );
  assert.equal(s.api.queue.length, 1);
  assert.equal(s.runner.heartbeat().instructions.reason, "busy");
  // inspect failing counts as "not ended"
  const inspect = s.launcher.inspect.bind(s.launcher);
  s.launcher.inspect = async () => {
    throw new Error("daemon down");
  };
  await s.advance();
  assert.equal(s.api.queue.length, 1);
  s.launcher.inspect = inspect;
  agent.pending = 0;
  agent.status = "idle";
  await s.advance();
  assert.equal((await s.ledger(ID(1))).agentEnded, true);
  assert.ok(s.logs.some((l) => l.endsWith(ID(1) + " AGENT_ENDED")));
  assert.equal(
    launches(s.launcher),
    2,
    "slot freed only after the agent ended",
  );
  assert.equal(
    s.api.statuses
      .filter((x) => x.id === ID(1))
      .map((x) => x.body.status)
      .join(","),
    "running,needs_user",
    "site status stays needs_user",
  );
});

test("claim lost: a 409 on running is recorded, the agent is still tracked and holds the slot", async () => {
  const s = await setup();
  s.api.add(1, "[fake:done]");
  s.api.add(2);
  s.api.rejectStatus = 1;
  s.api.rejectCode = 409;
  s.api.rejectCurrent = { status: "failed", errorCode: "CLAIM_LOST" };
  await s.runner.tick();
  const e = await s.ledger(ID(1));
  assert.equal(e.rejected.status, 409);
  assert.equal(e.rejected.report, "running");
  assert.ok(s.logs.some((l) => l.endsWith(ID(1) + " CLAIM_LOST")));
  await s.advance();
  await s.advance();
  assert.equal(s.api.queue.length, 1, "slot held while the agent runs");
  await s.launcher.complete(agentFor(s.launcher, ID(1)).id);
  await s.advance();
  assert.equal(
    s.api.statuses.filter((x) => x.id === ID(1)).length,
    0,
    "nothing reported for a lost claim",
  );
  assert.ok(s.logs.some((l) => l.endsWith(ID(1) + " FINAL_NOT_SENT")));
  const after = await s.ledger(ID(1));
  assert.equal(after.agentEnded, true);
  await s.advance();
  assert.equal(
    s.api.queue.length,
    0,
    "next instruction claimed after the agent ended",
  );
});

test("F3: concurrent takeover of a dead holder's lock leaves exactly one owner", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lock-"));
  temps.push(dir);
  const file = path.join(dir, ".dispatch.lock");
  const isAlive = (pid: number) => pid >= 1 && pid <= 50;
  for (let round = 0; round < 20; round++) {
    await writeFile(file, "99999999:dead");
    const tokens = Array.from(
      { length: 8 },
      (_, i) => i + 1 + ":t" + round + "-" + i,
    );
    const won = await Promise.all(
      tokens.map((t) => acquireDispatchLock(file, t, { isAlive })),
    );
    assert.equal(won.filter(Boolean).length, 1, "round " + round);
    assert.equal(await readFile(file, "utf8"), tokens[won.indexOf(true)]);
  }
  // While A takes over a stale lock, B cannot take it over too.
  await writeFile(file, "99999999:dead");
  const a = await acquireDispatchLock(file, "1:A", {
    isAlive,
    afterStaleCheck: async () => {
      assert.equal(await acquireDispatchLock(file, "2:B", { isAlive }), false);
    },
  });
  assert.equal(a, true);
  assert.equal(await readFile(file, "utf8"), "1:A");
  // a takeover file left by a dead process stays for the operator (R3); once removed, takeover works
  await writeFile(file, "99999999:dead");
  await writeFile(file + ".takeover", "99999998:dead");
  let staleSeen = 0;
  const onStaleTakeover = () => staleSeen++;
  assert.equal(
    await acquireDispatchLock(file, "2:B", { isAlive, onStaleTakeover }),
    false,
  );
  assert.equal(
    await acquireDispatchLock(file, "2:B", { isAlive, onStaleTakeover }),
    false,
  );
  assert.equal(staleSeen, 2);
  assert.equal(await readFile(file + ".takeover", "utf8"), "99999998:dead");
  assert.equal(await readFile(file, "utf8"), "99999999:dead");
  await rm(file + ".takeover");
  assert.equal(await acquireDispatchLock(file, "2:B", { isAlive }), true);
  assert.equal(await readFile(file, "utf8"), "2:B");
  // a live holder is never displaced
  assert.equal(await acquireDispatchLock(file, "3:C", { isAlive }), false);
  assert.equal(await readFile(file, "utf8"), "2:B");
});

test("F3: a runner whose lock token was replaced stops dispatching", async () => {
  const s = await setup({ maxActive: 2 });
  await s.runner.tick();
  const claimsBefore = s.api.claims.length;
  await writeFile(
    path.join(s.root, "instructions", ".dispatch.lock"),
    process.ppid + ":other",
  );
  s.api.add(1);
  await s.advance();
  assert.equal(s.api.claims.length, claimsBefore);
  assert.equal(s.api.queue.length, 1);
  assert.equal(s.runner.heartbeat().instructions.reason, "busy");
  assert.ok(s.logs.some((l) => l.endsWith("LOCK_LOST")));
});

test("F4: a result folder swapped for a link between check and open is rejected", async () => {
  const s = await setup();
  s.api.add(1);
  await s.runner.tick();
  const agent = agentFor(s.launcher, ID(1));
  await s.launcher.complete(agent.id);
  const ledgerDir = path.join(s.root, "instructions");
  const dir = path.join(ledgerDir, ID(1));
  const ok = await readResultFile(ledgerDir, ID(1), agent.attemptId);
  assert.equal(ok.kind, "valid");
  const { rename: mv, symlink: ln } = await import("node:fs/promises");
  const other = path.join(s.root, "elsewhere");
  await mkdir(other);
  await writeFile(
    path.join(other, "result.json"),
    await readFile(path.join(dir, "result.json"), "utf8"),
  );
  const swapped = await readResultFile(ledgerDir, ID(1), agent.attemptId, {
    beforeOpen: async () => {
      await mv(dir, dir + ".orig");
      await ln(other, dir);
    },
  });
  assert.equal(swapped.kind, "invalid");
});

// ---------------------------------------------------------------- security review round 2

test("R1: conflictOutcome tells a lost acknowledgement from a lost claim", () => {
  const e = (status?: string, errorCode?: string) =>
    new ApiError(409, { status, errorCode });
  assert.equal(conflictOutcome("running", e("running")), "acked");
  assert.equal(conflictOutcome("running", e("done")), "acked");
  assert.equal(
    conflictOutcome("running", e("failed", "CLAIM_LOST")),
    "claim_lost",
  );
  assert.equal(conflictOutcome("running", e("cancelled")), "rejected");
  assert.equal(
    conflictOutcome("running", e()),
    "rejected",
    "no state in the body: conservative",
  );
  assert.equal(conflictOutcome("done", e("done")), "acked");
  assert.equal(conflictOutcome("done", e("needs_user")), "rejected");
  assert.equal(
    conflictOutcome("failed", e("failed", "CLAIM_LOST")),
    "claim_lost",
  );
  assert.equal(
    conflictOutcome("running", new ApiError(400, { status: "running" })),
    "rejected",
  );
});

async function siteRunner(
  site: ReturnType<typeof fakeSite>,
  base: string,
  s: Awaited<ReturnType<typeof setup>>,
) {
  const api = createInstructionApi((route, init) =>
    fetch(new URL(route, base), {
      ...init,
      headers: { ...init.headers, "X-Reels-Bridge-Key": "review-key" },
    }),
  );
  return new InstructionRunner({
    root: s.root,
    api,
    launcher: s.launcher,
    home: s.home,
    now: () => s.clock.t,
    lockState: async () => ({ locked: false, known: true }),
    retryDelayMs: 0,
    log: (m) => s.logs.push(m),
  });
}

test("running_ack_loss_still_reports_final_and_releases_server_slot", async () => {
  const site = fakeSite("review-key");
  const base = await listen(site.server);
  const s = await setup();
  const runner = await siteRunner(site, base, s);
  for (const n of [41, 42])
    site.items.push({
      id: ID(n),
      text: "[fake:done]",
      target: null,
      end_level: null,
      status: "queued",
    });
  site.ctl.drop = (id, status) => id === ID(41) && status === "running";
  try {
    await runner.tick();
    assert.equal(site.items[0].status, "running", "the site committed running");
    assert.equal(
      (await s.ledger(ID(41))).runningReported,
      false,
      "the bridge did not see the answer",
    );
    s.clock.t += 15000;
    await runner.tick(); // resend → 409 {status: running} → acknowledged
    assert.ok(s.logs.some((l) => l.endsWith(ID(41) + " REPORT_ACKED")));
    assert.equal((await s.ledger(ID(41))).rejected, undefined);
    await s.launcher.complete(agentFor(s.launcher, ID(41)).id);
    s.clock.t += 15000;
    await runner.tick();
    assert.equal(site.items[0].status, "done");
    assert.equal(
      site.items[1].status,
      "running",
      "server slot released, next instruction runs",
    );
  } finally {
    await runner.release();
    site.server.close();
  }
});

test("R1: a lost acknowledgement of the final result is treated as delivered", async () => {
  const site = fakeSite("review-key");
  const base = await listen(site.server);
  const s = await setup();
  const runner = await siteRunner(site, base, s);
  site.items.push({
    id: ID(43),
    text: "[fake:needs_user]",
    target: null,
    end_level: null,
    status: "queued",
  });
  site.ctl.drop = (id, status) => id === ID(43) && status === "needs_user";
  try {
    await runner.tick();
    await s.launcher.complete(agentFor(s.launcher, ID(43)).id);
    s.clock.t += 15000;
    await runner.tick(); // final committed, answer dropped
    assert.equal(site.items[0].status, "needs_user");
    assert.equal((await s.ledger(ID(43))).finalReported, false);
    s.clock.t += 15000;
    await runner.tick(); // resend → 409 {status: needs_user} → acknowledged
    const e = await s.ledger(ID(43));
    assert.equal(e.finalReported, true);
    assert.equal(e.rejected, undefined);
    assert.ok(s.logs.some((l) => l.endsWith(ID(43) + " REPORT_ACKED")));
  } finally {
    await runner.release();
    site.server.close();
  }
});

test("uncertain_launch_keeps_slot_until_reconciled", async () => {
  const s = await setup();
  s.launcher.launchFails = "after"; // the agent starts, the response is lost
  const find = s.launcher.findByLabel.bind(s.launcher);
  s.launcher.findByLabel = async () => {
    throw new Error("temporary lookup failure");
  };
  s.api.add(31, "[fake:hang]");
  s.api.add(32, "[fake:hang]");
  await s.runner.tick();
  assert.equal(s.launcher.agents.size, 1);
  const e = await s.ledger(ID(31));
  assert.equal(e.launchUncertain, true);
  assert.equal(e.agentId, null);
  assert.deepEqual(
    [s.api.statuses.at(-1)!.body.status, s.api.statuses.at(-1)!.body.errorCode],
    ["failed", "LAUNCH_FAILED"],
    "the site still gets the fixed failure",
  );
  s.launcher.launchFails = false;
  await s.advance();
  await s.advance(8 * 86400_000); // past retention: the uncertain entry is not pruned
  assert.equal(
    s.launcher.agents.size,
    1,
    "an unresolved first launch must reserve capacity",
  );
  assert.equal(s.api.queue.length, 1);
  assert.equal(s.runner.heartbeat().instructions.reason, "busy");
  assert.equal((await s.ledger(ID(31))).launchUncertain, true);
  // the lookup recovers: adopt the one session and follow it to its end
  s.launcher.findByLabel = find;
  await s.advance();
  const adopted = await s.ledger(ID(31));
  assert.equal(adopted.agentId, agentFor(s.launcher, ID(31)).id);
  assert.equal(adopted.launchUncertain, false);
  assert.equal(s.api.queue.length, 1, "still running: slot held");
  agentFor(s.launcher, ID(31)).status = "idle";
  await s.advance();
  assert.equal((await s.ledger(ID(31))).agentEnded, true);
  assert.equal(
    s.launcher.agents.size,
    2,
    "next instruction only after the adopted agent ended",
  );
  assert.equal(
    s.api.statuses.filter((x) => x.id === ID(31)).length,
    1,
    "nothing more is reported for the uncertain one",
  );
});

test("R2: a launch confirmed not started (lookup ok, no session) frees the slot", async () => {
  const s = await setup();
  s.launcher.launchFails = "before";
  s.api.add(33);
  s.api.add(34);
  await s.runner.tick();
  assert.equal((await s.ledger(ID(33))).launchUncertain, undefined);
  s.launcher.launchFails = false;
  await s.advance();
  assert.equal(s.launcher.agents.size, 1);
  assert.equal(agentFor(s.launcher, ID(34)).labels.instruction, ID(34));
});

test("R2: restart reconcile marks an unconfirmed launch uncertain and keeps its slot", async () => {
  const s = await setup();
  const dir = path.join(s.root, "instructions", ID(35));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(dir, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: ID(35),
      attemptId: "a",
      sessionName: "sites-00000000",
      phase: "launching",
      target: null,
      endLevel: null,
      claimedAt: "2026-11-21T00:00:00Z",
      agentId: null,
      launchedAt: null,
      runningReported: false,
      idleSince: null,
      resultRequestedAt: null,
      final: null,
      finalReported: false,
      finishedAt: null,
    }),
    { mode: 0o600 },
  );
  const find = s.launcher.findByLabel.bind(s.launcher);
  s.launcher.findByLabel = async () => {
    throw new Error("lookup failure");
  };
  s.api.add(36);
  await s.runner.tick();
  const e = await s.ledger(ID(35));
  assert.equal(e.launchUncertain, true);
  assert.equal(e.final.errorCode, "LAUNCH_FAILED");
  assert.equal(s.api.queue.length, 1, "slot held");
  s.launcher.findByLabel = find;
  const seeded = s.launcher.seed({ instruction: ID(35) }, "idle");
  await s.advance();
  assert.equal((await s.ledger(ID(35))).agentId, seeded);
  await s.advance();
  assert.equal((await s.ledger(ID(35))).agentEnded, true);
  await s.advance();
  assert.equal(s.api.queue.length, 0, "claimed after the adopted agent ended");
  assert.equal(
    launches(s.launcher),
    1,
    "the uncertain one was never relaunched",
  );
});

test("stale_takeover_cleanup_preserves_new_live_mutex", async () => {
  const { writeFileSync } = await import("node:fs");
  const dir = await mkdtemp(path.join(os.tmpdir(), "review-lock-"));
  temps.push(dir);
  const file = path.join(dir, ".dispatch.lock");
  const mutex = file + ".takeover";
  await writeFile(file, "99999999:old");
  await writeFile(mutex, "99999998:old");
  let scheduled = false;
  await acquireDispatchLock(file, "3:review", {
    isAlive: (pid) => {
      if (pid === 99999998) {
        // another contender replaces the dead mutex before this check resumes
        scheduled = true;
        writeFileSync(mutex, "1:live", { mode: 0o600 });
        return false;
      }
      return pid === 1 || pid === 3;
    },
  });
  assert.equal(scheduled, true);
  assert.equal(
    await readFile(mutex, "utf8").catch(() => null),
    "1:live",
    "cleanup must preserve a new live mutex",
  );
});

test("R3: a runner facing a dead takeover file stays busy and logs STALE_TAKEOVER once", async () => {
  const s = await setup();
  const ledger = path.join(s.root, "instructions");
  await mkdir(ledger, { recursive: true, mode: 0o700 });
  await writeFile(path.join(ledger, ".dispatch.lock"), "99999999:dead");
  await writeFile(
    path.join(ledger, ".dispatch.lock.takeover"),
    "99999998:dead",
  );
  s.api.add(1);
  await s.runner.tick();
  await s.advance();
  assert.equal(s.runner.heartbeat().instructions.reason, "busy");
  assert.equal(s.api.claims.length, 0);
  assert.equal(s.logs.filter((l) => l.endsWith("STALE_TAKEOVER")).length, 1);
  assert.equal(
    await readFile(path.join(ledger, ".dispatch.lock.takeover"), "utf8"),
    "99999998:dead",
  );
  await rm(path.join(ledger, ".dispatch.lock.takeover")); // operator clean-up
  await s.advance();
  assert.equal(s.api.claims.length, 1);
});

test("PaseoLauncher.ready reuses a healthy status and rechecks failures", async () => {
  let t = 0;
  let statusCalls = 0;
  let healthy = true;
  const exec: Exec = async (_file, args) => {
    if (args[0] !== "status") throw new Error("unexpected " + args[0]);
    statusCalls++;
    return {
      stdout: JSON.stringify(
        healthy
          ? { localDaemon: "running", connectedDaemon: "reachable" }
          : { localDaemon: "stopped", connectedDaemon: "unreachable" },
      ),
    };
  };
  const launcher = new PaseoLauncher(exec, PASEO_BIN, () => t);
  assert.equal(await launcher.ready(), true);
  t += 10_000;
  assert.equal(await launcher.ready(), true);
  assert.equal(statusCalls, 1, "healthy status cached");
  t += 5 * 60_000;
  healthy = false;
  assert.equal(await launcher.ready(), false);
  assert.equal(await launcher.ready(), false);
  assert.equal(statusCalls, 3, "failures are not cached");
});

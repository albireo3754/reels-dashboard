import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AsideRunner, asideEnv, resolveAsideBin } from "../../src/desktop/scheduler-aside";
import { Scheduler } from "../../src/desktop/scheduler";
import { ScheduleFileStore, SchedulerDb, type RunRow } from "../../src/desktop/scheduler-store";
import { dayIn } from "../../src/features/scheduler";
import type { BlogComment } from "../../src/shared/blog-comments";
import { exampleSchedule, writeFakeAside } from "../fixtures/scheduler";

const recordedUrl = "https://m.blog.naver.com/example-blog/223000000001";

async function setup(t: test.TestContext, mode: string, options: { records?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "scheduler-aside-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = path.join(root, "fake");
  await mkdir(fake);
  const bin = await writeFakeAside(fake);
  const skillsDir = path.join(root, "skills");
  await mkdir(path.join(skillsDir, "example-skill"), { recursive: true });
  await writeFile(path.join(skillsDir, "example-skill", "SKILL.md"), "# example\n");
  const today = dayIn(new Date(), "Asia/Seoul");
  const comments = {
    list: async ({ postUrl }: { postUrl?: string }) => ({
      comments:
        options.records !== false && postUrl === recordedUrl
          ? [{ postUrl, postedAt: today, note: `[${today} 루프] 수락함 / 답방 댓글 / 공감 확인`, status: "posted", updatedAt: new Date().toISOString() } as BlogComment]
          : [],
    }),
  };
  const logs: string[] = [];
  const runner = new AsideRunner({
    root,
    asideBin: bin,
    skillsDir,
    reelsCli: path.join(root, "bin", "reels"),
    env: { ...asideEnv(process.env, root), FAKE_ASIDE_DIR: fake, FAKE_ASIDE_MODE: mode },
    comments,
    killGraceMs: 300,
    sessionPollMs: 30,
    sessionPollMaxMs: 3000,
    streamGraceMs: 200,
  });
  const calls = async () =>
    (await readFile(path.join(fake, "calls.jsonl"), "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  const stopped = async () => (await readFile(path.join(fake, "stopped.txt"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  const sessionRows = async () => (await readFile(path.join(fake, "sessions.txt"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  /** The helper's pid, once it has its SIGTERM handler in place. */
  const childPid = async () => {
    const until = Date.now() + 5000;
    for (;;) {
      const text = await readFile(path.join(fake, "child.pid"), "utf8").catch(() => "");
      if (text) return Number(text);
      if (Date.now() > until) throw new Error("helper did not start");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  return { root, runner, calls, stopped, logs, sessionRows, childPid };
}

function runRow(runId = "r_test_1"): RunRow {
  const now = new Date().toISOString();
  return {
    run_id: runId,
    schedule_id: "example-loop",
    occurrence_key: `manual:${runId}`,
    trigger: "manual",
    scheduled_at: now,
    deadline_at: now,
    status: "running",
    lock_key: "aside",
    reason: null,
    preflight_failed_at: null,
    notified: 0,
    pid: null,
    pid_started: null,
    host_pid: null,
    host_pid_started: null,
    session_id: null,
    exit_code: null,
    signal: null,
    created_at: now,
    started_at: now,
    finished_at: null,
    result_json: null,
  };
}

async function runOnce(runner: AsideRunner, schedule = exampleSchedule()) {
  const sessions: string[] = [];
  const logs: string[] = [];
  const handle = await runner.start({ schedule, run: runRow(), onSession: (id) => sessions.push(id), log: (message) => logs.push(message) });
  const outcome = await handle.done;
  return { outcome, sessions, logs };
}
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("ok: report matches the app records; global options precede exec", async (t) => {
  const { runner, calls, root } = await setup(t, "ok");
  const schedule = exampleSchedule({ action: { kind: "aside", skill: "example-skill", hostProfile: "abc-123", model: "example/model", params: { maxVisit: 2, expectedBlogId: "example-blog" } } });
  assert.equal(await runner.preflight(schedule), undefined);
  const { outcome, sessions } = await runOnce(runner, schedule);
  assert.deepEqual([outcome.status, outcome.reason, outcome.exitCode], ["ok", undefined, 0]);
  assert.equal(sessions.length, 1);
  const exec = (await calls()).find((args) => args.includes("exec"))!;
  assert.deepEqual(exec.slice(0, -1), ["--permission", "full-access", "--profile", "abc-123", "-m", "example/model", "exec"]);
  const prompt = exec.at(-1)!;
  assert.doesNotMatch(prompt, /example-blog|maxVisit/, "personal params reach Aside only through the handoff file");
  const dir = path.join(root, "scheduler", "runs", "r_test_1");
  const handoff = await readFile(path.join(dir, "handoff.md"), "utf8");
  assert.match(handoff, /- runId: r_test_1/);
  assert.match(handoff, /- expectedBlogId: "example-blog"/);
  assert.match(await readFile(path.join(dir, "stdout.log"), "utf8"), /```json/);
  assert.equal(JSON.parse(await readFile(path.join(dir, "result.json"), "utf8")).verdict, "ok");
});

test("exit 0 with 'unknown option' fails", async (t) => {
  const { runner } = await setup(t, "unknown-option");
  const { outcome } = await runOnce(runner);
  assert.deepEqual([outcome.status, outcome.reason, outcome.exitCode], ["failed", "cli-error", 0]);
});

test("exit 0 without a JSON report fails", async (t) => {
  const { runner } = await setup(t, "no-json");
  const { outcome } = await runOnce(runner);
  assert.deepEqual([outcome.status, outcome.reason], ["failed", "no-result"]);
});

test("a report for another run id fails", async (t) => {
  const { runner } = await setup(t, "run-id-mismatch");
  assert.equal((await runOnce(runner)).outcome.reason, "run-id-mismatch");
});

test("a record the app does not have makes the run partial", async (t) => {
  const { runner } = await setup(t, "missing-record");
  const { outcome } = await runOnce(runner);
  assert.deepEqual([outcome.status, outcome.reason], ["partial", "record-mismatch"]);
});

test("captcha fails and asks to pause the schedule", async (t) => {
  const { runner } = await setup(t, "captcha");
  const { outcome } = await runOnce(runner);
  assert.deepEqual([outcome.status, outcome.reason, outcome.pause], ["failed", "blocked:captcha", "captcha"]);
});

test("two new sessions at once: the session id stays unknown", async (t) => {
  const { runner } = await setup(t, "two-sessions");
  const { outcome, sessions } = await runOnce(runner);
  assert.equal(outcome.status, "ok");
  assert.deepEqual(sessions, []);
});

test("preflight: disconnected host, missing skill and missing aside", async (t) => {
  const { runner } = await setup(t, "disconnected");
  assert.equal(await runner.preflight(exampleSchedule()), "host-disconnected");
  const connected = await setup(t, "ok");
  assert.equal(await connected.runner.preflight(exampleSchedule({ action: { kind: "aside", skill: "absent-skill", params: {} } })), "skill-missing");
  assert.equal(
    await connected.runner.preflight(exampleSchedule({ action: { kind: "aside", skill: "example-skill", hostProfile: "other-profile", params: {} } })),
    "host-disconnected",
  );
  const missing = new AsideRunner({ root: connected.root, asideBin: path.join(connected.root, "nope"), skillsDir: connected.root, reelsCli: "reels", env: {}, comments: { list: async () => ({ comments: [] }) } });
  assert.equal(await missing.preflight(exampleSchedule()), "aside-missing");
});

test("aside path: ~/.local/bin by default, REELS_ASIDE_BIN override; PATH gains the user bin folders", () => {
  assert.equal(resolveAsideBin({}, "/Users/example"), "/Users/example/.local/bin/aside");
  assert.equal(resolveAsideBin({ REELS_ASIDE_BIN: "/tmp/fake-aside" }, "/Users/example"), "/tmp/fake-aside");
  assert.match(asideEnv({ PATH: "/usr/bin" }, "/Users/example").PATH!, /^\/opt\/homebrew\/bin:\/usr\/local\/bin:\/Users\/example\/\.local\/bin:\/usr\/bin$/);
});

async function withScheduler(t: test.TestContext, mode: string) {
  const env = await setup(t, mode);
  await new ScheduleFileStore(env.root).update(() => ({ schedules: [exampleSchedule()], result: undefined }));
  const clock = { now: new Date() };
  const notices: string[] = [];
  const scheduler = new Scheduler({ root: env.root, runner: env.runner, now: () => clock.now, notify: (n) => notices.push(n.title), log: () => {}, startDelayMs: 0 });
  t.after(() => scheduler.dispose());
  return { ...env, scheduler, clock, notices };
}
const waitFor = async (check: () => boolean, ms = 5000) => {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(check(), "condition not reached");
};

test("aside not connected: the run stays pending, then ends blocked", async (t) => {
  const { scheduler, clock, calls, notices } = await withScheduler(t, "disconnected");
  const { runId } = await scheduler.runNow({ id: "example-loop" });
  await scheduler.tick();
  assert.deepEqual([scheduler.db.get(runId)?.status, scheduler.db.get(runId)?.reason], ["pending", "host-disconnected"]);
  clock.now = new Date(clock.now.getTime() + 11 * 60_000);
  await scheduler.tick();
  assert.deepEqual([scheduler.db.get(runId)?.status, scheduler.db.get(runId)?.reason], ["blocked", "host-disconnected"]);
  assert.ok(!(await calls()).some((args) => args.includes("exec")), "never executed");
  assert.equal(notices.length, 2);
});

test("a hanging run hits the timeout: SIGTERM, then aside session stop, then failed/timeout", async (t) => {
  const { scheduler, clock, stopped } = await withScheduler(t, "hang");
  const { runId } = await scheduler.runNow({ id: "example-loop" });
  await scheduler.tick();
  await waitFor(() => !!scheduler.db.get(runId)?.session_id);
  const session = scheduler.db.get(runId)!.session_id!;
  assert.ok(scheduler.db.get(runId)?.pid, "child pid recorded");
  clock.now = new Date(clock.now.getTime() + 46 * 60_000);
  await scheduler.tick();
  await scheduler.idle();
  assert.deepEqual([scheduler.db.get(runId)?.status, scheduler.db.get(runId)?.reason], ["failed", "timeout"]);
  assert.deepEqual(await stopped(), [session]);
});

test("a child that ignores SIGTERM is killed after the grace period", async (t) => {
  const { scheduler, clock } = await withScheduler(t, "hang-ignore-term");
  const { runId } = await scheduler.runNow({ id: "example-loop" });
  await scheduler.tick();
  await waitFor(() => !!scheduler.db.get(runId)?.session_id);
  clock.now = new Date(clock.now.getTime() + 46 * 60_000);
  await scheduler.tick();
  await scheduler.idle();
  const row = scheduler.db.get(runId)!;
  assert.deepEqual([row.status, row.reason, row.signal], ["failed", "timeout", "SIGKILL"]);
});

test("quitting the app stops the child, calls aside session stop and records interrupted", async (t) => {
  const { scheduler, stopped, root } = await withScheduler(t, "hang");
  const { runId } = await scheduler.runNow({ id: "example-loop" });
  await scheduler.tick();
  await waitFor(() => !!scheduler.db.get(runId)?.session_id);
  const session = scheduler.db.get(runId)!.session_id!;
  await scheduler.dispose();
  assert.deepEqual(await stopped(), [session]);
  const db = new SchedulerDb(root);
  t.after(() => db.close());
  assert.deepEqual([db.get(runId)?.status, db.get(runId)?.reason], ["interrupted", "app-quit"]);
});

test("another Aside session that appears first is never taken as this run's session", async (t) => {
  const { runner, sessionRows } = await setup(t, "foreign-session");
  const { outcome, sessions } = await runOnce(runner);
  assert.equal(outcome.status, "ok");
  assert.equal(sessions.length, 1);
  const rows = await sessionRows();
  assert.equal(rows.length, 2);
  assert.match(rows.find((row) => row.startsWith(sessions[0]))!, /\[예약 r_test_1\]/);
});

test("a timeout never stops a session that is not this run's", async (t) => {
  const { scheduler, clock, stopped, sessionRows } = await withScheduler(t, "hang-foreign");
  const { runId } = await scheduler.runNow({ id: "example-loop" });
  await scheduler.tick();
  await waitFor(() => !!scheduler.db.get(runId)?.pid);
  await new Promise((resolve) => setTimeout(resolve, 400)); // let discovery poll the foreign row
  assert.equal((await sessionRows()).length, 1);
  clock.now = new Date(clock.now.getTime() + 46 * 60_000);
  await scheduler.tick();
  await scheduler.idle();
  const row = scheduler.db.get(runId)!;
  assert.deepEqual([row.status, row.reason, row.session_id], ["failed", "timeout", null]);
  assert.deepEqual(await stopped(), []);
});

test("stopping kills a helper of the aside group that ignores SIGTERM after aside itself exited", async (t) => {
  const { scheduler, clock, childPid } = await withScheduler(t, "child-ignores-term");
  const { runId } = await scheduler.runNow({ id: "example-loop" });
  await scheduler.tick();
  await waitFor(() => !!scheduler.db.get(runId)?.session_id);
  const helper = await childPid();
  t.after(() => void (isAlive(helper) && process.kill(helper, "SIGKILL")));
  assert.ok(isAlive(helper));
  clock.now = new Date(clock.now.getTime() + 46 * 60_000);
  await scheduler.tick();
  await scheduler.idle();
  assert.deepEqual([scheduler.db.get(runId)?.status, scheduler.db.get(runId)?.reason], ["failed", "timeout"]);
  await waitFor(() => !isAlive(helper), 2000);
});

test("a run ends when aside exits even if a helper keeps its output pipe open", async (t) => {
  const { runner, childPid } = await setup(t, "exit-leaves-child");
  const started = Date.now();
  const { outcome, logs } = await runOnce(runner);
  const helper = await childPid();
  t.after(() => void (isAlive(helper) && process.kill(helper, "SIGKILL")));
  assert.equal(outcome.status, "ok");
  assert.ok(Date.now() - started < 5000, "did not wait for the helper");
  assert.ok(logs.some((message) => /still running/.test(message)));
});

test("stdout.log is redacted, and a log write error does not escape the run", async (t) => {
  const secret = await setup(t, "secret");
  await runOnce(secret.runner);
  const log = await readFile(path.join(secret.root, "scheduler", "runs", "r_test_1", "stdout.log"), "utf8");
  assert.doesNotMatch(log, /example-token-123/);
  assert.match(log, /Authorization: \[redacted\]/);
  const broken = await setup(t, "ok");
  await mkdir(path.join(broken.root, "scheduler", "runs", "r_test_1", "stdout.log"), { recursive: true });
  const { outcome, logs } = await runOnce(broken.runner);
  assert.equal(outcome.status, "ok");
  assert.ok(logs.some((message) => /stdout\.log write failed/.test(message)));
});

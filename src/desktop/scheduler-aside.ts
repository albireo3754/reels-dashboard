import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants, createWriteStream } from "node:fs";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { redactLog, type ExecutionLogs } from "../shared/lib/execution-logs";
import { loggedSpawn } from "../shared/lib/logged-process";
import type { BlogComment, BlogCommentListInput } from "../shared/blog-comments";
import {
  asideExecArgs,
  asidePrompt,
  asideResultSchema,
  canonicalPostUrl,
  dayIn,
  hostProfileConnected,
  judgeAsideRun,
  lastJsonBlock,
  parseSessionRows,
  renderHandoff,
  type RecordFact,
  type Schedule,
} from "../features/scheduler";
import { runDir, type RunRow } from "./scheduler-store";
import type { ActionHandle, ActionOutcome, ActionRunner } from "./scheduler";

const OUTPUT_LIMIT = 5 * 1024 * 1024;

/** The aside CLI path: `~/.local/bin/aside`, or REELS_ASIDE_BIN for tests and QA. Never read from settings. */
export function resolveAsideBin(env: NodeJS.ProcessEnv, home: string) {
  return env.REELS_ASIDE_BIN ? path.resolve(env.REELS_ASIDE_BIN) : path.join(home, ".local/bin/aside");
}
/** An app opened from Finder has launchd's minimal PATH; aside and its helpers live in these folders. */
export function asideEnv(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".local/bin")];
  return { ...env, PATH: [...extra, env.PATH ?? "/usr/bin:/bin"].join(":") };
}

export interface AsideRunnerOptions {
  /** The app profile (userData). */
  root: string;
  asideBin: string;
  /** Aside user skills folder (`~/.aside/u/0/skills/user`). */
  skillsDir: string;
  /** Absolute `reels` CLI path written into the handoff. */
  reelsCli: string;
  env: NodeJS.ProcessEnv;
  comments: { list(input: BlogCommentListInput): Promise<{ comments: BlogComment[] }> };
  logs?: ExecutionLogs;
  now?: () => Date;
  /** SIGTERM → SIGKILL grace. */
  killGraceMs?: number;
  sessionPollMs?: number;
  sessionPollMaxMs?: number;
  commandTimeoutMs?: number;
  /** After the aside process exits, how long to wait for its output pipes to close. */
  streamGraceMs?: number;
}

/**
 * Runs one scheduled aside session: `aside --permission full-access [--profile] [-m] exec "<prompt>"`
 * with a per-run handoff file, finds its session id by diffing `aside session list` (only a new row
 * that carries this run's id), and judges
 * the result against the app's comment records. Exit code 0 alone is never success.
 */
export class AsideRunner implements ActionRunner {
  private now: () => Date;
  constructor(private options: AsideRunnerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private command(args: string[], timeout = this.options.commandTimeoutMs ?? 15_000) {
    return new Promise<string>((resolve, reject) => {
      const child = execFile(this.options.asideBin, args, { env: this.options.env, timeout, maxBuffer: 1024 * 1024 }, (error, stdout) =>
        error ? reject(error) : resolve(String(stdout)),
      );
      child.stdin?.end();
    });
  }

  async preflight(schedule: Schedule): Promise<string | undefined> {
    if (!(await access(this.options.asideBin, constants.X_OK).then(() => true, () => false))) return "aside-missing";
    const skill = path.join(this.options.skillsDir, schedule.action.skill, "SKILL.md");
    if (!(await access(skill, constants.R_OK).then(() => true, () => false))) return "skill-missing";
    const profiles = await this.command(["host", "profiles"]).catch(() => "");
    if (!hostProfileConnected(profiles, schedule.action.hostProfile)) return "host-disconnected";
    return undefined;
  }

  private async sessions() {
    return parseSessionRows(await this.command(["session", "list"]));
  }

  async stopSession(sessionId: string) {
    await this.command(["session", "stop", sessionId]).catch(() => {});
  }

  /** Stops a process group left by an app instance that is gone, then its Aside session. */
  async stopOrphan(pid: number, sessionId: string | null) {
    await terminate(pid, () => !alive(pid), this.options.killGraceMs ?? 10_000);
    if (sessionId) await this.stopSession(sessionId);
  }

  async start(context: { schedule: Schedule; run: RunRow; onSession(id: string): void; log(message: string): void }): Promise<ActionHandle> {
    const { schedule, run } = context;
    const dir = runDir(this.options.root, run.run_id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const startedAt = new Date(run.started_at ?? this.now().toISOString());
    const startDay = dayIn(startedAt, schedule.trigger.timezone);
    const handoff = path.join(dir, "handoff.md");
    await writeFile(
      handoff,
      renderHandoff({
        runId: run.run_id,
        schedule,
        trigger: run.trigger,
        scheduledAt: new Date(run.scheduled_at),
        startedAt,
        day: startDay,
        userData: this.options.root,
        reelsCli: this.options.reelsCli,
      }),
      { mode: 0o600 },
    );
    await chmod(handoff, 0o600);
    const args = asideExecArgs(schedule.action, asidePrompt(schedule.action.skill, handoff, run.run_id));
    const before = await this.sessions().catch(() => undefined);
    const spawnOptions = { detached: true, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"], env: this.options.env };
    const child: ChildProcess = this.options.logs
      ? loggedSpawn(this.options.logs, { source: "scheduler", label: `예약 실행 · ${schedule.name}`, jobId: run.run_id }, this.options.asideBin, args, spawnOptions)
      : spawn(this.options.asideBin, args, spawnOptions);
    // The log keeps the first 5 MB, redacted like the execution log. A write error (disk full)
    // only stops the file; it never reaches the main process as an unhandled 'error'.
    const logFile = createWriteStream(path.join(dir, "stdout.log"), { mode: 0o600 });
    const logClosed = new Promise<void>((resolve) => logFile.once("close", () => resolve()));
    let logFailed = false;
    logFile.on("error", (error) => {
      if (!logFailed) context.log(`stdout.log write failed: ${error.message}`);
      logFailed = true;
    });
    let written = 0;
    let output = "";
    const consumer = () => {
      const decoder = new StringDecoder("utf8");
      return (chunk: Buffer) => {
        const text = decoder.write(chunk);
        if (!logFailed && written < OUTPUT_LIMIT && text) {
          const part = redactLog(text).slice(0, OUTPUT_LIMIT - written);
          logFile.write(part);
          written += Buffer.byteLength(part);
        }
        output = (output + text).slice(-OUTPUT_LIMIT);
      };
    };
    child.stdout?.on("data", consumer());
    child.stderr?.on("data", consumer());
    // The run ends when the aside process exits. A helper that inherited its stdout may keep the
    // pipes open, so 'close' is awaited only briefly and the pipes are then let go.
    let exited = false;
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      const closed = new Promise<void>((done) => child.once("close", () => done()));
      child.once("error", () => {
        if (!child.pid) {
          exited = true;
          resolve({ code: null, signal: null });
        }
      });
      child.once("exit", (code, signal) => {
        void Promise.race([closed, delay(this.options.streamGraceMs ?? 2000)]).then(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          exited = true;
          resolve({ code, signal });
        });
      });
    });

    // A new row is this run's session only when its title carries the run id (the prompt starts
    // with it). Another session that appears meanwhile (an Aside hourly job, a chat) is never
    // taken: its id would later receive `aside session stop`.
    let sessionId: string | undefined;
    const discovery = (async () => {
      if (!before) return context.log("aside session list unavailable before start; session id not recorded");
      const step = this.options.sessionPollMs ?? 5000;
      const until = Date.now() + (this.options.sessionPollMaxMs ?? 60_000);
      for (let first = true; ; first = false) {
        if (!first) await Promise.race([delay(step), exit]);
        const after = await this.sessions().catch(() => undefined);
        const fresh = after ? [...after].filter(([id]) => !before.has(id)) : [];
        const mine = fresh.filter(([, row]) => row.includes(run.run_id));
        if (mine.length === 1) {
          sessionId = mine[0][0];
          context.onSession(sessionId);
          return;
        }
        if (mine.length > 1) return context.log(`${mine.length} new aside sessions carry this run id; session id not recorded`);
        if (exited || Date.now() >= until)
          return context.log(`no new aside session carried this run id (${fresh.length} other new); session id not recorded`);
      }
    })();

    const done = exit.then(async ({ code, signal }): Promise<ActionOutcome> => {
      await discovery.catch(() => {});
      if (!logFile.destroyed) logFile.end();
      await logClosed;
      if (child.pid && groupAlive(child.pid)) context.log("aside exited; processes of its group are still running");
      const endDay = dayIn(this.now(), schedule.trigger.timezone);
      const records = await this.recordFacts(output);
      const maxVisit = schedule.action.params.maxVisit;
      const verdict = judgeAsideRun({
        exitCode: code,
        signal,
        stdout: output,
        runId: run.run_id,
        days: [...new Set([startDay, endDay])],
        startedAt: startedAt.toISOString(),
        maxRecords: typeof maxVisit === "number" ? maxVisit : undefined,
        records,
      });
      const summary = {
        verdict: verdict.status,
        reason: verdict.reason ?? null,
        matched: verdict.matched,
        sessionId: sessionId ?? null,
        result: verdict.result ?? null,
      };
      await writeFile(path.join(dir, "result.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 }).catch(() => {});
      return { status: verdict.status, reason: verdict.reason, exitCode: code, signal, result: summary, pause: verdict.pause, counts: verdict.result };
    });

    return {
      pid: child.pid,
      done,
      stop: async () => {
        // The whole process group: a helper that ignores SIGTERM is killed even after aside itself exited.
        if (child.pid && (!exited || groupAlive(child.pid))) await terminate(child.pid, () => exited, this.options.killGraceMs ?? 10_000);
        await exit;
        await discovery.catch(() => {});
        if (sessionId) await this.stopSession(sessionId);
      },
    };
  }

  /** Reads the app's comment record for each post the report names. */
  private async recordFacts(output: string) {
    const facts = new Map<string, RecordFact>();
    const { json } = lastJsonBlock(output);
    if (json === undefined) return facts;
    let parsed;
    try {
      parsed = asideResultSchema.safeParse(JSON.parse(json));
    } catch {
      return facts;
    }
    if (!parsed.success) return facts;
    for (const record of parsed.data.records) {
      const url = canonicalPostUrl(record.postUrl);
      if (!url || facts.has(url)) continue;
      const found = await this.options.comments.list({ postUrl: url, limit: 20 }).catch(() => undefined);
      // The record this run wrote is the one updated last.
      const comment = found?.comments.reduce<BlogComment | undefined>((best, c) => (!best || c.updatedAt > best.updatedAt ? c : best), undefined);
      if (comment) facts.set(url, { postedAt: comment.postedAt, note: comment.note, status: comment.status, updatedAt: comment.updatedAt });
    }
    return facts;
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
/** True while any process of the group led by `pid` is left (the leader itself may be gone). */
const groupAlive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
const signalGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
};
/**
 * SIGTERM to the process group, SIGKILL after the grace period. Done only when the leader is
 * gone and so is every process of its group: a member that outlived the leader is killed too.
 */
async function terminate(pid: number, leaderGone: () => boolean, graceMs: number) {
  const gone = () => leaderGone() && !groupAlive(pid);
  signalGroup(pid, "SIGTERM");
  const until = Date.now() + graceMs;
  while (!gone() && Date.now() < until) await delay(Math.min(100, graceMs));
  if (!gone()) signalGroup(pid, "SIGKILL");
}

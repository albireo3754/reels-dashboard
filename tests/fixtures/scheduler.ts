import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ActionHandle, ActionOutcome, ActionRunner } from "../../src/desktop/scheduler";
import type { RunRow } from "../../src/desktop/scheduler-store";
import type { Schedule } from "../../src/features/scheduler";

/** A schedule with public example values only. */
export function exampleSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "example-loop",
    name: "Example loop",
    enabled: true,
    trigger: { type: "cron", expr: "10 18 * * *", timezone: "Asia/Seoul" },
    misfire: { catchUpWithinMinutes: 300 },
    limits: { timeoutMinutes: 45, maxRunsPerDay: 1 },
    action: { kind: "aside", skill: "example-skill", params: { maxAccept: 2, maxVisit: 2, expectedBlogId: "example-blog" } },
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

/** In-process runner: each start returns a handle the test finishes (or `auto` finishes at once). */
export class FakeRunner implements ActionRunner {
  preflightFailure: string | undefined;
  preflights = 0;
  starts: RunRow[] = [];
  stoppedSessions: string[] = [];
  orphans: { pid: number; sessionId: string | null }[] = [];
  handles: { run: RunRow; finish(outcome: ActionOutcome): void; stopped: boolean }[] = [];
  constructor(public auto?: (run: RunRow) => ActionOutcome) {}
  async preflight() {
    this.preflights++;
    return this.preflightFailure;
  }
  async start(context: { run: RunRow; onSession(id: string): void }): Promise<ActionHandle> {
    this.starts.push(context.run);
    let finish!: (outcome: ActionOutcome) => void;
    const done = new Promise<ActionOutcome>((resolve) => (finish = resolve));
    const entry = { run: context.run, finish, stopped: false };
    this.handles.push(entry);
    context.onSession(`Sess${this.starts.length}`);
    if (this.auto) finish(this.auto(context.run));
    return {
      done,
      stop: async () => {
        entry.stopped = true;
        finish({ status: "failed", reason: "exit", exitCode: null, signal: "SIGTERM" });
      },
    };
  }
  async stopSession(id: string) {
    this.stoppedSessions.push(id);
  }
  async stopOrphan(pid: number, sessionId: string | null) {
    this.orphans.push({ pid, sessionId });
  }
}

/**
 * A fake `aside` executable (a node script) for the real AsideRunner. FAKE_ASIDE_MODE picks the
 * answer; every call's argv is appended to calls.jsonl in FAKE_ASIDE_DIR.
 */
export async function writeFakeAside(dir: string) {
  const file = path.join(dir, "aside");
  await writeFile(
    file,
    `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const dir = process.env.FAKE_ASIDE_DIR, mode = process.env.FAKE_ASIDE_MODE || "ok";
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify(args) + "\\n");
const sessions = path.join(dir, "sessions.txt");
if (args[0] === "host" && args[1] === "profiles") {
  console.log(mode === "disconnected" ? "abc-123  Example  disconnected" : "abc-123  Example  connected");
  process.exit(0);
}
if (args[0] === "session" && args[1] === "list") {
  process.stdout.write(fs.existsSync(sessions) ? fs.readFileSync(sessions, "utf8") : "");
  process.exit(0);
}
if (args[0] === "session" && args[1] === "stop") {
  fs.appendFileSync(path.join(dir, "stopped.txt"), args[2] + "\\n");
  console.log("ok");
  process.exit(0);
}
const exec = args.indexOf("exec");
if (exec < 0 || exec !== args.length - 2) { console.log("error: unknown option '" + args[0] + "'"); process.exit(0); }
const prompt = args[exec + 1];
const handoff = /인계 문서 (\\S+)/.exec(prompt)[1];
const runId = /- runId: (\\S+)/.exec(fs.readFileSync(handoff, "utf8"))[1];
const id = () => "Sess" + Math.random().toString(36).slice(2, 12).padEnd(10, "x");
// Like Aside, the row title is the start of the prompt.
const row = (sid, title = prompt.slice(0, 50)) => sid + "  running  persistent  " + title + "  2026-11-25T09:10:00.000Z\\n";
const foreign = () => fs.appendFileSync(sessions, row(id(), "다른 작업"));
if (mode === "foreign-session" || mode === "hang-foreign") foreign();
if (mode !== "hang-foreign" && mode !== "retitled" && mode !== "split-session") {
  const mine = () => fs.appendFileSync(sessions, row(id()) + (mode === "two-sessions" ? row(id()) : ""));
  if (mode === "foreign-session") setTimeout(mine, 150);
  else mine();
}
// A helper in aside's process group; it writes child.pid once its SIGTERM handler is in place.
const grandchild = (stdio) => {
  const script = 'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 20000)';
  require("node:child_process").spawn(process.execPath, ["-e", script, path.join(dir, "child.pid")], { stdio });
};
const report = (extra) => "\`\`\`json\\n" + JSON.stringify(Object.assign({
  runId, accountVerified: true, accepted: 1, visited: 1, commented: 1, liked: 1,
  records: [{ postUrl: "https://blog.naver.com/example-blog/223000000001", action: "create", status: "posted" }],
  blocked: null,
}, extra)) + "\\n\`\`\`";
const out = (text) => { process.stdout.write("브라우저 작업 진행\\n" + text + "\\n"); process.exit(0); };
switch (mode) {
  case "ok": case "two-sessions": case "disconnected": out(report({})); break;
  case "unknown-option": process.stderr.write("error: unknown option '--permission'\\n"); out(report({})); break;
  case "no-json": out("완료했어요."); break;
  case "secret": out("Authorization: Bearer example-token-123\\n" + report({})); break;
  case "run-id-mismatch": out(report({ runId: "r_other" })); break;
  case "missing-record": out(report({ records: [{ postUrl: "https://m.blog.naver.com/example-blog/223000000999" }] })); break;
  case "captcha": out(report({ accepted: 0, visited: 0, commented: 0, liked: 0, records: [], accountVerified: false, blocked: { code: "captcha", detail: "보안 확인" } })); break;
  case "hang": case "hang-foreign": setInterval(() => {}, 1000); break;
  case "foreign-session": setTimeout(() => out(report({})), 400); break;
  // Like real Aside (2026-11-25): the model retitles the session, another session starts meanwhile,
  // the CLI announces the id in color, and the output echoes a file that quotes a CLI error phrase.
  case "retitled": {
    const sid = id();
    fs.appendFileSync(sessions, row(id(), "다른 작업") + row(sid, "blog-neighbor-loop 인계 작업 1회 수행"));
    fs.writeFileSync(path.join(dir, "announced.txt"), sid);
    process.stdout.write("\\x1b[33mWarning:\\x1b[0m Aside needs sign-in again for this account.\\n\\x1b[2mcreated new session: " + sid + "\\x1b[0m\\n");
    out("read_file > 폴더 접근이 거부되면(\`Operation not permitted\`) 접근 허용을 요청한다.\\n" + report({}));
    break;
  }
  // The session line reaches the app in two writes, split inside the id (a pipe boundary can do this).
  case "split-session": {
    const sid = id();
    fs.writeFileSync(path.join(dir, "announced.txt"), sid);
    process.stdout.write("created new session: " + sid.slice(0, -3));
    setTimeout(() => {
      process.stdout.write(sid.slice(-3) + "\\n" + report({}) + "\\n");
      process.exit(0);
    }, 60);
    break;
  }
  // aside dies on SIGTERM; a helper in its group ignores it and holds no pipe.
  case "child-ignores-term": grandchild("ignore"); setInterval(() => {}, 1000); break;
  // aside reports and exits 0; a helper that inherited stdout keeps the pipe open.
  case "exit-leaves-child": grandchild("inherit"); out(report({})); break;
  case "hang-ignore-term": process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); break;
  default: console.log("unknown fake mode"); process.exit(3);
}
`,
  );
  await chmod(file, 0o755);
  return file;
}

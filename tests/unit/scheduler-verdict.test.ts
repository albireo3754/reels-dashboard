import test from "node:test";
import assert from "node:assert/strict";
import { createdSessionId, judgeAsideRun, lastJsonBlock, type RecordFact, type VerdictInput } from "../../src/features/scheduler";

const day = "2026-11-25";
const url = "https://m.blog.naver.com/example-blog/223000000001";
const report = (extra: Record<string, unknown> = {}) => ({
  runId: "r_test",
  accountVerified: true,
  accepted: 1,
  visited: 1,
  commented: 1,
  liked: 1,
  records: [{ postUrl: "https://blog.naver.com/example-blog/223000000001", action: "create", status: "posted" }],
  blocked: null,
  ...extra,
});
const fenced = (value: unknown) => "작업 로그\n```json\n" + JSON.stringify(value) + "\n```\n";
const startedAt = "2026-11-25T09:10:30.000Z";
const written = "2026-11-25T09:20:00.000Z";
const fact = (extra: Partial<RecordFact> = {}): RecordFact => ({
  postedAt: day,
  note: `[${day} 루프] 수락함 / 답방 댓글 / 공감 확인`,
  status: "posted",
  updatedAt: written,
  ...extra,
});
const good = new Map<string, RecordFact>([[url, fact()]]);
const judge = (input: Partial<VerdictInput>) =>
  judgeAsideRun({ exitCode: 0, signal: null, stdout: fenced(report()), runId: "r_test", days: [day], startedAt, records: good, maxRecords: 5, ...input });

test("a valid report whose records match the app store is ok", () => {
  const verdict = judge({});
  assert.equal(verdict.status, "ok");
  assert.equal(verdict.matched, 1);
});

test("CLI errors count only before the session line: echoed files after it may quote them", () => {
  const session = "\x1b[2mcreated new session: Sess12345678\x1b[0m\n";
  const quoted = "read_file > 접근이 거부되면(`Operation not permitted`) 허용을 요청한다.\n";
  assert.equal(judge({ stdout: "Warning: signed out\n" + session + quoted + fenced(report()) }).status, "ok");
  assert.equal(judge({ stdout: "error: unknown option '--x'\n" + session + fenced(report()) }).reason, "cli-error");
  assert.equal(judge({ stdout: quoted + fenced(report()) }).reason, "cli-error", "without a session line the whole output counts");
  assert.equal(createdSessionId(session + "created new session: Other999999\n"), "Sess12345678");
  assert.equal(createdSessionId("본문에 created new session: X 라고 적힘"), undefined);
});

test("exit code 0 is not enough: CLI errors, no JSON, schema and run id fail", () => {
  assert.equal(judge({ exitCode: 1 }).reason, "exit");
  assert.equal(judge({ signal: "SIGTERM" }).reason, "exit");
  assert.equal(judge({ stdout: "error: unknown option '--permission'\n" + fenced(report()) }).reason, "cli-error");
  assert.equal(judge({ stdout: "Session not found\n" }).reason, "cli-error");
  assert.equal(judge({ stdout: "done, all good" }).reason, "no-result");
  assert.equal(judge({ stdout: "```json\n{broken\n```" }).reason, "schema");
  assert.equal(judge({ stdout: fenced({ ...report(), accepted: -1 }) }).reason, "schema");
  assert.equal(judge({ stdout: fenced(report({ runId: "r_other" })) }).reason, "run-id-mismatch");
  for (const stdout of ["Chrome extension not connected for the requested browser profile\n", "x"])
    assert.equal(judge({ stdout }).status, "failed");
});

test("a CLI error phrase quoted inside the JSON report does not fail the run", () => {
  const verdict = judge({ stdout: fenced(report({ notes: "earlier attempt said Operation not permitted; retried with reels" })) });
  assert.equal(verdict.status, "ok");
});

test("the last json block wins and unknown keys are ignored", () => {
  const stdout = fenced(report({ runId: "r_old" })) + "더 진행\n" + fenced(report({ extraKey: { anything: 1 } }));
  assert.equal(lastJsonBlock(stdout).json?.includes("r_test"), true);
  assert.equal(judge({ stdout }).status, "ok");
});

test("accountVerified other than true fails", () => {
  assert.equal(judge({ stdout: fenced(report({ accountVerified: false })) }).reason, "account-unverified");
});

test("blocked: partial after some work, failed with none; account-level codes pause", () => {
  const some = judge({ stdout: fenced(report({ blocked: { code: "errors", detail: "two errors in a row" } })) });
  assert.deepEqual([some.status, some.reason, some.pause], ["partial", "blocked:errors", undefined]);
  const none = judge({
    stdout: fenced(report({ accepted: 0, visited: 0, commented: 0, liked: 0, records: [], accountVerified: false, blocked: { code: "captcha" } })),
  });
  assert.deepEqual([none.status, none.reason, none.pause], ["failed", "blocked:captcha", "captcha"]);
  const restricted = judge({ stdout: fenced(report({ blocked: { code: "restricted", detail: "등록 제한" } })) });
  assert.deepEqual([restricted.status, restricted.pause], ["partial", "restricted"]);
});

test("records must exist with today's postedAt and the loop note; counts must agree", () => {
  assert.equal(judge({ records: new Map() }).reason, "record-mismatch");
  assert.equal(judge({ records: new Map([[url, fact({ postedAt: "2026-11-24" })]]) }).reason, "record-mismatch");
  assert.equal(judge({ records: new Map([[url, fact({ note: "수동 기록" })]]) }).reason, "record-mismatch");
  assert.equal(judge({ stdout: fenced(report({ commented: 2 })) }).reason, "count-mismatch");
  const many = Array.from({ length: 6 }, (_, i) => ({ postUrl: `https://m.blog.naver.com/example-blog/22300000000${i}` }));
  assert.equal(judge({ stdout: fenced(report({ records: many, commented: 6 })) }).reason, "over-limit");
  assert.equal(judge({ records: new Map([[url, fact({ note: "x" })]]), stdout: fenced(report({ records: [{ postUrl: "not a url" }] })) }).reason, "record-mismatch");
});

test("one app record confirms one post: the same post reported twice is partial", () => {
  const twice = [
    { postUrl: "https://blog.naver.com/example-blog/223000000001" },
    { postUrl: "https://m.blog.naver.com/example-blog/223000000001/" },
  ];
  const verdict = judge({ stdout: fenced(report({ records: twice, commented: 2 })) });
  assert.deepEqual([verdict.status, verdict.reason, verdict.matched], ["partial", "duplicate-record", 1]);
  assert.equal(judge({ stdout: fenced(report({ records: twice, commented: 1 })) }).status, "partial");
});

test("a draft record, or one not written during this run, does not confirm a comment", () => {
  assert.equal(judge({ records: new Map([[url, fact({ status: "draft" })]]) }).reason, "record-mismatch");
  assert.equal(judge({ records: new Map([[url, fact({ status: undefined })]]) }).reason, "record-mismatch");
  // Left by an earlier run the same day (maxRunsPerDay > 1): written before this run started.
  assert.equal(judge({ records: new Map([[url, fact({ updatedAt: "2026-11-25T01:00:00.000Z" })]]) }).reason, "record-mismatch");
  assert.equal(judge({ records: new Map([[url, fact({ updatedAt: undefined })]]) }).reason, "record-mismatch");
  for (const status of ["posted", "reciprocated", "no_reply", "neighbor"])
    assert.equal(judge({ records: new Map([[url, fact({ status })]]) }).status, "ok", status);
});

test("a run that crossed midnight passes with either the start or the end day", () => {
  const next = "2026-11-26";
  const facts = new Map([[url, fact({ postedAt: next, note: `[${next} 루프] 답방 댓글` })]]);
  assert.equal(judge({ days: [day, next], records: facts }).status, "ok");
  assert.equal(judge({ days: [day], records: facts }).reason, "record-mismatch");
});

test("no requests to handle is ok when the report is valid", () => {
  assert.equal(judge({ stdout: fenced(report({ accepted: 0, visited: 0, commented: 0, liked: 0, records: [] })) }).status, "ok");
});

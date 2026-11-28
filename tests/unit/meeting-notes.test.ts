import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { MeetingCreditGuard, meetingApiKey } from "../../src/desktop/meeting-credit";
import { MeetingNotes } from "../../src/desktop/meeting-notes";
import type { MeetingCredit, MeetingProvider } from "../../src/shared/meeting-notes";

const NOW = Date.parse("2026-11-22T10:00:00Z");
const iso = (t: number) => new Date(t).toISOString();
const keyEnv = { OPENAI_API_KEY: "sk-proj-fake-test", ANTHROPIC_API_KEY: "sk-ant-api03-fake-test", REELS_MEETING_API_ENABLED: "1" };
const snapshotName = "meeting-credit-observations.json";
const journalName = "meeting-credit-reservations.jsonl";
async function fixture<T>(fn: (root: string) => Promise<T>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meeting-test-"));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function snapshot(values: Record<string, unknown> = {}) {
  return {
    observedAt: iso(NOW - 1_000), expiresAt: iso(NOW + 25_000),
    totalUsd: 100, remainingUsd: 11, exclusiveSpend: true, ...values,
  };
}
function writeSnapshot(root: string, observations: unknown) {
  return writeFile(path.join(root, snapshotName), JSON.stringify(observations), { mode: 0o600 });
}
test("credits remain unknown when absent, stale, malformed or expired", async () => fixture(async root => {
  const guard = new MeetingCreditGuard(root, keyEnv, () => NOW);
  assert.deepEqual(await guard.credits(), ["openai", "claude"].map(provider => ({ provider, status: "unknown", enabled: false })));
  assert.equal(await guard.reserve("openai", .01), undefined);
  await writeSnapshot(root, { openai: snapshot({ observedAt: iso(NOW - 7 * 24 * 3600_000) }),
    claude: snapshot({ observedAt: iso(NOW - (8 * 24 + 1) * 3600_000) }) });
  const weeklyCheck = await guard.credits();
  assert.equal(weeklyCheck[0].status, "snapshot");
  assert.equal(weeklyCheck[1].status, "unknown");
  await writeSnapshot(root, { openai: snapshot({ expiresAt: iso(NOW) }),
    claude: snapshot({ observedAt: iso(NOW - (8 * 24 + 1) * 3600_000) }) });
  assert.ok((await guard.credits()).every(item => item.status === "unknown"));
  await writeFile(path.join(root, snapshotName), "{");
  assert.ok((await guard.credits()).every(item => item.status === "unknown"));
}));
test("fresh snapshot displays without enabling API when switch, exclusivity or credential missing", async () => fixture(async root => {
  await writeSnapshot(root, { openai: snapshot(), claude: snapshot({ exclusiveSpend: false }) });
  const off = new MeetingCreditGuard(root, { ...keyEnv, REELS_MEETING_API_ENABLED: "0" }, () => NOW);
  assert.ok((await off.credits()).every(item => item.status === "snapshot" && !item.enabled));
  const on = new MeetingCreditGuard(root, keyEnv, () => NOW);
  assert.deepEqual((await on.credits()).map(c => c.enabled), [true, false]);
  assert.equal(await on.reserve("claude", .01), undefined);
  const wrongOrg = new MeetingCreditGuard(root, { ...keyEnv, OPENAI_BASE_URL: "https://example.invalid/v1" }, () => NOW);
  assert.equal(await wrongOrg.reserve("openai", .01), undefined);
}));
test("reservations persist, serialize racing requests, and never consume the 10% floor", async () => fixture(async root => {
  await writeSnapshot(root, { openai: snapshot() });
  const guard = new MeetingCreditGuard(root, keyEnv, () => NOW);
  assert.equal(await guard.reserve("openai", 1), undefined, "ending at 10% is not allowed");
  const outcomes = await Promise.all([guard.reserve("openai", .6), guard.reserve("openai", .6)]);
  assert.deepEqual(outcomes, [keyEnv.OPENAI_API_KEY, undefined]);
  assert.equal((await guard.credits())[0].remainingUsd, 10.4);
  assert.equal((await guard.credits())[0].status, "estimated");
  assert.doesNotMatch(await readFile(path.join(root, journalName), "utf8"), /sk-proj|sk-ant/);
  const restarted = new MeetingCreditGuard(root, keyEnv, () => NOW);
  assert.equal(await restarted.reserve("openai", .4), undefined);
  await writeFile(path.join(root, journalName), "partial\n");
  assert.equal(await restarted.reserve("openai", .01), undefined);
}));
test("settlements replace conservative reservations with actual usage while keeping failed reservations", async () => fixture(async root => {
  await writeSnapshot(root, { openai: snapshot({ remainingUsd: 12 }), claude: snapshot({ remainingUsd: 12 }) });
  const guard = new MeetingCreditGuard(root, keyEnv, () => NOW);
  const service = new MeetingNotes(guard, {
    audio: async () => ({ bytes: new ArrayBuffer(32), seconds: 61 }),
    fetch: async url => {
      if (String(url).includes("transcriptions")) {
        return Response.json({ text: "전사", usage: { type: "duration", seconds: 61 } });
      }
      return Response.json({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "요약" }] }],
        usage: { input_tokens: 1_000, output_tokens: 500 },
      });
    },
  });
  // Transcribe reserves $0.012, settles to 61/60 * $0.0045 = $0.004575 -> ceil 4575 microUsd
  await service.transcribe("/local/audio.mp3", "");
  assert.equal((await guard.credits())[0].remainingUsd, 11.995425);
  // Summarize settles to (1000*0.4 + 500*1.6)/1e6 = $0.0012 -> 1200 microUsd
  await service.summarize(textInput);
  assert.equal((await guard.credits())[0].remainingUsd, 11.994225);
  // Failed request keeps its conservative reservation (no refund)
  const failing = new MeetingNotes(guard, { fetch: async () => new Response("err", { status: 500 }) });
  await assert.rejects(failing.summarize(textInput), /사용 가능한 API/);
  const afterFail = await guard.credits();
  assert.ok((afterFail[0].remainingUsd ?? 12) < 11.994225);
  assert.ok((afterFail[1].remainingUsd ?? 12) < 12);
}));
test("credential references require private non-symlink dotenv and reject proxy/OAuth keys", async () => fixture(async root => {
  const file = path.join(root, "private.env");
  const alias = path.join(root, "symlink.env");
  const env = (ref: string) => ({ REELS_MEETING_CREDENTIALS_FILE: ref });
  await writeFile(file, `OPENAI_API_KEY=${keyEnv.OPENAI_API_KEY}\nANTHROPIC_API_KEY=${keyEnv.ANTHROPIC_API_KEY}\n`,
    { mode: 0o600 });
  assert.equal(await meetingApiKey("openai", env(file)), keyEnv.OPENAI_API_KEY);
  assert.equal(await meetingApiKey("claude", env(file)), keyEnv.ANTHROPIC_API_KEY);
  const claudeConsoleKey = `sk-ant-${"a".repeat(99)}`;
  assert.equal(await meetingApiKey("claude", { ANTHROPIC_API_KEY: claudeConsoleKey }), claudeConsoleKey);
  const claudeAdminKey = `sk-ant-admin01-${"a".repeat(91)}`;
  assert.equal(await meetingApiKey("claude", { ANTHROPIC_API_KEY: claudeAdminKey }), undefined);
  await symlink(file, alias);
  assert.equal(await meetingApiKey("openai", env(alias)), undefined);
  assert.equal(await meetingApiKey("openai", env("private.env")), undefined);
  await chmod(file, 0o644);
  assert.equal(await meetingApiKey("openai", env(file)), undefined);
  assert.equal(await meetingApiKey("openai", { ...keyEnv, OPENAI_BASE_URL: "https://compatible.invalid/v1" }), undefined);
  assert.equal(await meetingApiKey("claude", { ...keyEnv, ANTHROPIC_API_KEY: "sk-ant-oat01-test" }), undefined);
}));
const textInput = { context: "기획 회의", transcript: "지민은 문서를 월요일에 맡았다.", allowCodexSession: false };
const makeCredit = (provider: MeetingProvider, enabled: boolean): MeetingCredit =>
  ({ provider, enabled, status: enabled ? "snapshot" : "unknown" });
test("context-only text requests use OpenAI before Claude, no tools or redirects", async () => {
  const calls: string[] = [];
  const meeting = new MeetingNotes({
    credits: async () => [], reserve: async provider => { calls.push(provider); return keyEnv.OPENAI_API_KEY; },
  }, { fetch: async (url, options) => {
    calls.push(String(url));
    assert.equal(options?.redirect, "error");
    const request = JSON.parse(String(options?.body));
    assert.equal(request.store, false);
    assert.equal(request.tools, undefined);
    assert.deepEqual(JSON.parse(request.input), { context: textInput.context, transcript: textInput.transcript });
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "회의록" }] }] });
  } });
  assert.deepEqual(await meeting.summarize(textInput), { provider: "openai", text: "회의록" });
  assert.deepEqual(calls, ["openai", "https://api.openai.com/v1/responses"]);
});
test("Claude text is second; a disabled API does not run and session fallback is opt-in", async () => {
  const calls: string[] = [];
  const meeting = new MeetingNotes({
    credits: async () => [], reserve: async provider => {
      calls.push(provider);
      return provider === "claude" ? keyEnv.ANTHROPIC_API_KEY : undefined;
    },
  }, { fetch: async (url, options) => {
    assert.equal(String(url), "https://api.anthropic.com/v1/messages");
    const request = JSON.parse(String(options?.body));
    assert.equal(request.tools, undefined);
    assert.deepEqual(JSON.parse(request.messages[0].content), { context: textInput.context, transcript: textInput.transcript });
    return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: "요약" }] });
  } });
  assert.equal((await meeting.summarize(textInput)).provider, "claude");
  assert.deepEqual(calls, ["openai", "claude"]);
  const disabled = new MeetingNotes({
    credits: async () => [], reserve: async () => undefined,
  }, { fetch: async () => assert.fail("disabled API called"), session: async () => "세션 답변" });
  await assert.rejects(disabled.summarize(textInput), /사용 가능한 API/);
  assert.deepEqual(await disabled.summarize({ ...textInput, allowCodexSession: true }), { provider: "codex-session", text: "세션 답변" });
});
test("raw audio is sent only to OpenAI after the duration-based reservation", async () => {
  const openai = new MeetingNotes({
    credits: async () => [makeCredit("openai", true)],
    reserve: async (provider, amount) => {
      assert.equal(provider, "openai");
      assert.equal(amount, .012);
      return keyEnv.OPENAI_API_KEY;
    },
  }, {
    audio: async () => ({ bytes: new ArrayBuffer(32), seconds: 61 }),
    fetch: async (endpoint, options) => {
      assert.equal(String(endpoint), "https://api.openai.com/v1/audio/transcriptions");
      const form = options?.body as FormData;
      assert.equal(form.get("model"), "gpt-transcribe");
      assert.equal(form.get("response_format"), "json");
      assert.equal(form.get("prompt"), "테스트 주제");
      assert.equal((form.get("file") as File).name, "meeting.m4a");
      return Response.json({ text: "전사", languages: [{ code: "ko" }], usage: { type: "duration", seconds: 61 } });
    },
  });
  assert.deepEqual(await openai.transcribe("/local/audio.mp3", "테스트 주제"), { provider: "openai", text: "전사" });
  const disabled = new MeetingNotes({
    credits: async () => [makeCredit("claude", true)], reserve: async () => assert.fail("must not reserve"),
  }, { audio: async () => assert.fail("must not read audio"), fetch: async () => assert.fail("must not send audio") });
  await assert.rejects(disabled.transcribe("/local/audio.mp3", ""), /크레딧을 확인/);
});

test("synthetic WAV converts to an anonymous audio upload against a local mock", async t => fixture(async root => {
  const run = promisify(execFile);
  try { await run("/opt/homebrew/bin/ffmpeg", ["-version"]); } catch { return t.skip("Homebrew FFmpeg unavailable"); }
  const wav = path.join(root, "private-file-name.wav");
  await run("/opt/homebrew/bin/ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=400:duration=1",
    "-metadata", "title=private-tag", wav]);
  const service = new MeetingNotes({
    credits: async () => [makeCredit("openai", true)], reserve: async () => keyEnv.OPENAI_API_KEY,
  }, { fetch: async (_, options) => {
    const file = (options?.body as FormData).get("file") as File;
    const bytes = Buffer.from(await file.arrayBuffer());
    assert.ok(bytes.length > 1_000);
    assert.equal(file.name, "meeting.m4a");
    assert.equal(bytes.includes("private-tag"), false);
    assert.equal(bytes.includes("private-file-name"), false);
    return Response.json({ text: "mock" });
  } });
  assert.equal((await service.transcribe(wav, "")).text, "mock");
}));

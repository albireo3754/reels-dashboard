import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { apiIntake } from "../src/api-intake.js";

const now = Date.parse("2026-11-22T10:00:00Z");
const iso = (diff: number) => new Date(now + diff).toISOString();
const raw = '{ "text": "합성 데이터 테스트.", "languages": [{"code":"ko"}] }';
const mockReview = JSON.stringify({ flags: [{ kind: "unclear", quote: "합성 데이터", reason: "맥락 확인 필요" }] });
async function fixture(run: (data: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await run(f); } finally { await rm(f.root, { recursive: true, force: true }); }
}
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "call-intake-test-"));
  const recording = path.join(root, "fixture.wav");
  await writeFile(recording, "synthetic test fixture", { mode: 0o600 });
  const credits = async (openai = 90, claude = 90, exclusiveSpend = true) => {
    const s = (remainingUsd: number) => ({ remainingUsd, totalUsd: 100, exclusiveSpend, observedAt: iso(-1000), expiresAt: iso(10_000) });
    await writeFile(path.join(root, "credit-observations.json"), JSON.stringify({ openai: s(openai), claude: s(claude) }), { mode: 0o600 });
  };
  await credits();
  const options = {
    now: () => now,
    env: { CALL_SHORTS_API_STATE_DIR: root, CALL_SHORTS_API_ENABLED: "1",
      OPENAI_API_KEY: "sk-proj-test-only", ANTHROPIC_API_KEY: "sk-ant-api-test-only" },
    prepare: async (file: string) => {
      assert.equal(await readFile(file, "utf8"), "synthetic test fixture");
      assert.notEqual(file, recording);
      return { bytes: new ArrayBuffer(8), seconds: 61 };
    },
  };
  return { root, recording, credits, options };
}
test("double opt-in and grant threshold fail closed without provider dispatch", async () => fixture(async ({ recording, credits, options }) => {
  const no = { ...options, fetch: async () => assert.fail("unexpected dispatch") };
  await assert.rejects(apiIntake(recording, false, no), /꺼져/);
  await assert.rejects(apiIntake(recording, true, { ...no, env: { ...options.env, OPENAI_BASE_URL: "https://example.invalid/v1" } }), /크레딧/);
  await credits(10.012, 90);
  await assert.rejects(apiIntake(recording, true, no), /10%/);
  await credits(90, 90, false);
  await assert.rejects(apiIntake(recording, true, no), /크레딧/);
}));
test("OpenAI transcribes, then Claude receives only text after OpenAI review rejection; no downstream artifacts or repeats", async () => fixture(async ({ recording, options }) => {
  const calls: string[] = [];
  const fake: typeof fetch = async (url, init) => {
    const target = String(url);
    calls.push(target);
    assert.equal(init?.redirect, "error");
    if (target.endsWith("transcriptions")) {
      const form = init?.body as FormData;
      assert.equal(form.get("model"), "gpt-transcribe");
      assert.equal(form.get("languages[]"), "ko");
      assert.equal((form.get("file") as File).name, "recording.m4a");
      return new Response(raw);
    }
    const body = JSON.parse(String(init?.body));
    const prompt = target.endsWith("responses") ? body.input : body.messages[0].content;
    assert.deepEqual(JSON.parse(prompt), { transcript: "합성 데이터 테스트." });
    assert.equal(body.tools, undefined);
    if (target.endsWith("responses")) {
      assert.equal(body.store, false);
      assert.equal(body.text.format.type, "json_schema");
      return new Response("unavailable", { status: 429 });
    }
    return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: mockReview }] });
  };
  const result = await apiIntake(recording, true, { ...options, fetch: fake });
  assert.equal(result.status, "needs-human-review");
  assert.equal(await readFile(result.rawFile, "utf8"), raw);
  const review = JSON.parse(await readFile(result.reviewFile, "utf8"));
  assert.equal(review.provider, "claude");
  assert.equal(review.flags[0].quote, "합성 데이터");
  assert.deepEqual((await readdir(path.dirname(result.rawFile))).sort(), ["asr.attempt", "review-claude.attempt",
    "review-openai.attempt", "transcript.raw.json", "transcript.review.json"]);
  assert.equal(calls.length, 3);
  assert.deepEqual(await apiIntake(recording, true, { ...options, fetch: fake }), result);
  assert.equal(calls.length, 3);
}));
test("saved raw resumes review without transcribing twice when credit was blocked", async () => fixture(async ({ recording, credits, options }) => {
  await credits(10.014, 0);
  const first: typeof fetch = async url => {
    assert.equal(String(url), "https://api.openai.com/v1/audio/transcriptions");
    return new Response(raw);
  };
  await assert.rejects(apiIntake(recording, true, { ...options, fetch: first }), /원문은 저장/);
  await credits(90, 90);
  const result = await apiIntake(recording, true, { ...options, fetch: async url => {
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: mockReview }] }] });
  } });
  assert.equal(await readFile(result.rawFile, "utf8"), raw);
}));
test("ambiguous transcription failure is never sent automatically again", async () => fixture(async ({ recording, options }) => {
  let count = 0;
  const configured = { ...options, fetch: async () => { count++; throw new Error("mock timeout"); } };
  await assert.rejects(apiIntake(recording, true, configured), /응답을 확인/);
  await assert.rejects(apiIntake(recording, true, configured), /이미 시도/);
  assert.equal(count, 1);
}));

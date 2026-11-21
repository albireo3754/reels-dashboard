import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { mockHooks, mockEpisode, normalizeEpisode } from "../src/scriptwriter.js";
import { redactEpisode, redactText } from "../src/redact.js";
import { validateEpisode } from "../src/episode.js";
import { deepCopy, fixtureEpisode, fixtureTranscript, makeConfig, makeProject } from "./helpers.js";
import { ScriptWriter } from "../src/scriptwriter.js";
import { BudgetGuard } from "../src/budget.js";
import { BudgetExceededError } from "../src/errors.js";
import { StateStore } from "../src/state.js";
import { NeedsHumanError } from "../src/errors.js";
import { saveTranscript } from "../src/transcribe.js";

test("mock hooks cover five psychological axes", () => {
  const hooks = mockHooks(fixtureTranscript());
  assert.match(hooks, /충격 인용/);
  assert.match(hooks, /공감/);
  assert.match(hooks, /의문/);
  assert.match(hooks, /숫자/);
  assert.match(hooks, /배신/);
  assert.match(hooks, /추천/);
});

test("mock episode is deterministic and valid", () => {
  const transcript = fixtureTranscript();
  const a = mockEpisode(transcript, { episodeId: "EP02", callDate: "2026-11-22" });
  const b = mockEpisode(transcript, { episodeId: "EP02", callDate: "2026-11-22" });
  assert.deepEqual(a, b);
  assert.deepEqual(validateEpisode(a, transcript), []);
});

test("normalize fixes speaker case, hashtags and target duration", () => {
  const episode = deepCopy(fixtureEpisode());
  // @ts-expect-error 소문자 화자를 일부러 넣습니다
  episode.cuts[0].speaker = "gf";
  episode.platformMeta.youtube.hashtags = ["커플", "#커플", "#썰", "#a", "#b", "#c"];
  const normalized = normalizeEpisode(episode);
  assert.equal(normalized.cuts[0].speaker, "GF");
  assert.equal(normalized.platformMeta.youtube.hashtags[0], "#커플");
  assert.equal(normalized.platformMeta.youtube.hashtags.length, 5);
  assert.equal(normalized.targetDurationSec, normalized.cuts.at(-1)!.tEnd);
});

test("normalize fills a missing source block", () => {
  const transcript = fixtureTranscript();
  const data = deepCopy(fixtureEpisode()) as unknown as Record<string, unknown>;
  delete data.source;
  delete data.targetDurationSec;
  const normalized = normalizeEpisode(data, transcript, { episodeId: "EP09", callDate: "2026-11-21" });
  assert.equal(normalized.source.durationSec, Number(transcript.durationSec.toFixed(2)));
  assert.equal(normalized.source.callDate, "2026-11-21");
  assert.equal(normalized.episodeId, "EP09");
});

test("redaction masks phone numbers and configured terms", () => {
  const episode = deepCopy(fixtureEpisode());
  episode.cuts[1].caption = "010-1234-5678로 와";
  episode.hook.text = "아무개회사 다니는 여친";
  const masked = redactEpisode(episode, ["아무개회사"]);
  assert.ok(!masked.episode.cuts[1].caption.includes("010-1234-5678"));
  assert.ok(masked.episode.cuts[1].caption.includes("[마스킹]"));
  assert.ok(!masked.episode.hook.text.includes("아무개회사"));
  assert.ok(masked.episode.redactions.length > 0);
  assert.ok(masked.hits.some((hit) => hit.includes("휴대전화")));
});

test("redaction masks email addresses", () => {
  const result = redactText("메일은 someone@example.com 입니다");
  assert.ok(!result.text.includes("someone@example.com"));
  assert.ok(result.hits.some((hit) => hit.includes("이메일")));
});

test("writer produces a valid episode from the dry-run mock", async () => {
  const config = makeConfig({ DRY_RUN: "1" });
  const transcript = fixtureTranscript();
  const project = makeProject(config.rootDir);
  saveTranscript(project, transcript);
  const writer = new ScriptWriter(config);
  await writer.plan(project, transcript);
  const episode = await writer.writeEpisode(project, transcript);
  assert.deepEqual(validateEpisode(episode, transcript), []);
  assert.match(readFileSync(path.join(project, "plan", "hooks.md"), "utf8"), /충격 인용/);
  assert.ok(readFileSync(path.join(project, "plan", "beats.json"), "utf8").includes("caption"));
});

test("writer regenerates once, then stops for a human", async () => {
  const config = makeConfig();
  const transcript = fixtureTranscript();
  const project = makeProject(config.rootDir);
  saveTranscript(project, transcript);
  const bad = deepCopy(fixtureEpisode(transcript));
  bad.cuts = bad.cuts.slice(0, 3);
  const payload = JSON.stringify(bad);
  const calls: string[] = [];
  const formatter = {
    name: "fake",
    async complete(): Promise<string> {
      calls.push("call");
      return payload;
    },
  };
  const planner = { name: "fake", async complete(): Promise<string> { return "| 훅 |"; } };
  const writer = new ScriptWriter(config, undefined, { planner, formatter });
  await writer.plan(project, transcript);
  await assert.rejects(() => writer.writeEpisode(project, transcript), NeedsHumanError);
  assert.equal(calls.length, 2, "최초 1회 + 재생성 1회여야 합니다");
  assert.match(readFileSync(path.join(project, "plan", "validation_errors.txt"), "utf8"), /cuts 개수/);
});

test("prefer transcript.edited.md when present", async () => {
  const config = makeConfig({ DRY_RUN: "1" });
  const transcript = fixtureTranscript();
  const project = makeProject(config.rootDir);
  saveTranscript(project, transcript);
  const prompts: string[] = [];
  const planner = {
    name: "fake",
    async complete(request: { prompt: string }): Promise<string> {
      prompts.push(request.prompt);
      return "| 훅 |";
    },
  };
  writeFileSync(path.join(project, "transcript", "transcript.edited.md"), "[00:01.0] 여자: 고친 대사\n");
  await new ScriptWriter(config, undefined, { planner }).plan(project, transcript);
  assert.match(prompts[0], /고친 대사/);
  assert.doesNotMatch(prompts[0], /여보세요/);
});

test("budget guard blocks excessive spend", () => {
  const config = makeConfig({ DAILY_BUDGET_USD: "1", MAX_IMAGE_USD: "0.2", MAX_EPISODE_USD: "1" });
  const store = new StateStore(config.stateFile);
  const guard = new BudgetGuard(config, store);
  store.addCost({ usd: 0.95, provider: "gemini", projectDir: "/p", stage: "illustrate" });
  assert.throws(() => guard.checkDaily(0.1), BudgetExceededError);
  assert.throws(() => guard.checkImage("/p", 0.1), BudgetExceededError);
  assert.throws(() => guard.checkEpisode("/p", 0.3), BudgetExceededError);
  assert.doesNotThrow(() => guard.checkEpisode("/p", 0.01));
});

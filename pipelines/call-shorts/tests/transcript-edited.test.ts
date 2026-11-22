import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { validateEpisode } from "../src/episode.js";
import { Pipeline } from "../src/runner.js";
import { mockEpisode, ScriptWriter } from "../src/scriptwriter.js";
import { loadPlanningTranscript, loadTranscript, saveTranscript, transcriptAsMarkdown } from "../src/transcribe.js";
import { makeConfig, makeDryConfig, makeProject } from "./helpers.js";

function editedMarkdown(transcript: ReturnType<typeof loadTranscript>): string {
  let first = true;
  return transcriptAsMarkdown(transcript)
    .split("\n")
    .map((line) => {
      if (!/^\[\d/.test(line)) return line.replace(/회사/g, "회식");
      if (first) {
        first = false;
        return line.replace(/^(\[\d{1,3}:\d{1,2}(?:\.\d+)?\]\s*[^:]+:\s*).*$/, "$1어제 그 카페 기억나?");
      }
      return line.replace(/회사/g, "회식");
    })
    .join("\n");
}

test("loadPlanningTranscript applies the edited utterance on the original timestamps", async () => {
  const { mockTranscript } = await import("../src/transcribe.js");
  const config = makeDryConfig();
  const project = makeProject(config.rootDir);
  const transcript = mockTranscript();
  saveTranscript(project, transcript);
  writeFileSync(path.join(project, "transcript", "transcript.edited.md"), editedMarkdown(transcript), "utf8");

  const planning = loadPlanningTranscript(project);
  assert.deepEqual(planning.segments.map((segment) => segment.start), transcript.segments.map((segment) => segment.start));
  assert.equal(planning.segments[0].text, "어제 그 카페 기억나?");
  assert.ok(!planning.segments.some((segment) => segment.text.includes("회사")));
  assert.ok(loadTranscript(project).segments.some((segment) => segment.text.includes("회사")), "원본 diarized.json 은 그대로");
});

test("the dry-run script is built and validated against the edited transcript", async () => {
  const { mockTranscript } = await import("../src/transcribe.js");
  const config = makeDryConfig();
  const project = makeProject(config.rootDir);
  const transcript = mockTranscript();
  saveTranscript(project, transcript);
  writeFileSync(path.join(project, "transcript", "transcript.edited.md"), editedMarkdown(transcript), "utf8");

  const planning = loadPlanningTranscript(project);
  const writer = new ScriptWriter(config);
  await writer.plan(project, planning);
  const episode = await writer.writeEpisode(project, planning);

  assert.deepEqual(validateEpisode(episode, planning), []);
  assert.match(episode.cuts[0].caption, /^어제 그 카페 기억나/);
  assert.ok(!episode.cuts.some((cut) => cut.caption.includes("회사")), JSON.stringify(episode.cuts.map((cut) => cut.caption)));
});

test("a script quoting the edited transcript is not rejected by the validator", async () => {
  const { mockTranscript } = await import("../src/transcribe.js");
  const config = makeConfig();
  const project = makeProject(config.rootDir);
  const transcript = mockTranscript();
  saveTranscript(project, transcript);
  writeFileSync(path.join(project, "transcript", "transcript.edited.md"), editedMarkdown(transcript), "utf8");

  const planning = loadPlanningTranscript(project);
  const payload = JSON.stringify(mockEpisode(planning, { episodeId: "EP01", callDate: "2026-11-22" }));
  const formatter = { name: "fake", async complete(): Promise<string> { return payload; } };
  const planner = { name: "fake", async complete(): Promise<string> { return "| 훅 |"; } };
  const writer = new ScriptWriter(config, undefined, { planner, formatter });
  await writer.plan(project, planning);
  const episode = await writer.writeEpisode(project, planning);

  assert.deepEqual(validateEpisode(episode, planning), []);
  assert.match(episode.cuts[0].caption, /^어제 그 카페 기억나/);
});

test("resume --stage plan reads the edited transcript end to end", async () => {
  const { mockTranscript } = await import("../src/transcribe.js");
  const config = makeDryConfig();
  const project = makeProject(config.rootDir);
  const transcript = mockTranscript();
  saveTranscript(project, transcript);
  writeFileSync(path.join(project, "transcript", "transcript.edited.md"), editedMarkdown(transcript), "utf8");

  const result = await new Pipeline(config, undefined, { executeRender: false, notifier: () => undefined }).resume(
    project,
    "plan",
    true,
  );
  assert.equal(result.status, "done", result.message);
  const episode = JSON.parse(readFileSync(path.join(project, "plan", "episode.json"), "utf8")) as {
    cuts: Array<{ caption: string }>;
  };
  assert.match(episode.cuts[0].caption, /^어제 그 카페 기억나/);
  assert.ok(!JSON.stringify(episode).includes("회사"));
});

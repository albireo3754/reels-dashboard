import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { validateEpisode } from "../src/episode.js";
import { Pipeline } from "../src/runner.js";
import { STAGES } from "../src/types.js";
import { loadTranscript } from "../src/transcribe.js";
import { makeDryConfig, writeFakeAudio } from "./helpers.js";

function pipeline(config = makeDryConfig()): Pipeline {
  return new Pipeline(config, undefined, { executeRender: false, notifier: () => undefined });
}

test("dry-run finishes all five stages", async () => {
  const config = makeDryConfig();
  const audio = writeFakeAudio(config.rootDir);
  const [result] = await pipeline(config).runOnce({ file: audio });

  assert.equal(result.status, "done", result.message);
  assert.match(path.basename(result.projectDir), /_EP01$/);
  for (const sub of ["audio", "transcript", "plan", "images", "render", "publish"]) {
    assert.ok(existsSync(path.join(result.projectDir, sub)), sub);
  }

  const transcript = loadTranscript(result.projectDir);
  assert.deepEqual(transcript.speakerMap, { SPEAKER_00: "GF", SPEAKER_01: "BF" });

  const episode = JSON.parse(readFileSync(path.join(result.projectDir, "plan", "episode.json"), "utf8"));
  assert.deepEqual(validateEpisode(episode, transcript), []);

  const images = readdirSync(path.join(result.projectDir, "images")).filter((name) => /^cut_\d+\.png$/.test(name));
  assert.equal(images.length, episode.cuts.length);
  assert.ok(existsSync(path.join(result.projectDir, "render", "captions.ass")));
  assert.ok(existsSync(path.join(result.projectDir, "render", "ffmpeg-plan.txt")));
  assert.ok(!existsSync(path.join(result.projectDir, "render", "short.mp4")));

  const meta = JSON.parse(readFileSync(path.join(result.projectDir, "publish", "meta.json"), "utf8"));
  assert.equal(meta.episodeId, "EP01");
  assert.equal(meta.aiDisclosure.youtube, false);
  assert.equal(meta.upload.automated, false);

  const checklist = readFileSync(path.join(result.projectDir, "publish", "checklist.md"), "utf8");
  assert.match(checklist, /업로드 체크리스트/);
  assert.match(checklist, /1분 초과/);

  const bundle = path.join(config.outboxDir, path.basename(result.projectDir));
  assert.ok(existsSync(path.join(bundle, "meta.json")));

  const store = new Pipeline(config).store;
  assert.deepEqual(store.stageMap(result.projectDir), Object.fromEntries(STAGES.map((stage) => [stage, "done"])));
});

test("the same file is skipped on a second run", async () => {
  const config = makeDryConfig();
  const audio = writeFakeAudio(config.rootDir);
  const first = await pipeline(config).runOnce({ file: audio });
  assert.equal(first[0].status, "done");
  const second = await pipeline(config).runOnce({ file: audio });
  assert.equal(second[0].status, "skipped");
  assert.match(second[0].message, /이미 처리한 통화/);
});

test("the source recording is preserved and archived", async () => {
  const config = makeDryConfig();
  const audio = writeFakeAudio(config.rootDir);
  const payload = readFileSync(audio);
  await pipeline(config).runOnce({ file: audio });
  assert.ok(existsSync(audio));
  assert.deepEqual(readFileSync(audio), payload);
  const archived = readdirSync(config.processedDir);
  assert.equal(archived.length, 1);
});

test("resume skips completed stages", async () => {
  const config = makeDryConfig();
  const audio = writeFakeAudio(config.rootDir);
  const [first] = await pipeline(config).runOnce({ file: audio });
  const resumed = await pipeline(config).resume(first.projectDir);
  assert.equal(resumed.status, "done");
  assert.ok(Object.values(resumed.stages).every((status) => status === "이미 완료"));
});

test("input with a json stderr does not crash the runner", async () => {
  const config = makeDryConfig();
  const audio = writeFakeAudio(config.rootDir);
  const [result] = await pipeline(config).runOnce({ file: audio });
  assert.equal(result.status, "done");
});

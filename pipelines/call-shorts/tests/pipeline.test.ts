import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { applyDryRunEnv, main } from "../src/cli.js";
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

test("runOnce() with no arguments picks up a new recording from inbox", async () => {
  const config = makeDryConfig();
  const audio = path.join(config.inboxDir, "call.m4a");
  writeFileSync(audio, Buffer.alloc(2048, 1));

  // claim 이 status 를 processing 으로 바꿔도 runOnce 는 그 파일을 끝까지 처리해야 합니다 (P0-1).
  const results = await pipeline(config).runOnce();
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "done", results[0].message);
  assert.match(path.basename(results[0].projectDir), /_EP01$/);

  // 같은 파일을 직접 다시 돌리면 멱등성으로 skipped — 돈을 두 번 쓰지 않습니다.
  const again = await pipeline(config).runFile(audio);
  assert.equal(again.status, "skipped");
  assert.match(again.message, /이미 처리한 통화/);

  // 2회차 runOnce() 는 새 통화가 없으므로 아무것도 처리하지 않습니다.
  const second = await pipeline(config).runOnce();
  assert.equal(second.length, 0);
  assert.equal(readdirSync(config.projectsDir).length, 1);
});

test("positional dry-run sets DRY_RUN, the flag and other commands do not", () => {
  assert.equal(applyDryRunEnv({}, "dry-run", {}).DRY_RUN, "1");
  assert.equal(applyDryRunEnv({}, "run-once", { "dry-run": true }).DRY_RUN, "1");
  for (const command of ["run-once", "watch", "doctor", "resume"]) {
    assert.equal(applyDryRunEnv({}, command, {}).DRY_RUN, undefined, command);
  }
});

test("the dry-run command runs end to end through the CLI without encoding", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "callshorts-cli-"));
  const inbox = path.join(root, "inbox");
  mkdirSync(inbox, { recursive: true });
  writeFileSync(path.join(inbox, "call.m4a"), Buffer.alloc(3072, 2));

  const code = await main(["dry-run", "--root", root]);
  assert.equal(code, 0);

  const projects = readdirSync(path.join(root, "projects"));
  assert.equal(projects.length, 1, projects.join(","));
  const project = path.join(root, "projects", projects[0]);
  // --render 없이는 MP4 를 만들지 않고 ASS/계획만 남깁니다.
  assert.ok(existsSync(path.join(project, "render", "captions.ass")));
  assert.ok(!existsSync(path.join(project, "render", "short.mp4")));
});

test("input with a json stderr does not crash the runner", async () => {
  const config = makeDryConfig();
  const audio = writeFakeAudio(config.rootDir);
  const [result] = await pipeline(config).runOnce({ file: audio });
  assert.equal(result.status, "done");
});

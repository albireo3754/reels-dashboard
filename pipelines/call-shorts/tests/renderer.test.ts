import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { renderDoodleCut } from "../src/doodle.js";
import { probeMedia, resolveFfmpeg, run } from "../src/media.js";
import { buildRenderCommand, measureLoudness, render, zoomExpression } from "../src/renderer.js";
import { writeSilenceWav } from "../src/transcribe.js";
import type { Episode } from "../src/types.js";
import { fixtureEpisode, makeConfig } from "./helpers.js";

// Keep full-size frames but encode fewer of them in the integration test.
const config = makeConfig({ RENDER_WIDTH: "1080", RENDER_HEIGHT: "1920", FPS: "5" });
const planConfig = { ...config, ffmpegBin: "ffmpeg" };
const episode = fixtureEpisode();

function projectFor(episode: Episode): string {
  const project = path.join(config.rootDir, "projects", "2026-11-22_EP01");
  for (const sub of ["audio", "transcript", "plan", "images", "render", "publish"]) {
    mkdirSync(path.join(project, sub), { recursive: true });
  }
  writeSilenceWav(path.join(project, "audio", "norm.wav"), 95);
  for (const cut of episode.cuts) {
    renderDoodleCut(path.join(project, "images", `cut_${String(cut.idx).padStart(2, "0")}.png`), cut.idx, {
      width: 360,
      height: 640,
    });
  }
  return project;
}

test("zoom expression reaches 104%", () => {
  assert.match(zoomExpression(4, 30), /1\.04/);
});

test("render command carries every required filter", () => {
  const project = projectFor(episode);
  const images = episode.cuts.map((cut) => path.join(project, "images", `cut_${String(cut.idx).padStart(2, "0")}.png`));
  const { command, graph, total } = buildRenderCommand(episode, planConfig, {
    audio: path.join(project, "audio", "norm.wav"),
    images,
  });
  assert.ok(command.includes("-filter_complex"));
  assert.match(graph, /zoompan/);
  assert.match(graph, /concat=n=/);
  assert.match(graph, /ass=filename=captions\.ass/);
  assert.match(graph, /loudnorm=I=-14/);
  assert.match(graph, /setsar=1/);
  assert.ok(command.includes("libx264"));
  assert.ok(command.includes("192k"));
  assert.ok(command.includes("+faststart"));
  assert.match(graph, new RegExp(`${config.renderWidth}x${config.renderHeight}`));
  assert.equal(command.at(-1), "short.mp4");
  assert.ok(total >= 25 && total <= 55);
});

test("command uses per-cut source ranges", () => {
  const project = projectFor(episode);
  const images = episode.cuts.map((cut) => path.join(project, "images", `cut_${String(cut.idx).padStart(2, "0")}.png`));
  const { command } = buildRenderCommand(episode, planConfig, { audio: path.join(project, "audio", "norm.wav"), images });
  assert.ok(command.includes("-ss"));
  assert.equal(command.filter((arg) => arg === "-ss").length, episode.cuts.length);
});

test("mismatched image count is rejected", () => {
  const project = projectFor(episode);
  const images = episode.cuts
    .slice(0, -1)
    .map((cut) => path.join(project, "images", `cut_${String(cut.idx).padStart(2, "0")}.png`));
  assert.throws(() =>
    buildRenderCommand(episode, planConfig, { audio: path.join(project, "audio", "norm.wav"), images }),
  );
});

test("plan-only render writes ASS/SRT/plan without encoding", () => {
  const project = projectFor(episode);
  const result = render(project, episode, planConfig, { execute: false });
  assert.equal(result.video, null);
  for (const file of [result.ass, result.srt, result.plan]) assert.ok(existsSync(file));
  const plan = readFileSync(result.plan, "utf8");
  assert.match(plan, /명령만 기록|dry-run/);
  assert.match(plan, /zoompan/);
});

test("render burns captions into the video and produces a vertical MP4 with audio and cover", (t) => {
  const ffmpeg = resolveFfmpeg(config);
  if (!ffmpeg || !/^\s*\S+\s+ass\s+V->V\s/m.test(run(ffmpeg, ["-hide_banner", "-filters"]).stdout)) {
    const reason = "ASS 자막 필터가 있는 FFmpeg가 필요합니다. FFMPEG_BIN으로 경로를 지정하세요.";
    if (config.ffmpegBin || process.env.CI === "true") assert.fail(reason);
    t.skip(reason);
    return;
  }
  const project = projectFor(episode);
  // A black first cut makes the subtitle pixels measurable without relying on a particular font.
  const firstImage = path.join(project, "images", `cut_${String(episode.cuts[0].idx).padStart(2, "0")}.png`);
  run(ffmpeg, ["-y", "-f", "lavfi", "-i", "color=black:s=360x640", "-frames:v", "1", firstImage]);
  const result = render(project, episode, config, { execute: true });
  assert.ok(result.video, `video 경로 없음 (duration=${result.duration})`);
  assert.ok(existsSync(result.video), `파일 없음: ${result.video}`);
  const info = probeMedia(result.video, config);
  assert.equal(info.width, config.renderWidth);
  assert.equal(info.height, config.renderHeight);
  assert.equal(info.hasAudio, true);
  assert.equal(info.fps, config.fps);
  assert.ok(info.durationSec !== null && Math.abs(info.durationSec - result.duration) <= 1 / config.fps,
    `Expected ${result.duration}s within one frame, got ${info.durationSec}s`);
  assert.ok(result.cover && existsSync(result.cover));

  const sample = run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-ss", "1", "-i", result.video,
    "-vf", "crop=iw/2:ih/5:iw/4:ih*0.66,signalstats,metadata=print:key=lavfi.signalstats.YMAX:file=-",
    "-frames:v", "1", "-an", "-f", "null", "-",
  ]);
  const peakLuma = Number(/lavfi\.signalstats\.YMAX=(\d+)/.exec(sample.stdout)?.[1]);
  assert.ok(peakLuma > 150, `Expected bright caption pixels on the black first cut, got YMAX=${peakLuma}`);

  const loudness = measureLoudness(result.video, config);
  assert.ok(typeof loudness.input_i === "number" && loudness.input_i < 0, JSON.stringify(loudness));
});

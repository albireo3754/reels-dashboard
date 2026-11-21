import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { renderDoodleCut } from "../src/doodle.js";
import { probeMedia, resolveFfmpeg } from "../src/media.js";
import { buildRenderCommand, measureLoudness, render, zoomExpression } from "../src/renderer.js";
import { writeSilenceWav } from "../src/transcribe.js";
import type { Episode } from "../src/types.js";
import { fixtureEpisode, makeConfig } from "./helpers.js";

const config = makeConfig();
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
  const { command, graph, total } = buildRenderCommand(episode, config, {
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
  const { command } = buildRenderCommand(episode, config, { audio: path.join(project, "audio", "norm.wav"), images });
  assert.ok(command.includes("-ss"));
  assert.equal(command.filter((arg) => arg === "-ss").length, episode.cuts.length);
});

test("mismatched image count is rejected", () => {
  const project = projectFor(episode);
  const images = episode.cuts
    .slice(0, -1)
    .map((cut) => path.join(project, "images", `cut_${String(cut.idx).padStart(2, "0")}.png`));
  assert.throws(() =>
    buildRenderCommand(episode, config, { audio: path.join(project, "audio", "norm.wav"), images }),
  );
});

test("plan-only render writes ASS/SRT/plan without encoding", () => {
  const project = projectFor(episode);
  const result = render(project, episode, config, { execute: false });
  assert.equal(result.video, null);
  for (const file of [result.ass, result.srt, result.plan]) assert.ok(existsSync(file));
  const plan = readFileSync(result.plan, "utf8");
  assert.match(plan, /명령만 기록|dry-run/);
  assert.match(plan, /zoompan/);
});

const hasFfmpeg = Boolean(resolveFfmpeg(config));

test("render produces a 1080x1920 mp4 (ffmpeg 필요)", { skip: !hasFfmpeg }, () => {
  const project = projectFor(episode);
  const result = render(project, episode, config, { execute: true });
  assert.ok(result.video, `video 경로 없음 (duration=${result.duration})`);
  assert.ok(existsSync(result.video), `파일 없음: ${result.video}`);
  const info = probeMedia(result.video!, config);
  assert.equal(info.width, config.renderWidth);
  assert.equal(info.height, config.renderHeight);
  assert.equal(info.hasAudio, true);
  assert.ok((info.durationSec ?? 0) >= 24 && (info.durationSec ?? 0) <= 56);
  assert.ok(result.cover && existsSync(result.cover));

  const loudness = measureLoudness(result.video!, config);
  assert.ok(typeof loudness.input_i === "number" && loudness.input_i < 0, JSON.stringify(loudness));
});

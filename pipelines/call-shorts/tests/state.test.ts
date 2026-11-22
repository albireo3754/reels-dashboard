import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { StateStore, localDay } from "../src/state.js";

function store(): StateStore {
  const dir = mkdtempSync(path.join(tmpdir(), "callshorts-state-"));
  return new StateStore(path.join(dir, "state", "pipeline-state.json"));
}

test("claim is atomic and idempotent", () => {
  const state = store();
  assert.equal(state.claimFile("abc", "/tmp/a.m4a", 10), true);
  assert.equal(state.claimFile("abc", "/tmp/a.m4a", 10), false);
  assert.equal(state.getFile("abc")?.status, "processing");
  assert.equal(state.hasHash("nope"), false);
});

test("status and project path persist", () => {
  const state = store();
  state.claimFile("h1", "/tmp/a.m4a", 5);
  state.setFileStatus("h1", "done", { projectDir: "/tmp/proj" });
  assert.equal(state.getFile("h1")?.status, "done");
  assert.equal(state.getFile("h1")?.projectDir, "/tmp/proj");
});

test("stage lifecycle", () => {
  const state = store();
  const project = "/tmp/2026-11-22_EP01";
  state.startStage(project, "transcribe");
  assert.equal(state.stageStatus(project, "transcribe"), "running");
  state.finishStage(project, "transcribe", "done");
  assert.equal(state.stageStatus(project, "transcribe"), "done");
  assert.deepEqual(state.stageMap(project), { transcribe: "done" });
});

test("costs accumulate per project, stage, day and provider", () => {
  const state = store();
  state.addCost({ usd: 0.1, provider: "gemini", projectDir: "/p1", stage: "illustrate" });
  state.addCost({ usd: 0.05, provider: "anthropic", projectDir: "/p1", stage: "plan" });
  state.addCost({ usd: 0.02, provider: "openai", projectDir: "/p2", stage: "plan", day: "2000-01-01" });

  assert.equal(Number(state.projectCost("/p1").toFixed(4)), 0.15);
  assert.equal(Number(state.projectStageCost("/p1", "illustrate").toFixed(4)), 0.1);
  assert.equal(Number(state.costOnDay(localDay()).toFixed(4)), 0.15);
  assert.equal(Number(state.costOnDay("2000-01-01").toFixed(4)), 0.02);
  assert.equal(state.costByDay()[0].day, localDay());
  assert.ok(state.costByProvider().some((row) => row.provider === "gemini"));
});

test("episode counter increments and can be reset", () => {
  const state = store();
  assert.equal(state.nextEpisodeNumber(), 1);
  assert.equal(state.nextEpisodeNumber(), 2);
  assert.equal(state.counter(), 2);
  state.setCounter(10);
  assert.equal(state.nextEpisodeNumber(), 11);
});

test("speaker map roundtrip", () => {
  const state = store();
  state.saveSpeakerMap("/p1", { SPEAKER_00: "GF", SPEAKER_01: "BF" }, "human");
  assert.deepEqual(state.loadSpeakerMap("/p1")?.map, { SPEAKER_00: "GF", SPEAKER_01: "BF" });
  assert.equal(state.loadSpeakerMap("/p1")?.confidence, "human");
  assert.equal(state.loadSpeakerMap("/missing"), null);
});

test("summary shape", () => {
  const state = store();
  state.claimFile("h", "/tmp/a.m4a", 5);
  state.addCost({ usd: 0.25, provider: "gemini", projectDir: "/p1", stage: "illustrate" });
  const summary = state.summary();
  assert.deepEqual(summary.files, { processing: 1 });
  assert.equal(summary.costTodayUsd, 0.25);
  assert.ok(summary.stateFile.endsWith("pipeline-state.json"));
});

test("a second store on the same file sees earlier rows", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "callshorts-state-"));
  const file = path.join(dir, "state.json");
  new StateStore(file).claimFile("keep", "/tmp/a.m4a", 1);
  assert.equal(new StateStore(file).hasHash("keep"), true);
});

/** 테스트 공용 헬퍼 — 임시 루트에서 실제 파일을 만듭니다. */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ensureDirs, loadConfig, type Config } from "../src/config.js";
import { mockEpisode } from "../src/scriptwriter.js";
import { mockTranscript } from "../src/transcribe.js";
import type { Episode, Transcript } from "../src/types.js";

export function makeConfig(env: Record<string, string> = {}, overrides: Partial<Config> = {}): Config {
  const root = mkdtempSync(path.join(tmpdir(), "callshorts-"));
  const config = loadConfig({
    env: {
      ...(process.env as Record<string, string>),
      PIPELINE_ROOT: root,
      STABLE_SECONDS: "0",
      POLL_INTERVAL_SEC: "1",
      TRANSCRIBE_BACKEND: "mock",
      IMAGE_PROVIDER: "mock",
      AUTO_ACCEPT_SPEAKER_MAP: "true",
      DAILY_BUDGET_USD: "5",
      MAX_IMAGE_USD: "5",
      MAX_EPISODE_USD: "5",
      X264_PRESET: "ultrafast",
      X264_CRF: "28",
      ...env,
    },
    useDotenv: false,
    overrides,
  });
  ensureDirs(config);
  return config;
}

export function makeDryConfig(env: Record<string, string> = {}): Config {
  return makeConfig({ DRY_RUN: "1", ...env });
}

export function makeProject(root: string, name = "2026-11-22_EP01"): string {
  const project = path.join(root, "projects", name);
  for (const sub of ["audio", "transcript", "plan", "images", "render", "publish"]) {
    mkdirSync(path.join(project, sub), { recursive: true });
  }
  return project;
}

export function writeFakeAudio(root: string): string {
  const file = path.join(root, "call.m4a");
  writeFileSync(file, Buffer.alloc(4096));
  return file;
}

export function fixtureTranscript(): Transcript {
  return mockTranscript();
}

export function fixtureEpisode(transcript: Transcript = fixtureTranscript()): Episode {
  return mockEpisode(transcript, { episodeId: "EP01", callDate: "2026-11-22" });
}

export function deepCopy<T>(value: T): T {
  return structuredClone(value);
}

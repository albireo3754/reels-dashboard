/**
 * 여친 탐구생활 — 통화 녹음 → 손그림 9:16 숏폼 파이프라인 (TypeScript).
 *
 * 공용 타입: 전사문, episode.json, 렌더 결과, 실행 결과.
 */

export type SpeakerRole = "GF" | "BF";

export interface Word {
  w: string;
  start: number;
  end: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  speaker: string;
  text: string;
  words: Word[];
}

export interface Transcript {
  language: string;
  durationSec: number;
  backend: string;
  model: string | null;
  diarized: boolean;
  speakerMap: Record<string, SpeakerRole>;
  segments: TranscriptSegment[];
}

export interface CutVisual {
  scene: string;
  emotion: string;
  props: string[];
  action?: string;
}

export interface CutCamera {
  zoom: string;
  rotateDeg: number;
}

export interface EpisodeCut {
  idx: number;
  tStart: number;
  tEnd: number;
  sourceRange: [number, number];
  speaker: SpeakerRole;
  caption: string;
  bubble: string | null;
  visual: CutVisual;
  sfx: string | null;
  camera: CutCamera;
}

export interface PlatformMeta {
  title: string;
  caption: string;
  hashtags: string[];
}

export interface Episode {
  episodeId: string;
  source: { audio: string; durationSec: number; callDate: string };
  format: string;
  targetDurationSec: number;
  hook: { text: string; type: string; firstFrame: string };
  cuts: EpisodeCut[];
  punchline: { text: string; t: number };
  loop: { lastLine: string; connectsToCut: number };
  redactions: string[];
  aiDisclosure: {
    youtube: boolean;
    instagram: boolean;
    tiktok: boolean;
    reason: string;
  };
  platformMeta: Record<"youtube" | "instagram" | "tiktok", PlatformMeta>;
}

export interface MediaInfo {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
}

export interface ProjectMeta {
  episodeId: string;
  sourcePath: string;
  sha256: string;
  sourceSize: number;
  callDate: string;
  createdAt: string;
  updatedAt?: string;
  status: string;
  statusDetail?: string;
  audio: string;
  stages?: Record<string, string>;
}

export type RunStatus = "done" | "needs_review" | "blocked" | "failed" | "skipped";

export interface RunResult {
  projectDir: string;
  episodeId: string;
  status: RunStatus;
  message: string;
  stages: Record<string, string>;
  video: string | null;
  cover: string | null;
  meta: string | null;
}

export type Stage = "transcribe" | "plan" | "illustrate" | "render" | "publish";

export const STAGES: Stage[] = ["transcribe", "plan", "illustrate", "render", "publish"];

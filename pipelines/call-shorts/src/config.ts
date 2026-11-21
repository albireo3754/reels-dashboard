/**
 * 설정 — 환경변수와 `.env`를 읽어 하나의 Config로 모읍니다.
 *
 * 기본 경로(맥): ~/Library/Mobile Documents/com~apple~CloudDocs/여친탐구생활/
 *   inbox/  processed/  failed/  projects/  outbox/  state/  logs/  assets/{characters,sfx,bgm}/
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export class ConfigError extends Error {
  readonly exitCode = 2;
}

export const DEFAULT_ROOT = path.join(
  homedir(),
  "Library",
  "Mobile Documents",
  "com~apple~CloudDocs",
  "여친탐구생활",
);

export const DEFAULT_EXTENSIONS = [
  ".m4a",
  ".wav",
  ".mp3",
  ".flac",
  ".aac",
  ".caf",
  ".ogg",
  ".opus",
  ".mp4",
  ".mov",
];

export const TRANSCRIBE_BACKENDS = ["auto", "whisperx", "whisper", "gemini", "mock"] as const;
export const IMAGE_PROVIDERS = ["gemini", "openai", "mock"] as const;
export type TranscribeBackendName = (typeof TRANSCRIBE_BACKENDS)[number];
export type ImageProviderName = (typeof IMAGE_PROVIDERS)[number];

export interface Config {
  rootDir: string;
  inboxDir: string;
  processedDir: string;
  failedDir: string;
  projectsDir: string;
  outboxDir: string;
  stateFile: string;
  logsDir: string;
  assetsDir: string;
  characterSheetDir: string;
  sfxDir: string;
  fontsDir: string | null;
  bgmPath: string | null;

  anthropicApiKey: string | null;
  openaiApiKey: string | null;
  geminiApiKey: string | null;

  claudeModel: string;
  gptModel: string;
  imageModel: string;
  imageModelFallback: string | null;
  geminiAudioModel: string;
  transcribeBackend: TranscribeBackendName;
  transcribeModel: string;
  imageProvider: ImageProviderName;

  dailyBudgetUsd: number;
  maxImageUsd: number;
  maxEpisodeUsd: number;
  imagePriceUsd: number;

  stableSeconds: number;
  pollIntervalSec: number;
  archiveMode: "copy" | "move";
  allowedExtensions: string[];

  autoAcceptSpeakerMap: boolean;

  subtitleFont: string;
  hookFont: string;
  colorGirl: string;
  colorBoy: string;
  renderWidth: number;
  renderHeight: number;
  fps: number;
  coverTimeSec: number;
  x264Preset: string;
  x264Crf: number;
  ffmpegBin: string | null;
  ffprobeBin: string | null;

  redactionTerms: string[];
  logLevel: string;
  dryRun: boolean;
  tz: string;
}

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && "\"'".includes(value[0])) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function readDotenv(file: string): Record<string, string> {
  try {
    return existsSync(file) ? parseDotenv(readFileSync(file, "utf8")) : {};
  } catch {
    return {};
  }
}

function pick(env: Record<string, string | undefined>, name: string): string | null {
  const value = env[name];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function str(env: Record<string, string | undefined>, name: string, fallback: string): string {
  return pick(env, name) ?? fallback;
}

function num(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const value = pick(env, name);
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ConfigError(`${name}은(는) 숫자여야 합니다: ${value}`);
  return parsed;
}

function int(env: Record<string, string | undefined>, name: string, fallback: number): number {
  return Math.trunc(num(env, name, fallback));
}

function bool(env: Record<string, string | undefined>, name: string, fallback: boolean): boolean {
  const value = pick(env, name);
  if (value === null) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

function list(env: Record<string, string | undefined>, name: string, fallback: string[]): string[] {
  const value = pick(env, name);
  if (value === null) return [...fallback];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function choice<T extends string>(
  env: Record<string, string | undefined>,
  name: string,
  fallback: T,
  allowed: readonly T[],
): T {
  const value = (pick(env, name) ?? fallback).toLowerCase() as T;
  if (!allowed.includes(value)) {
    throw new ConfigError(`${name}은(는) ${allowed.join(" | ")} 중 하나여야 합니다: ${value}`);
  }
  return value;
}

export interface ConfigOptions {
  env?: Record<string, string | undefined>;
  useDotenv?: boolean;
  dotenvPath?: string;
  overrides?: Partial<Config>;
}

export function loadConfig(options: ConfigOptions = {}): Config {
  const env: Record<string, string | undefined> = { ...(options.env ?? process.env) };
  if (options.useDotenv !== false) {
    const dotenvPath = options.dotenvPath ?? path.join(MODULE_DIR, "..", ".env");
    for (const [key, value] of Object.entries(readDotenv(dotenvPath))) {
      if (env[key] === undefined) env[key] = value;
    }
  }

  const root = pick(env, "PIPELINE_ROOT") ?? DEFAULT_ROOT;
  const assets = path.join(root, "assets");

  const config: Config = {
    rootDir: root,
    inboxDir: pick(env, "INBOX_DIR") ?? path.join(root, "inbox"),
    processedDir: pick(env, "PROCESSED_DIR") ?? path.join(root, "processed"),
    failedDir: pick(env, "FAILED_DIR") ?? path.join(root, "failed"),
    projectsDir: pick(env, "PROJECTS_DIR") ?? path.join(root, "projects"),
    outboxDir: pick(env, "OUTBOX_DIR") ?? path.join(root, "outbox"),
    stateFile: pick(env, "STATE_FILE") ?? path.join(root, "state", "pipeline-state.json"),
    logsDir: pick(env, "LOGS_DIR") ?? path.join(root, "logs"),
    assetsDir: assets,
    characterSheetDir: pick(env, "CHARACTER_SHEET_DIR") ?? path.join(assets, "characters"),
    sfxDir: pick(env, "SFX_DIR") ?? path.join(assets, "sfx"),
    fontsDir: pick(env, "FONTS_DIR"),
    bgmPath: pick(env, "BGM_PATH") ?? path.join(assets, "bgm", "bgm.m4a"),

    anthropicApiKey: pick(env, "ANTHROPIC_API_KEY"),
    openaiApiKey: pick(env, "OPENAI_API_KEY"),
    geminiApiKey: pick(env, "GEMINI_API_KEY"),

    claudeModel: str(env, "CLAUDE_MODEL", "claude-sonnet-4-5"),
    gptModel: str(env, "GPT_MODEL", "gpt-5"),
    imageModel: str(env, "IMAGE_MODEL", "gemini-3-pro-image-preview"),
    imageModelFallback: pick(env, "IMAGE_MODEL_FALLBACK") ?? "gpt-image-1",
    geminiAudioModel: str(env, "GEMINI_AUDIO_MODEL", "gemini-2.5-flash"),
    transcribeBackend: choice(env, "TRANSCRIBE_BACKEND", "auto", TRANSCRIBE_BACKENDS),
    transcribeModel: str(env, "TRANSCRIBE_MODEL", "large-v3"),
    imageProvider: choice(env, "IMAGE_PROVIDER", "gemini", IMAGE_PROVIDERS),

    dailyBudgetUsd: num(env, "DAILY_BUDGET_USD", 2.0),
    maxImageUsd: num(env, "MAX_IMAGE_USD", 1.5),
    maxEpisodeUsd: num(env, "MAX_EPISODE_USD", 2.5),
    imagePriceUsd: num(env, "IMAGE_PRICE_USD", 0.134),

    stableSeconds: num(env, "STABLE_SECONDS", 20),
    pollIntervalSec: num(env, "POLL_INTERVAL_SEC", 30),
    archiveMode: choice(env, "ARCHIVE_MODE", "copy", ["copy", "move"] as const),
    allowedExtensions: list(env, "ALLOWED_EXTENSIONS", DEFAULT_EXTENSIONS).map((ext) => ext.toLowerCase()),

    autoAcceptSpeakerMap: bool(env, "AUTO_ACCEPT_SPEAKER_MAP", false),

    subtitleFont: str(env, "SUBTITLE_FONT", "Pretendard"),
    hookFont: str(env, "HOOK_FONT", "Noto Sans KR"),
    colorGirl: str(env, "COLOR_GIRL", "#FF6B9D"),
    colorBoy: str(env, "COLOR_BOY", "#4FC3F7"),
    renderWidth: int(env, "RENDER_WIDTH", 1080),
    renderHeight: int(env, "RENDER_HEIGHT", 1920),
    fps: int(env, "FPS", 30),
    coverTimeSec: num(env, "COVER_TIME_SEC", 0.6),
    x264Preset: str(env, "X264_PRESET", "slow"),
    x264Crf: int(env, "X264_CRF", 18),
    ffmpegBin: pick(env, "FFMPEG_BIN"),
    ffprobeBin: pick(env, "FFPROBE_BIN"),

    redactionTerms: list(env, "REDACTION_TERMS", []),
    logLevel: str(env, "LOG_LEVEL", "INFO").toUpperCase(),
    dryRun: bool(env, "DRY_RUN", false),
    tz: str(env, "TZ_NAME", "Asia/Seoul"),
  };

  return { ...config, ...(options.overrides ?? {}) };
}

export function ensureDirs(config: Config): string[] {
  const wanted = [
    config.rootDir,
    config.inboxDir,
    config.processedDir,
    config.failedDir,
    config.projectsDir,
    config.outboxDir,
    config.logsDir,
    path.dirname(config.stateFile),
    config.assetsDir,
    config.characterSheetDir,
    config.sfxDir,
  ];
  const created: string[] = [];
  for (const dir of wanted) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created.push(dir);
    }
  }
  return created;
}

export function episodeIdFor(number: number): string {
  return `EP${String(Math.trunc(number)).padStart(2, "0")}`;
}

export function projectDirFor(config: Config, callDate: string, number: number): string {
  return path.join(config.projectsDir, `${callDate}_${episodeIdFor(number)}`);
}

export function projectSubdirs(): string[] {
  return ["audio", "transcript", "plan", "images", "render", "publish"];
}

export function maskedConfig(config: Config): string {
  const keys = [
    `anthropic=${config.anthropicApiKey ? "set" : "missing"}`,
    `openai=${config.openaiApiKey ? "set" : "missing"}`,
    `gemini=${config.geminiApiKey ? "set" : "missing"}`,
  ].join(" ");
  return `root=${config.rootDir} backend=${config.transcribeBackend} image=${config.imageProvider} budget/day=$${config.dailyBudgetUsd} keys[${keys}] dryRun=${config.dryRun}`;
}

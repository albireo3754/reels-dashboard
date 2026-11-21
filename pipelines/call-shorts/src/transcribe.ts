/**
 * Step 1 — 오디오 정규화 + 화자 2인 분리 전사.
 *
 * 기본: ffmpeg 정규화(mono 16k, highpass 80, loudnorm -16) → whisperx large-v3 + pyannote
 * 대체: whisper CLI(화자분리 없음) · Gemini Audio(유료·외부 전송) · mock(dry-run)
 *
 * 화자 라벨은 자동으로 누가 여자인지 알 수 없습니다. 매핑이 없으면 멈추고 한 번만 물어봅니다.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Config } from "./config.js";
import { ConfigError, NeedsHumanError, TranscribeError } from "./errors.js";
import { requireFfmpeg, run, which } from "./media.js";
import type { StateStore } from "./state.js";
import type { SpeakerRole, Transcript, TranscriptSegment } from "./types.js";

export const ROLE_NAMES: Record<string, string> = { GF: "여자", BF: "남자" };

export function mmss(seconds: number): string {
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(1).padStart(4, "0")}`;
}

// ──────────────────────────────────────────────────────────────
// 저장/읽기
// ──────────────────────────────────────────────────────────────
export function transcriptPath(projectDir: string): string {
  return path.join(projectDir, "transcript", "diarized.json");
}

export function speakersPath(projectDir: string): string {
  return path.join(projectDir, "transcript", "speakers.json");
}

export function saveTranscript(projectDir: string, transcript: Transcript): string {
  const file = transcriptPath(projectDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(transcript, null, 2), "utf8");
  return file;
}

export function loadTranscript(projectDir: string): Transcript {
  const file = transcriptPath(projectDir);
  if (!existsSync(file)) throw new TranscribeError(`전사문이 없습니다: ${file}`);
  return JSON.parse(readFileSync(file, "utf8")) as Transcript;
}

export function saveSpeakerMap(projectDir: string, map: Record<string, string>, confidence = "human"): string {
  const file = speakersPath(projectDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ map, confidence }, null, 2), "utf8");
  return file;
}

export function loadSpeakerMap(projectDir: string): { map?: Record<string, string>; confidence?: string } | null {
  const file = speakersPath(projectDir);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as { map?: Record<string, string>; confidence?: string };
  } catch {
    return null;
  }
}

export function editedTranscriptPath(projectDir: string): string {
  return path.join(projectDir, "transcript", "transcript.edited.md");
}

/** 사람이 고친 전사문이 있으면 그것을, 없으면 원본을 씁니다. */
export function planningText(projectDir: string): string {
  const edited = editedTranscriptPath(projectDir);
  if (existsSync(edited)) {
    const content = readFileSync(edited, "utf8");
    if (content.trim()) return content;
  }
  const markdown = path.join(projectDir, "transcript", "transcript.md");
  if (existsSync(markdown)) return readFileSync(markdown, "utf8");
  return transcriptAsMarkdown(loadTranscript(projectDir));
}

// ──────────────────────────────────────────────────────────────
// 전사문 → 마크다운
// ──────────────────────────────────────────────────────────────
export function transcriptAsMarkdown(transcript: Transcript): string {
  const lines = [
    `# 통화 전사문 (${transcript.language}, ${transcript.durationSec.toFixed(1)}초, ${transcript.backend})`,
    "",
    "> 형식: `[MM:SS.s] 화자: 문장`. 고칠 것이 있으면 이 파일을 `transcript.edited.md`로 복사해 수정하세요.",
    "",
  ];
  for (const segment of transcript.segments) {
    const role = transcript.speakerMap[segment.speaker] ?? segment.speaker;
    lines.push(`[${mmss(segment.start)}] ${ROLE_NAMES[role] ?? role}: ${segment.text}`);
  }
  return lines.join("\n").trimEnd() + "\n";
}

export function transcriptAsPlainText(transcript: Transcript): string {
  return transcript.segments
    .map((segment) => {
      const role = transcript.speakerMap[segment.speaker] ?? segment.speaker;
      return `[${mmss(segment.start)}] ${ROLE_NAMES[role] ?? role}: ${segment.text}`;
    })
    .join("\n");
}

export function rawSpeakers(transcript: Transcript): string[] {
  const seen: string[] = [];
  for (const segment of transcript.segments) {
    if (!seen.includes(segment.speaker)) seen.push(segment.speaker);
  }
  return seen;
}

/** sourceRange에 가장 많이 겹치는 해당 화자 발화. */
export function segmentAt(
  transcript: Transcript,
  start: number,
  end: number,
  role?: SpeakerRole,
): TranscriptSegment | null {
  let best: TranscriptSegment | null = null;
  let bestOverlap = 0;
  for (const segment of transcript.segments) {
    const segmentRole = transcript.speakerMap[segment.speaker] ?? segment.speaker;
    if (role && segmentRole !== role) continue;
    const overlap = Math.min(end, segment.end) - Math.max(start, segment.start);
    if (overlap > bestOverlap) {
      best = segment;
      bestOverlap = overlap;
    }
  }
  return best;
}

// ──────────────────────────────────────────────────────────────
// ffmpeg 정규화 / 무음 트랙
// ──────────────────────────────────────────────────────────────
export function normalizeCommand(ffmpeg: string, src: string, dest: string): string[] {
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    src,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-af",
    "highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11",
    dest,
  ];
}

export function normalizeAudio(src: string, dest: string, config: Config): string {
  mkdirSync(path.dirname(dest), { recursive: true });
  run(requireFfmpeg(config), normalizeCommand(requireFfmpeg(config), src, dest), { timeoutMs: 3_600_000 });
  if (!existsSync(dest)) throw new TranscribeError(`오디오 정규화 결과가 없습니다: ${dest}`);
  return dest;
}

/** dry-run용 자리표시 WAV — 들리지 않을 만큼 작은 220Hz 톤(라우드니스 측정·검수용). */
export function writeSilenceWav(file: string, durationSec: number, sampleRate = 16_000): string {
  mkdirSync(path.dirname(file), { recursive: true });
  const frames = Math.max(1, Math.trunc(durationSec * sampleRate));
  const dataSize = frames * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  const amplitude = 200; // 약 -44dBFS: 무음이 아니라서 loudnorm이 측정값을 냅니다
  for (let index = 0; index < frames; index += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * index) / sampleRate) * amplitude), 44 + index * 2);
  }
  writeFileSync(file, buffer);
  return file;
}

// ──────────────────────────────────────────────────────────────
// 백엔드 선택
// ──────────────────────────────────────────────────────────────
export type ResolvedBackend = "whisperx" | "whisper" | "gemini" | "mock";

export function detectBackend(config: Config): ResolvedBackend {
  const backend = config.transcribeBackend;
  if (backend !== "auto") return backend;
  if (which("whisperx")) return "whisperx";
  if (which("whisper")) return "whisper";
  if (config.dryRun) return "mock";
  throw new ConfigError("로컬 전사 도구(whisperx/whisper)를 찾을 수 없습니다.", {
    hint: "pip install -U whisperx 또는 .env에 TRANSCRIBE_BACKEND=gemini|mock 설정",
  });
}

// ──────────────────────────────────────────────────────────────
// mock 전사문 — 데모/테스트/드라이런용 고정 대화
// ──────────────────────────────────────────────────────────────
export const MOCK_DIALOGUE: Array<[string, string]> = [
  ["SPEAKER_00", "여보세요? 자고 있었어?"],
  ["SPEAKER_01", "아니 그냥 누워 있었지"],
  ["SPEAKER_00", "오늘 왜 이렇게 늦게 걸었어"],
  ["SPEAKER_01", "회사에서 좀 늦었어"],
  ["SPEAKER_00", "회사? 오늘 퇴근한다고 했잖아"],
  ["SPEAKER_01", "그게 좀 밀려서"],
  ["SPEAKER_00", "나 지금 진짜 진지하다고"],
  ["SPEAKER_01", "알겠어 알겠어 미안해"],
  ["SPEAKER_00", "너 나랑 왜 사귀는 것 같아?"],
  ["SPEAKER_01", "뭐?"],
  ["SPEAKER_00", "그냥 궁금해서"],
  ["SPEAKER_01", "나는 그냥 좋아서 사귀지"],
  ["SPEAKER_00", "그냥? 그냥이 뭐야"],
  ["SPEAKER_01", "아니 진짜 좋아서"],
  ["SPEAKER_00", "지난주에도 똑같이 말했어"],
  ["SPEAKER_01", "기억해 기억해"],
  ["SPEAKER_00", "그럼 내가 뭐 좋아하는지 말해봐"],
  ["SPEAKER_01", "떡볶이"],
  ["SPEAKER_00", "그건 내가 어제 먹은 거고"],
  ["SPEAKER_01", "아 밀크티?"],
  ["SPEAKER_00", "그래도 하나는 맞았네"],
  ["SPEAKER_01", "뭐가?"],
  ["SPEAKER_00", "지금 식은땀 흘리는 거"],
  ["SPEAKER_01", "안 흘렸는데"],
  ["SPEAKER_00", "카메라 켜봐"],
  ["SPEAKER_01", "지금 이 시간에?"],
  ["SPEAKER_00", "응"],
  ["SPEAKER_01", "자기야 나 진짜 사랑해"],
  ["SPEAKER_00", "그걸 지금 말해?"],
  ["SPEAKER_01", "타이밍 좋지"],
];

export function mockTranscript(): Transcript {
  const segments: TranscriptSegment[] = [];
  let cursor = 1;
  MOCK_DIALOGUE.forEach(([speaker, text], index) => {
    const spoken = Math.max(1.2, text.length / 4.2);
    const start = Number(cursor.toFixed(2));
    const end = Number((cursor + spoken).toFixed(2));
    const tokens = text.split(/\s+/).filter(Boolean);
    const step = tokens.length ? spoken / tokens.length : spoken;
    const words = tokens.map((token, order) => ({
      w: token,
      start: Number((start + order * step).toFixed(2)),
      end: Number((start + (order + 1) * step).toFixed(2)),
    }));
    segments.push({ start, end, speaker, text, words });
    cursor = end + (index % 3 === 0 ? 0.7 : 1.1);
  });
  return {
    language: "ko",
    durationSec: Number((cursor + 1.5).toFixed(2)),
    backend: "mock",
    model: "mock-v1",
    diarized: true,
    speakerMap: { SPEAKER_00: "GF", SPEAKER_01: "BF" },
    segments,
  };
}

// ──────────────────────────────────────────────────────────────
// whisperx / whisper
// ──────────────────────────────────────────────────────────────
function runCli(binary: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: 7_200_000, maxBuffer: 64 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) reject(new TranscribeError(`${binary} 실패: ${error.message}\n${stderr ?? ""}`.trim()));
      else resolve();
    });
  });
}

export async function transcribeWithWhisperx(wav: string, outDir: string, config: Config): Promise<Transcript> {
  const binary = which("whisperx");
  if (!binary) throw new TranscribeError("whisperx를 찾을 수 없습니다.", { hint: "pip install -U whisperx" });
  mkdirSync(outDir, { recursive: true });
  await runCli(binary, [
    wav,
    "--model",
    config.transcribeModel,
    "--language",
    "ko",
    "--diarize",
    "--min_speakers",
    "2",
    "--max_speakers",
    "2",
    "--output_format",
    "json",
    "--output_dir",
    outDir,
  ]);
  const resultFile = path.join(outDir, `${path.basename(wav, path.extname(wav))}.json`);
  if (!existsSync(resultFile)) throw new TranscribeError("whisperx 결과 JSON을 찾지 못했습니다.", { hint: outDir });
  const data = JSON.parse(readFileSync(resultFile, "utf8")) as {
    language?: string;
    duration?: number;
    segments?: Array<Record<string, unknown>>;
  };
  const segments: TranscriptSegment[] = (data.segments ?? []).map((segment) => ({
    start: Number(segment.start ?? 0),
    end: Number(segment.end ?? 0),
    speaker: String(segment.speaker ?? "SPEAKER_00"),
    text: String(segment.text ?? "").trim(),
    words: Array.isArray(segment.words)
      ? (segment.words as Array<Record<string, unknown>>).map((word) => ({
          w: String(word.word ?? "").trim(),
          start: Number(word.start ?? 0),
          end: Number(word.end ?? 0),
        }))
      : [],
  }));
  return {
    language: data.language ?? "ko",
    durationSec: Number(data.duration ?? segments.at(-1)?.end ?? 0),
    backend: "whisperx",
    model: config.transcribeModel,
    diarized: segments.some((segment) => segment.speaker !== "SPEAKER_00"),
    speakerMap: {},
    segments,
  };
}

export async function transcribeWithWhisper(wav: string, outDir: string, config: Config): Promise<Transcript> {
  const binary = which("whisper");
  if (!binary) throw new TranscribeError("whisper CLI를 찾을 수 없습니다.", { hint: "pip install openai-whisper" });
  mkdirSync(outDir, { recursive: true });
  await runCli(binary, [
    wav,
    "--model",
    config.transcribeModel,
    "--language",
    "ko",
    "--output_format",
    "json",
    "--output_dir",
    outDir,
  ]);
  const resultFile = path.join(outDir, `${path.basename(wav, path.extname(wav))}.json`);
  if (!existsSync(resultFile)) throw new TranscribeError("whisper 결과 JSON을 찾지 못했습니다.", { hint: outDir });
  const data = JSON.parse(readFileSync(resultFile, "utf8")) as {
    language?: string;
    segments?: Array<Record<string, unknown>>;
  };
  const segments: TranscriptSegment[] = (data.segments ?? []).map((segment) => ({
    start: Number(segment.start ?? 0),
    end: Number(segment.end ?? 0),
    speaker: "SPEAKER_00",
    text: String(segment.text ?? "").trim(),
    words: [],
  }));
  return {
    language: data.language ?? "ko",
    durationSec: segments.at(-1)?.end ?? 0,
    backend: "whisper",
    model: config.transcribeModel,
    diarized: false,
    speakerMap: {},
    segments,
  };
}

// ──────────────────────────────────────────────────────────────
// Gemini Audio (B안 — 외부 전송)
// ──────────────────────────────────────────────────────────────
export const GEMINI_TRANSCRIBE_PROMPT = `이 오디오는 한국어 2인 전화 통화입니다. 화자 A/B를 구분해 JSON으로만 답하세요.
규칙:
- segments 배열: 각 항목 {"start": 초, "end": 초, "speaker": "A"|"B", "text": "발화"}
- 실제로 들리는 말만. 추측·요약·번역 금지. 맞장구("응", "아 진짜")도 넣습니다.
- 시간은 오디오 시작 기준 초 단위 소수.
출력: {"language": "ko", "segments": [...]}`;

export async function transcribeWithGemini(
  wav: string,
  config: Config,
  callGemini: (config: Config, payload: unknown, model: string) => Promise<string>,
): Promise<Transcript> {
  if (!config.geminiApiKey) throw new ConfigError("GEMINI_API_KEY가 없습니다.");
  const raw = readFileSync(wav);
  if (raw.byteLength > 18 * 1024 * 1024) {
    throw new TranscribeError("오디오가 18MB를 넘어 Gemini 인라인 전송 한도를 넘습니다.", {
      hint: "whisperx를 쓰거나 통화를 나눠 주세요.",
    });
  }
  const payload = {
    contents: [
      {
        parts: [
          { inline_data: { mime_type: "audio/wav", data: raw.toString("base64") } },
          { text: GEMINI_TRANSCRIBE_PROMPT },
        ],
      },
    ],
    generationConfig: { temperature: 0, response_mime_type: "application/json" },
  };
  const text = await callGemini(config, payload, config.geminiAudioModel);
  const parsed = JSON.parse(text.replace(/^```json/, "").replace(/```$/, "").trim()) as {
    language?: string;
    segments?: Array<{ start?: number; end?: number; speaker?: string; text?: string }>;
  };
  const mapping: Record<string, string> = { A: "SPEAKER_00", B: "SPEAKER_01" };
  const segments: TranscriptSegment[] = (parsed.segments ?? []).map((segment) => ({
    start: Number(segment.start ?? 0),
    end: Number(segment.end ?? 0),
    speaker: mapping[String(segment.speaker ?? "A").toUpperCase()] ?? "SPEAKER_00",
    text: String(segment.text ?? "").trim(),
    words: [],
  }));
  return {
    language: parsed.language ?? "ko",
    durationSec: segments.at(-1)?.end ?? 0,
    backend: "gemini",
    model: config.geminiAudioModel,
    diarized: true,
    speakerMap: {},
    segments,
  };
}

// ──────────────────────────────────────────────────────────────
// 오케스트레이션
// ──────────────────────────────────────────────────────────────
export interface TranscriberDeps {
  transcribeGemini?: (wav: string, config: Config) => Promise<Transcript>;
}

export class Transcriber {
  constructor(
    private readonly config: Config,
    private readonly store?: StateStore,
    private readonly deps: TranscriberDeps = {},
  ) {}

  resolveSpeakerMap(projectDir: string, transcript: Transcript): Transcript {
    const labels = rawSpeakers(transcript);
    const existing = loadSpeakerMap(projectDir);
    const mapping: Record<string, string> = {};
    let confidence = "human";

    if (existing?.map) {
      Object.assign(mapping, existing.map);
      confidence = existing.confidence ?? "human";
    } else if (Object.keys(transcript.speakerMap).length) {
      Object.assign(mapping, transcript.speakerMap);
      confidence = "auto";
    }
    const stored = this.store?.loadSpeakerMap(projectDir);
    if (stored?.map && !existing) {
      Object.assign(mapping, stored.map);
      confidence = stored.confidence ?? "human";
    }

    let missing = labels.filter((label) => !(label in mapping));
    if (missing.length && labels.length === 2 && this.config.autoAcceptSpeakerMap) {
      mapping[labels[0]] ??= "GF";
      mapping[labels[1]] ??= "BF";
      confidence = "assumed";
      missing = labels.filter((label) => !(label in mapping));
    }

    if (missing.length || Object.keys(mapping).length === 0) {
      saveSpeakerMap(projectDir, mapping, "incomplete");
      throw new NeedsHumanError(
        `화자 매핑이 아직 없습니다: ${labels.join(", ") || "화자 없음"}${
          transcript.diarized ? "" : " (whisper 백엔드는 화자분리를 하지 않습니다)"
        }`,
        {
          hint: "전사문 첫 30초에서 '여보세요'를 먼저 말한 쪽을 보세요.",
          action: `npm run call-shorts -- map-speakers --project ${projectDir} --a GF --b BF`,
        },
      );
    }

    const roles = Object.values(mapping);
    if (new Set(roles).size !== roles.length) {
      throw new NeedsHumanError(`화자 매핑이 중복됩니다: ${JSON.stringify(mapping)}`, {
        action: `npm run call-shorts -- map-speakers --project ${projectDir} --a GF --b BF`,
      });
    }

    saveSpeakerMap(projectDir, mapping, confidence);
    this.store?.saveSpeakerMap(projectDir, mapping, confidence);
    return { ...transcript, speakerMap: mapping as Record<string, SpeakerRole> };
  }

  async run(projectDir: string, sourceAudio: string): Promise<Transcript> {
    mkdirSync(path.join(projectDir, "transcript"), { recursive: true });
    mkdirSync(path.join(projectDir, "audio"), { recursive: true });
    const backend = detectBackend(this.config);
    const wav = path.join(projectDir, "audio", "norm.wav");

    let transcript: Transcript;
    if (backend === "mock") {
      transcript = mockTranscript();
      writeSilenceWav(wav, transcript.durationSec);
    } else {
      if (!existsSync(sourceAudio)) throw new TranscribeError(`원본 오디오가 없습니다: ${sourceAudio}`);
      normalizeAudio(sourceAudio, wav, this.config);
      if (backend === "whisperx") transcript = await transcribeWithWhisperx(wav, path.join(projectDir, "transcript"), this.config);
      else if (backend === "whisper") transcript = await transcribeWithWhisper(wav, path.join(projectDir, "transcript"), this.config);
      else if (backend === "gemini") {
        const call = this.deps.transcribeGemini;
        if (!call) throw new ConfigError("Gemini 전사 함수가 주입되지 않았습니다.");
        transcript = await call(wav, this.config);
      } else {
        throw new TranscribeError(`알 수 없는 전사 백엔드: ${backend}`);
      }
    }

    if (!transcript.segments.length) {
      throw new TranscribeError("전사 결과에 발화 구간이 없습니다.", { hint: "오디오가 무음이거나 너무 짧습니다." });
    }
    if (transcript.durationSec <= 0) transcript.durationSec = transcript.segments.at(-1)!.end;

    saveTranscript(projectDir, transcript);
    transcript = this.resolveSpeakerMap(projectDir, transcript);
    saveTranscript(projectDir, transcript);
    writeFileSync(path.join(projectDir, "transcript", "transcript.md"), transcriptAsMarkdown(transcript), "utf8");
    return transcript;
  }
}

/** 사람이 한 번 지정하는 화자 매핑. */
export function mapSpeakers(projectDir: string, girlLabel: string, boyLabel: string, store?: StateStore): Transcript {
  const transcript = loadTranscript(projectDir);
  const labels = rawSpeakers(transcript);
  if (labels.length < 2) {
    throw new NeedsHumanError(`화자 라벨이 ${labels.length}개뿐이라 A/B로 나눌 수 없습니다: ${labels.join(", ")}`, {
      hint: "whisperx + pyannote로 다시 전사하세요 (TRANSCRIBE_BACKEND=whisperx).",
    });
  }
  const map = { [labels[0]]: girlLabel, [labels[1]]: boyLabel };
  saveSpeakerMap(projectDir, map);
  store?.saveSpeakerMap(projectDir, map);
  const updated: Transcript = { ...transcript, speakerMap: map as Record<string, SpeakerRole> };
  saveTranscript(projectDir, updated);
  writeFileSync(path.join(projectDir, "transcript", "transcript.md"), transcriptAsMarkdown(updated), "utf8");
  return updated;
}

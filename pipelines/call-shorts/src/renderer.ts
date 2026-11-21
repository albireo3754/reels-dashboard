/**
 * Step 4 — FFmpeg 합성: 9:16 세로 숏폼(1080x1920, 30fps).
 *
 * Remotion 대신 FFmpeg + ASS를 고른 이유: 정지 이미지 + 자막 + 미세 모션이라 React 이점이 없고,
 * 한국어 자막 줄바꿈·화자별 색은 ASS가 정확하며, 렌더가 가장 빠릅니다.
 *
 * 하드컷만, 컷당 줌 100→104%, 회전 ±1.5°, 지터(보일링), BGM 사이드체인 덕킹, loudnorm -14 LUFS.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Config } from "./config.js";
import { cutDuration, totalDuration } from "./episode.js";
import { RenderError } from "./errors.js";
import { probeMedia, requireFfmpeg, run } from "./media.js";
import { buildAss, buildCoverAss, buildSrt } from "./subtitles.js";
import type { Episode, MediaInfo } from "./types.js";

const SAFE_WIDTH = 1188;
const SAFE_HEIGHT = 2112;

export interface RenderResult {
  video: string | null;
  cover: string | null;
  srt: string;
  ass: string;
  plan: string;
  duration: number;
  command: string[];
}

export function zoomExpression(duration: number, fps: number): string {
  const frames = Math.max(2, Math.round(duration * fps));
  return `min(1+0.04*on/${frames - 1},1.04)`;
}

function cutVideoChain(index: number, cut: Episode["cuts"][number], config: Config): string {
  const duration = Math.max(0.4, cutDuration(cut) || 0.4);
  const rotate = Math.max(-0.0524, Math.min(0.0524, ((cut.camera?.rotateDeg ?? 0) * Math.PI) / 180));
  return (
    `[${index}:v]scale=${SAFE_WIDTH}:${SAFE_HEIGHT}:force_original_aspect_ratio=increase,` +
    `crop=${SAFE_WIDTH}:${SAFE_HEIGHT},` +
    `rotate=${rotate.toFixed(5)}:ow=iw:oh=ih:fillcolor=0xFDF9F2,` +
    `zoompan=z='${zoomExpression(duration, config.fps)}':` +
    `x='iw/2-(iw/zoom/2)+2*sin(on/2)':y='ih/2-(ih/zoom/2)+2*cos(on/2)':` +
    `d=1:s=${config.renderWidth}x${config.renderHeight}:fps=${config.fps},` +
    `setsar=1,fps=${config.fps},format=yuv420p,` +
    `trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS[v${index}]`
  );
}

export function buildRenderCommand(
  episode: Episode,
  config: Config,
  options: { audio: string; images: string[]; bgm?: string | null; sfx?: Array<{ at: number; file: string }> },
): { command: string[]; graph: string; total: number } {
  const cuts = episode.cuts ?? [];
  if (!cuts.length) throw new RenderError("컷이 없습니다.");
  if (cuts.length !== options.images.length) {
    throw new RenderError(`컷 수(${cuts.length})와 이미지 수(${options.images.length})가 다릅니다.`);
  }
  const ffmpeg = requireFfmpeg(config);
  const total = Number(totalDuration(episode).toFixed(3));
  const command: string[] = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error"];

  cuts.forEach((cut, index) => {
    command.push(
      "-loop", "1", "-framerate", String(config.fps), "-t", Math.max(0.4, cutDuration(cut)).toFixed(3), "-i", options.images[index],
    );
  });
  cuts.forEach((cut) => {
    const start = Math.max(0, Number(cut.sourceRange?.[0] ?? 0));
    command.push("-ss", start.toFixed(3), "-t", Math.max(0.4, cutDuration(cut)).toFixed(3), "-i", options.audio);
  });

  let nextInput = cuts.length * 2;
  let bgmIndex: number | null = null;
  if (options.bgm && existsSync(options.bgm)) {
    bgmIndex = nextInput;
    command.push("-stream_loop", "-1", "-i", options.bgm);
    nextInput += 1;
  }
  const sfxInputs: Array<{ at: number; index: number }> = [];
  for (const effect of (options.sfx ?? []).slice(0, 3)) {
    if (!existsSync(effect.file)) continue;
    sfxInputs.push({ at: effect.at, index: nextInput });
    command.push("-i", effect.file);
    nextInput += 1;
  }

  const chains: string[] = [];
  cuts.forEach((cut, index) => {
    chains.push(cutVideoChain(index, cut, config));
    chains.push(
      `[${cuts.length + index}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,apad,` +
        `atrim=duration=${Math.max(0.4, cutDuration(cut)).toFixed(3)},asetpts=PTS-STARTPTS[a${index}]`,
    );
  });
  chains.push(`${cuts.map((_, index) => `[v${index}][a${index}]`).join("")}concat=n=${cuts.length}:v=1:a=1[vcat][acat]`);

  const fonts = config.fontsDir ? `:fontsdir=${escapeFilterValue(config.fontsDir)}` : "";
  chains.push(`[vcat]ass=filename=captions.ass${fonts}[vout]`);

  let audioLabel = "acat";
  if (sfxInputs.length) {
    const labels = [`[${audioLabel}]`];
    sfxInputs.forEach((effect, order) => {
      const delayMs = Math.max(0, Math.round(effect.at * 1000));
      chains.push(
        `[${effect.index}:a]volume=0.55,adelay=${delayMs}|${delayMs},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[sfx${order}]`,
      );
      labels.push(`[sfx${order}]`);
    });
    chains.push(`${labels.join("")}amix=inputs=${labels.length}:duration=first:dropout_transition=0:normalize=0[amix]`);
    audioLabel = "amix";
  }

  if (bgmIndex !== null) {
    chains.push(`[${audioLabel}]asplit=2[voice][voicekey]`);
    chains.push(
      `[${bgmIndex}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=0.22,` +
        `atrim=duration=${total.toFixed(3)},afade=t=in:st=0:d=0.6[bgmraw]`,
    );
    chains.push("[bgmraw][voicekey]sidechaincompress=threshold=0.05:ratio=6:attack=5:release=180[bgmduck]");
    chains.push("[voice][bgmduck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[amixed]");
    audioLabel = "amixed";
  }

  chains.push(`[${audioLabel}]loudnorm=I=-14:TP=-1.5:LRA=11[aout]`);
  const graph = chains.join(";");

  command.push(
    "-filter_complex", graph,
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-preset", config.x264Preset, "-crf", String(config.x264Crf), "-pix_fmt", "yuv420p",
    "-r", String(config.fps),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-t", total.toFixed(3),
    "-movflags", "+faststart",
    "short.mp4",
  );
  return { command, graph, total };
}

function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,");
}

export function resolveImages(projectDir: string, episode: Episode): string[] {
  const images: string[] = [];
  for (const cut of episode.cuts ?? []) {
    const idx = String(cut.idx ?? images.length + 1).padStart(2, "0");
    const candidates = [
      path.join(projectDir, "images", "processed", `cut_${idx}.png`),
      path.join(projectDir, "images", `cut_${idx}.png`),
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) throw new RenderError(`컷 ${idx} 이미지가 없습니다: ${path.join(projectDir, "images")}`);
    images.push(found);
  }
  return images;
}

export function render(
  projectDir: string,
  episode: Episode,
  config: Config,
  options: { execute?: boolean } = {},
): RenderResult & { media?: MediaInfo } {
  const execute = options.execute ?? true;
  const renderDir = path.join(projectDir, "render");
  mkdirSync(renderDir, { recursive: true });

  const assFile = path.join(renderDir, "captions.ass");
  const srtFile = path.join(renderDir, "captions.srt");
  const coverAss = path.join(renderDir, "cover.ass");
  const planFile = path.join(renderDir, "ffmpeg-plan.txt");
  writeFileSync(assFile, buildAss(episode, config), "utf8");
  writeFileSync(srtFile, buildSrt(episode), "utf8");
  writeFileSync(coverAss, buildCoverAss(episode, config), "utf8");

  const audio = path.join(projectDir, "audio", "norm.wav");
  if (execute && !existsSync(audio)) {
    throw new RenderError(`정규화 오디오가 없습니다: ${audio}`, { hint: "transcribe 단계를 먼저 실행하세요." });
  }
  let images: string[] = [];
  try {
    images = resolveImages(projectDir, episode);
  } catch (error) {
    if (execute) throw error;
  }
  const bgm = config.bgmPath && existsSync(config.bgmPath) ? config.bgmPath : null;
  const sfx: Array<{ at: number; file: string }> = [];
  for (const cut of episode.cuts ?? []) {
    if (!cut.sfx) continue;
    const file = path.join(config.sfxDir, `${cut.sfx}.wav`);
    if (existsSync(file)) sfx.push({ at: cut.tStart, file });
  }

  let command: string[] = [];
  let graph = "";
  let total = Number(totalDuration(episode).toFixed(3));
  let buildError: Error | null = null;
  if (images.length) {
    try {
      ({ command, graph, total } = buildRenderCommand(episode, config, { audio, images, bgm, sfx }));
    } catch (error) {
      buildError = error as Error;
      if (execute) throw error;
    }
  }

  const planText =
    "# FFmpeg 렌더 계획\n" +
    `# 실행 여부: ${execute ? "예" : "아니오 (dry-run — 명령만 기록)"}\n` +
    `# 길이: ${total.toFixed(2)}s · ${config.renderWidth}x${config.renderHeight} @ ${config.fps}fps\n` +
    `# 작업 폴더: ${renderDir}\n` +
    `# 이미지: ${images.map((image) => path.relative(projectDir, image)).join(", ")}\n` +
    `# BGM: ${bgm ?? "없음"} · SFX: ${sfx.length}개\n` +
    (buildError ? `# ffmpeg 준비 안 됨: ${buildError.message}\n` : "") +
    "\n" +
    `${command.map(shellQuote).join(" ")}\n\n# filter_complex\n${graph.replace(/;/g, ";\n")}\n`;
  writeFileSync(planFile, planText, "utf8");

  if (!execute) return { video: null, cover: null, srt: srtFile, ass: assFile, plan: planFile, duration: total, command };
  if (!images.length) throw new RenderError("렌더할 컷 이미지가 없습니다.");

  const output = path.join(renderDir, "short.mp4");
  if (existsSync(output)) unlinkSync(output);
  run(command[0], command.slice(1), { cwd: renderDir, timeoutMs: 3_600_000 });
  if (!existsSync(output)) throw new RenderError("렌더 결과 파일이 없습니다.", { hint: planFile });

  const cover = makeCover(renderDir, config);
  return { video: output, cover, srt: srtFile, ass: assFile, plan: planFile, duration: total, command };
}

function makeCover(renderDir: string, config: Config): string | null {
  const ffmpeg = requireFfmpeg(config);
  const cover = path.join(renderDir, "cover.png");
  try {
    run(
      ffmpeg,
      [
        "-y", "-hide_banner", "-loglevel", "error",
        "-ss", Math.max(0, config.coverTimeSec).toFixed(2),
        "-i", "short.mp4",
        "-frames:v", "1",
        "-vf", "ass=filename=cover.ass",
        "cover.png",
      ],
      { cwd: renderDir, timeoutMs: 180_000 },
    );
  } catch {
    return null;
  }
  return existsSync(cover) ? cover : null;
}

export function measureLoudness(video: string, config: Config): Record<string, number> {
  const ffmpeg = requireFfmpeg(config);
  const result = run(
    ffmpeg,
    ["-hide_banner", "-nostats", "-i", video, "-af", "loudnorm=print_format=json", "-f", "null", "-"],
    { check: false, timeoutMs: 900_000 },
  );
  const text = result.stderr + result.stdout;
  const match = /\{[^{}]*"input_i"[^{}]*\}/s.exec(text);
  if (!match) return {};
  try {
    const data = JSON.parse(match[0]) as Record<string, string>;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(data)) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) out[key] = parsed;
    }
    return out;
  } catch {
    return {};
  }
}

export function mediaReport(video: string, config: Config): MediaInfo {
  return probeMedia(video, config);
}

function shellQuote(value: string): string {
  if (!value) return "''";
  if (/[\s'"$`\\!*?()&;|<>]/.test(value)) return `'${value.replace(/'/g, "'\\''")}'`;
  return value;
}

export function readFileSafe(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

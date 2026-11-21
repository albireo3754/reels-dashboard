/**
 * episode.json 스키마 검증기 — 설계 §2-5 규칙 그대로.
 *  · cuts 5~8개, 자막 중복 금지(컷마다 새 정보 1개)
 *  · 자막 한 줄 14자 이내, 최대 2줄
 *  · 컷 길이 ≥ 자막 글자수 ÷ 9자/초
 *  · 첫 컷 t_start = 0, 컷은 끊김 없이 이어짐, 전체 25~55초
 *  · 첫 컷 source_range는 전사문의 실제 발화와 겹치고, 자막은 그 발화 인용
 */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Episode, EpisodeCut, Transcript } from "./types.js";

export const MIN_CUTS = 5;
export const MAX_CUTS = 8;
export const MAX_CAPTION_CHARS = 14;
export const MAX_CAPTION_LINES = 2;
export const CHARS_PER_SEC = 9;
export const MIN_TOTAL_SEC = 25;
export const MAX_TOTAL_SEC = 55;
export const MAX_HASHTAGS = 5;
export const PLATFORMS = ["youtube", "instagram", "tiktok"] as const;

const HANGUL_ALNUM = /[^0-9A-Za-z가-힣]/g;

export function normalizeForMatch(text: string): string {
  return (text ?? "").replace(HANGUL_ALNUM, "");
}

export function cutDuration(cut: Pick<EpisodeCut, "tStart" | "tEnd">): number {
  const start = Number(cut.tStart);
  const end = Number(cut.tEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

export function totalDuration(episode: Pick<Episode, "cuts">): number {
  let end = 0;
  for (const cut of episode.cuts ?? []) {
    const value = Number(cut?.tEnd);
    if (Number.isFinite(value)) end = Math.max(end, value);
  }
  return end;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface ValidateOptions {
  minCuts?: number;
  maxCuts?: number;
  maxCaptionChars?: number;
  charsPerSec?: number;
  minTotal?: number;
  maxTotal?: number;
}

export function validateEpisode(episode: unknown, transcript?: Transcript, options: ValidateOptions = {}): string[] {
  const minCuts = options.minCuts ?? MIN_CUTS;
  const maxCuts = options.maxCuts ?? MAX_CUTS;
  const maxCaptionChars = options.maxCaptionChars ?? MAX_CAPTION_CHARS;
  const charsPerSec = options.charsPerSec ?? CHARS_PER_SEC;
  const minTotal = options.minTotal ?? MIN_TOTAL_SEC;
  const maxTotal = options.maxTotal ?? MAX_TOTAL_SEC;
  const issues: string[] = [];

  if (!isObject(episode)) return ["episode.json 최상위가 객체가 아닙니다."];

  for (const key of [
    "episodeId",
    "source",
    "format",
    "hook",
    "cuts",
    "punchline",
    "aiDisclosure",
    "platformMeta",
  ]) {
    if (!(key in episode)) issues.push(`필수 필드 누락: ${key}`);
  }
  if (issues.length) return issues;

  if (!String(episode.episodeId ?? "").trim()) issues.push("episodeId가 비었습니다.");

  const source = episode.source;
  if (!isObject(source)) {
    issues.push("source는 객체여야 합니다.");
  } else {
    if (!String(source.audio ?? "").trim()) issues.push("source.audio가 비었습니다.");
    const duration = num(source.durationSec);
    if (duration === null || duration <= 0) issues.push("source.durationSec가 양수가 아닙니다.");
    if (!String(source.callDate ?? "").trim()) issues.push("source.callDate가 비었습니다.");
  }

  if (!String(episode.format ?? "").trim()) issues.push("format이 비었습니다.");

  const target = num(episode.targetDurationSec);
  if (target === null) issues.push("targetDurationSec가 숫자가 아닙니다.");
  else if (target < minTotal || target > maxTotal) {
    issues.push(`targetDurationSec가 ${minTotal}~${maxTotal}초 범위를 벗어났습니다: ${target}`);
  }

  const hook = episode.hook;
  if (!isObject(hook)) {
    issues.push("hook은 객체여야 합니다.");
  } else {
    const text = String(hook.text ?? "").trim();
    if (!text) issues.push("hook.text가 비었습니다.");
    else if (text.length > 45) issues.push(`hook.text가 너무 깁니다(${text.length}자, 45자 이내): ${text.slice(0, 20)}…`);
    if (!String(hook.type ?? "").trim()) issues.push("hook.type이 비었습니다.");
    if (!String(hook.firstFrame ?? "").trim()) issues.push("hook.firstFrame이 비었습니다 — 첫 프레임이 곧 훅입니다.");
  }

  const cuts = Array.isArray(episode.cuts) ? (episode.cuts as unknown[]) : null;
  if (!cuts) {
    issues.push("cuts는 배열이어야 합니다.");
  } else if (cuts.length < minCuts || cuts.length > maxCuts) {
    issues.push(`cuts 개수가 ${minCuts}~${maxCuts}개여야 합니다: ${cuts.length}개`);
  }

  const seen = new Map<string, number>();
  let previousEnd: number | null = null;

  (cuts ?? []).forEach((rawCut, position) => {
    const label = `cuts[${position}]`;
    if (!isObject(rawCut)) {
      issues.push(`${label}가 객체가 아닙니다.`);
      return;
    }
    const cut = rawCut as unknown as EpisodeCut;
    if ((rawCut.idx as number) !== position + 1) {
      issues.push(`${label}.idx는 ${position + 1}이어야 합니다: ${String(rawCut.idx)}`);
    }

    const start = num(rawCut.tStart);
    const end = num(rawCut.tEnd);
    if (start === null || end === null) {
      issues.push(`${label}의 tStart/tEnd가 숫자가 아닙니다.`);
      return;
    }
    const duration = end - start;
    if (start < -0.01) issues.push(`${label}.tStart가 음수입니다: ${start}`);
    if (duration <= 0.5) issues.push(`${label} 길이가 너무 짧습니다(${duration.toFixed(2)}s)`);
    if (position === 0 && start > 0.06) {
      issues.push(`첫 컷이 0초에서 시작하지 않습니다: ${start}s (첫 프레임이 곧 내용이어야 함)`);
    }
    if (previousEnd !== null && Math.abs(start - previousEnd) > 0.08) {
      issues.push(`${label} 시작(${start.toFixed(2)}s)이 앞 컷 끝(${previousEnd.toFixed(2)}s)과 이어지지 않습니다`);
    }
    previousEnd = end;

    const speaker = String(rawCut.speaker ?? "").toUpperCase();
    if (speaker !== "GF" && speaker !== "BF") {
      issues.push(`${label}.speaker는 GF/BF 중 하나여야 합니다: ${String(rawCut.speaker)}`);
    }

    const caption = typeof rawCut.caption === "string" ? rawCut.caption : "";
    if (!caption.trim()) {
      issues.push(`${label}.caption이 비었습니다.`);
    } else {
      const lines = caption.split("\n");
      if (lines.length > MAX_CAPTION_LINES) {
        issues.push(`${label}.caption이 ${lines.length}줄입니다 (최대 ${MAX_CAPTION_LINES}줄)`);
      }
      for (const line of lines) {
        if (line.length > maxCaptionChars) {
          issues.push(`${label}.caption 한 줄이 ${line.length}자입니다 (최대 ${maxCaptionChars}자): ${line}`);
        }
      }
      const minimum = caption.replace(/\n/g, "").length / charsPerSec;
      if (duration + 0.001 < minimum) {
        issues.push(
          `${label} 길이 ${duration.toFixed(2)}s가 자막 ${caption.replace(/\n/g, "").length}자에 못 미칩니다 (최소 ${minimum.toFixed(2)}s)`,
        );
      }
      const key = normalizeForMatch(caption);
      if (seen.has(key)) {
        issues.push(`${label}.caption이 cuts[${seen.get(key)! - 1}]와 같습니다 — 컷마다 새 정보 1개여야 합니다`);
      } else {
        seen.set(key, position + 1);
      }
    }

    const range = rawCut.sourceRange;
    if (!Array.isArray(range) || range.length !== 2 || num(range[0]) === null || num(range[1]) === null) {
      issues.push(`${label}.sourceRange는 [시작초, 끝초] 두 숫자여야 합니다.`);
    } else {
      const [srcStart, srcEnd] = range as [number, number];
      if (srcStart < 0 || srcEnd <= srcStart) {
        issues.push(`${label}.sourceRange 순서가 잘못됐습니다: [${srcStart}, ${srcEnd}]`);
      } else if (srcEnd - srcStart + 0.05 < duration) {
        issues.push(
          `${label}.sourceRange 길이(${(srcEnd - srcStart).toFixed(2)}s)가 컷 길이(${duration.toFixed(2)}s)보다 짧습니다`,
        );
      }
      if (transcript) {
        checkAgainstTranscript(label, position, caption, speaker, srcStart, srcEnd, transcript, issues);
      }
    }

    const visual = rawCut.visual;
    if (!isObject(visual)) {
      issues.push(`${label}.visual은 객체여야 합니다.`);
    } else {
      if (!String(visual.scene ?? "").trim()) issues.push(`${label}.visual.scene이 비었습니다.`);
      if (!String(visual.emotion ?? "").trim()) issues.push(`${label}.visual.emotion이 비었습니다.`);
      if (visual.props !== undefined && !Array.isArray(visual.props)) {
        issues.push(`${label}.visual.props는 배열이어야 합니다.`);
      }
    }

    const camera = rawCut.camera;
    if (camera !== undefined && camera !== null) {
      if (!isObject(camera)) issues.push(`${label}.camera는 객체여야 합니다.`);
      else {
        const rotate = camera.rotateDeg;
        if (rotate !== undefined && rotate !== null) {
          const value = num(rotate);
          if (value === null) issues.push(`${label}.camera.rotateDeg가 숫자가 아닙니다.`);
          else if (Math.abs(value) > 3) issues.push(`${label}.camera.rotateDeg가 ±3°를 넘습니다: ${value}`);
        }
      }
    }

    const bubble = rawCut.bubble;
    if (bubble !== null && bubble !== undefined && bubble !== "") {
      if (typeof bubble !== "string") issues.push(`${label}.bubble은 문자열 또는 null이어야 합니다.`);
      else if (bubble.length > 24) issues.push(`${label}.bubble이 너무 깁니다(${bubble.length}자): ${bubble.slice(0, 12)}…`);
    }
    void cut;
  });

  const total = totalDuration(episode as unknown as Episode);
  if ((cuts?.length ?? 0) > 0 && (total < minTotal || total > maxTotal)) {
    issues.push(`전체 길이가 ${minTotal}~${maxTotal}초여야 합니다: ${total.toFixed(2)}s`);
  }

  const punchline = episode.punchline;
  if (!isObject(punchline)) issues.push("punchline은 객체여야 합니다.");
  else {
    if (!String(punchline.text ?? "").trim()) issues.push("punchline.text가 비었습니다.");
    const moment = num(punchline.t);
    if (moment === null) issues.push("punchline.t가 숫자가 아닙니다.");
    else if (total && (moment < 0 || moment > total + 0.01)) {
      issues.push(`punchline.t(${moment})가 영상 길이(${total.toFixed(1)}s) 밖입니다.`);
    }
  }

  const loop = episode.loop;
  if (loop !== undefined && loop !== null) {
    if (!isObject(loop)) issues.push("loop는 객체여야 합니다.");
    else {
      if (!String(loop.lastLine ?? "").trim()) issues.push("loop.lastLine이 비었습니다.");
      if (loop.connectsToCut !== undefined && !Number.isInteger(loop.connectsToCut)) {
        issues.push("loop.connectsToCut은 정수여야 합니다.");
      }
    }
  }

  if (episode.redactions !== undefined && !Array.isArray(episode.redactions)) {
    issues.push("redactions는 배열이어야 합니다.");
  }

  const disclosure = episode.aiDisclosure;
  if (!isObject(disclosure)) issues.push("aiDisclosure는 객체여야 합니다.");
  else {
    for (const platform of PLATFORMS) {
      if (!(platform in disclosure)) issues.push(`aiDisclosure.${platform} 누락 — 플랫폼별 판정이 필요합니다.`);
      else if (typeof disclosure[platform] !== "boolean") issues.push(`aiDisclosure.${platform}은 true/false여야 합니다.`);
    }
    if (!String(disclosure.reason ?? "").trim()) issues.push("aiDisclosure.reason이 비었습니다 — 판정 근거 문장이 필요합니다.");
  }

  const meta = episode.platformMeta;
  if (!isObject(meta)) issues.push("platformMeta는 객체여야 합니다.");
  else {
    for (const platform of PLATFORMS) {
      const block = meta[platform];
      if (!isObject(block)) {
        issues.push(`platformMeta.${platform}가 없습니다.`);
        continue;
      }
      if (!String(block.title ?? block.caption ?? "").trim()) issues.push(`platformMeta.${platform}에 title/caption이 없습니다.`);
      const tags = block.hashtags;
      if (!Array.isArray(tags) || tags.length === 0) issues.push(`platformMeta.${platform}.hashtags가 비었습니다.`);
      else if (tags.length > MAX_HASHTAGS) issues.push(`platformMeta.${platform}.hashtags가 ${tags.length}개입니다 (최대 ${MAX_HASHTAGS}개)`);
      else if (tags.some((tag) => !String(tag).startsWith("#"))) issues.push(`platformMeta.${platform}.hashtags는 #으로 시작해야 합니다.`);
    }
  }

  return issues;
}

function checkAgainstTranscript(
  label: string,
  position: number,
  caption: string,
  speaker: string,
  srcStart: number,
  srcEnd: number,
  transcript: Transcript,
  issues: string[],
): void {
  let best: { start: number; end: number; text: string } | null = null;
  let bestOverlap = 0;
  for (const segment of transcript.segments) {
    const role = transcript.speakerMap[segment.speaker] ?? segment.speaker;
    if (role !== speaker) continue;
    const overlap = Math.min(srcEnd, segment.end) - Math.max(srcStart, segment.start);
    if (overlap > bestOverlap) {
      best = segment;
      bestOverlap = overlap;
    }
  }
  if (!best) {
    issues.push(`${label}.sourceRange(${srcStart.toFixed(1)}~${srcEnd.toFixed(1)}s)에 ${speaker} 발화가 없습니다 — 실제 통화 구간을 쓰세요`);
    return;
  }
  if (bestOverlap < 0.3) {
    issues.push(`${label}.sourceRange가 ${speaker} 발화와 ${bestOverlap.toFixed(2)}s만 겹칩니다`);
    return;
  }
  if (position === 0 && caption) {
    const said = normalizeForMatch(best.text);
    const quoted = normalizeForMatch(caption);
    if (quoted && said) {
      let hit = 0;
      for (const char of quoted) if (said.includes(char)) hit += 1;
      if (hit / quoted.length < 0.6) {
        issues.push(`${label}.caption이 실제 발화 인용이 아닙니다: '${caption}' vs 원문 '${best.text}'`);
      }
    }
  }
}

export function episodePath(projectDir: string): string {
  return path.join(projectDir, "plan", "episode.json");
}

export function loadEpisode(projectDir: string): Episode {
  return JSON.parse(readFileSync(episodePath(projectDir), "utf8")) as Episode;
}

export function saveEpisode(projectDir: string, episode: Episode): string {
  const file = episodePath(projectDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(episode, null, 2), "utf8");
  return file;
}

export function saveValidationErrors(projectDir: string, issues: string[]): string {
  const file = path.join(projectDir, "plan", "validation_errors.txt");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, issues.map((issue) => `- ${issue}`).join("\n") + "\n", "utf8");
  return file;
}

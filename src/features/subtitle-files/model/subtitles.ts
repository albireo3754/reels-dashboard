/**
 * SRT block/timestamp parsing adapted from OpenCut Classic (MIT).
 * Copyright 2025-2026 OpenCut. Source revision cf5e79e919144200294fb9fed22a222592a0aeea.
 * See public/licenses/opencut-MIT.txt and THIRD_PARTY_NOTICES.md.
 * App-specific validation, VTT handling and serialization are local additions.
 */
import type { CaptionCue } from "../../../shared/editor";
export const MAX_SUBTITLE_BYTES = 1024 * 1024;
const stamp = /^(\d{2,}):(\d{2}):(\d{2})[,.](\d{1,3})$/;
function timestamp(input: string): number {
  const match = stamp.exec(input.trim());
  if (!match)
    throw new Error("시간 형식은 시:분:초,밀리초 또는 분:초.밀리초여야 해요.");
  const [, h, m, s, fraction] = match;
  if (Number(m) > 59 || Number(s) > 59)
    throw new Error("분과 초는 0~59 범위여야 해요.");
  return (
    Number(h) * 3600 +
    Number(m) * 60 +
    Number(s) +
    Number(fraction.padEnd(3, "0")) / 1000
  );
}
function validateCues(cues: readonly CaptionCue[], duration: number): void {
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error("먼저 영상 길이를 확인해주세요.");
  if (!cues.length || cues.length > 300)
    throw new Error("자막은 1~300개까지 가져올 수 있어요.");
  let previousEnd = 0;
  for (const [index, cue] of cues.entries()) {
    if (
      !Number.isFinite(cue.start) ||
      !Number.isFinite(cue.end) ||
      cue.start < previousEnd ||
      cue.end <= cue.start ||
      cue.end > duration
    )
      throw new Error(
        `${index + 1}번 자막 시간이 겹치거나 순서·영상 길이 범위를 벗어났어요.`,
      );
    const lines = cue.text.split("\n");
    if (
      cue.text.length > 1000 ||
      lines.length > 2 ||
      lines.some((line) => !line.trim()) ||
      /[\u0000\uFFFD]/.test(cue.text)
    )
      throw new Error(
        `${index + 1}번 자막은 비어 있지 않은 한두 줄의 UTF-8 문구여야 해요.`,
      );
    if (/<\/?[a-z][^>]*>/i.test(cue.text))
      throw new Error(
        `${index + 1}번 자막에 서식 태그가 있어요. 평문 자막으로 저장한 뒤 가져와주세요.`,
      );
    previousEnd = cue.end;
  }
}
export interface SubtitleImport {
  format: "srt" | "vtt";
  cues: CaptionCue[];
  ignoredNotes: number;
}
export function parseSubtitleFile(
  input: string,
  fileName: string,
  duration: number,
  idFactory: () => string = () => crypto.randomUUID(),
): SubtitleImport {
  if (
    typeof input !== "string" ||
    new TextEncoder().encode(input).byteLength > MAX_SUBTITLE_BYTES
  )
    throw new Error("자막 파일은 1MB 이하여야 해요.");
  const extension = fileName.split(".").pop()?.toLowerCase();
  if (extension !== "srt" && extension !== "vtt")
    throw new Error("SRT 또는 VTT 파일을 선택해주세요.");
  let content = input
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  let ignoredNotes = 0;
  if (extension === "vtt") {
    const lines = content.split("\n");
    if (!/^WEBVTT(?:[ \t].*)?$/.test(lines[0]))
      throw new Error("VTT 파일의 WEBVTT 헤더를 확인해주세요.");
    lines.shift();
    if (lines.length && lines[0].trim())
      throw new Error("WEBVTT 헤더 뒤에는 빈 줄이 필요해요.");
    content = lines.join("\n").trim();
  }
  if (!content) throw new Error("파일에 가져올 자막이 없어요.");
  const cues: CaptionCue[] = [];
  for (const [blockIndex, block] of content.split(/\n[ \t]*\n+/).entries()) {
    const lines = block.split("\n").map((line) => line.trim());
    if (extension === "vtt" && /^NOTE(?:\s|$)/.test(lines[0])) {
      ignoredNotes++;
      continue;
    }
    if (extension === "vtt" && /^(STYLE|REGION)(?:\s|$)/.test(lines[0]))
      throw new Error(
        "VTT STYLE/REGION 설정은 지원하지 않아요. 평문 자막으로 저장해주세요.",
      );
    const timingIndex = lines[0]?.includes("-->") ? 0 : 1;
    if (extension === "srt" && timingIndex === 1 && !/^\d+$/.test(lines[0]))
      throw new Error(`${blockIndex + 1}번째 자막 번호를 확인해주세요.`);
    const timing = lines[timingIndex]?.match(/^(\S+?)\s*-->\s*(\S+)$/);
    if (!timing)
      throw new Error(
        `${blockIndex + 1}번째 시간 줄을 확인해주세요. 위치·서식 속성은 지원하지 않아요.`,
      );
    const normalize = (v: string) =>
      extension === "vtt" && /^\d{2}:\d{2}\.\d{1,3}$/.test(v) ? `00:${v}` : v;
    let start: number, end: number;
    try {
      start = timestamp(normalize(timing[1]));
      end = timestamp(normalize(timing[2]));
    } catch (error) {
      throw new Error(
        `${blockIndex + 1}번째 자막: ${(error as Error).message}`,
      );
    }
    const text = lines.slice(timingIndex + 1).join("\n");
    cues.push({ id: idFactory(), start, end, text });
  }
  validateCues(cues, duration);
  return { format: extension, cues, ignoredNotes };
}
function srtTime(ms: number): string {
  const hours = Math.floor(ms / 3_600_000),
    minutes = Math.floor(ms / 60_000) % 60,
    seconds = Math.floor(ms / 1000) % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}
export function serializeSrt(
  cues: readonly CaptionCue[],
  duration: number,
): string {
  validateCues(cues, duration);
  return cues
    .map((cue, index) => {
      const start = Math.round(cue.start * 1000),
        end = Math.round(cue.end * 1000);
      if (end <= start)
        throw new Error(
          `${index + 1}번 자막이 1밀리초보다 짧아 SRT로 저장할 수 없어요.`,
        );
      return `${index + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${cue.text}\n`;
    })
    .join("\n");
}

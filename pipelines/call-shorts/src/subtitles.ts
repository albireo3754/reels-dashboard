/**
 * 자막 — 화자별 색 고정 ASS + 업로드용 SRT.
 *
 * 여자 #FF6B9D / 남자 #4FC3F7, 흰 외곽선 3px, 하단 12~18%(MarginV 300/1920),
 * 1~2줄·줄당 12~14자, 훅은 0~3초 상단 고정, 말풍선은 속마음용.
 */

import type { Config } from "./config.js";
import { totalDuration } from "./episode.js";
import type { Episode } from "./types.js";

export const HOOK_SECONDS = 3;
export const SUBTITLE_MARGIN_V = 300;
export const PUNCH_MARGIN_V = 430;

export function assColor(hex: string): string {
  const value = (hex ?? "").replace("#", "").trim();
  if (value.length !== 6) throw new Error(`색상은 #RRGGBB 형식이어야 합니다: ${hex}`);
  const bgr = `${value.slice(4, 6)}${value.slice(2, 4)}${value.slice(0, 2)}`.toUpperCase();
  return `&H00${bgr}`;
}

export function assTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const centis = Math.round(total * 100);
  const hours = Math.floor(centis / 360000);
  const minutes = Math.floor((centis % 360000) / 6000);
  const secs = Math.floor((centis % 6000) / 100);
  const cs = centis % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function srtTime(seconds: number): string {
  const millis = Math.round(Math.max(0, seconds) * 1000);
  const hours = Math.floor(millis / 3600000);
  const minutes = Math.floor((millis % 3600000) / 60000);
  const secs = Math.floor((millis % 60000) / 1000);
  const ms = millis % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

/** 공백 기준 줄바꿈. 한 단어가 최대 길이보다 길면 강제로 자릅니다. */
export function wrapCaption(text: string, maxChars = 14, maxLines = 2): string[] {
  const value = (text ?? "").trim();
  if (!value) return [];
  const lines: string[] = [];
  for (const rawLine of value.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.length <= maxChars) {
      lines.push(line);
      continue;
    }
    let current = "";
    for (const word of line.split(/\s+/)) {
      const chunks = splitLongWord(word, maxChars);
      for (const chunk of chunks) {
        const candidate = current ? `${current} ${chunk}` : chunk;
        if (candidate.length <= maxChars) {
          current = candidate;
        } else {
          if (current) lines.push(current);
          current = chunk;
        }
      }
    }
    if (current) lines.push(current);
  }
  if (lines.length > maxLines) {
    const head = lines.slice(0, maxLines - 1);
    const overflow = lines.slice(maxLines - 1).join(" ");
    head.push(overflow.length <= maxChars ? overflow : `${overflow.slice(0, Math.max(1, maxChars - 1))}…`);
    return head;
  }
  return lines;
}

function splitLongWord(word: string, maxChars: number): string[] {
  if (word.length <= maxChars) return [word];
  const parts: string[] = [];
  for (let index = 0; index < word.length; index += maxChars) {
    parts.push(word.slice(index, index + maxChars));
  }
  return parts;
}

function escapeText(text: string): string {
  return (text ?? "").replace(/\\/g, "\\\\").replace(/[{}]/g, (match) => (match === "{" ? "(" : ")")).replace(/\n/g, "\\N");
}

function styleLine(options: {
  name: string;
  font: string;
  size: number;
  primary: string;
  outline?: number;
  bold?: boolean;
  italic?: boolean;
  alignment?: number;
  marginV?: number;
  marginLR?: number;
}): string {
  const bold = options.bold === false ? 0 : -1;
  const italic = options.italic ? -1 : 0;
  return `Style: ${[
    options.name,
    options.font,
    String(options.size),
    options.primary,
    "&H000000FF",
    "&H00FFFFFF",
    "&H64000000",
    String(bold),
    String(italic),
    "0",
    "0",
    "100",
    "100",
    "0",
    "0",
    "1",
    String(options.outline ?? 3),
    "0",
    String(options.alignment ?? 2),
    String(options.marginLR ?? 90),
    String(options.marginLR ?? 90),
    String(options.marginV ?? SUBTITLE_MARGIN_V),
    "1",
  ].join(",")}`;
}

function header(config: Config, extraStyles: string[]): string[] {
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${config.renderWidth}`,
    `PlayResY: ${config.renderHeight}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...extraStyles,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
}

export function buildAss(episode: Episode, config: Config): string {
  const total = totalDuration(episode) || episode.targetDurationSec || 40;
  const girl = assColor(config.colorGirl);
  const boy = assColor(config.colorBoy);

  const lines = header(config, [
    styleLine({ name: "GF", font: config.subtitleFont, size: 74, primary: girl }),
    styleLine({ name: "BF", font: config.subtitleFont, size: 74, primary: boy }),
    styleLine({
      name: "Hook",
      font: config.hookFont,
      size: 52,
      primary: "&H00FFFFFF",
      outline: 4,
      bold: false,
      alignment: 8,
      marginV: 250,
      marginLR: 140,
    }),
    styleLine({
      name: "Bubble",
      font: config.subtitleFont,
      size: 46,
      primary: "&H00F2F2F2",
      outline: 3,
      bold: false,
      italic: true,
      alignment: 8,
      marginV: 760,
      marginLR: 120,
    }),
    styleLine({
      name: "Punch",
      font: config.subtitleFont,
      size: 92,
      primary: "&H00FFFFFF",
      outline: 5,
      alignment: 2,
      marginV: PUNCH_MARGIN_V,
    }),
    styleLine({ name: "Cover", font: config.hookFont, size: 84, primary: "&H00FFFFFF", outline: 5, alignment: 5, marginV: 0, marginLR: 110 }),
  ]);

  const events: Array<{ start: number; layer: number; line: string }> = [];
  const hookText = (episode.hook?.text ?? "").trim();
  if (hookText) {
    const hookLines = wrapCaption(hookText, 16, 2);
    events.push({
      start: 0,
      layer: 1,
      line: `Dialogue: 1,${assTime(0)},${assTime(Math.min(HOOK_SECONDS, total))},Hook,,0,0,0,,${escapeText(hookLines.join("\n"))}`,
    });
  }

  for (const cut of episode.cuts ?? []) {
    const style = cut.speaker === "GF" ? "GF" : "BF";
    const caption = (cut.caption ?? "").trim();
    if (caption) {
      events.push({
        start: cut.tStart,
        layer: 0,
        line: `Dialogue: 0,${assTime(cut.tStart)},${assTime(cut.tEnd)},${style},,0,0,0,,${escapeText(wrapCaption(caption).join("\n"))}`,
      });
    }
    if (cut.bubble && cut.bubble.trim()) {
      events.push({
        start: cut.tStart,
        layer: 0,
        line: `Dialogue: 0,${assTime(cut.tStart)},${assTime(cut.tEnd)},Bubble,,0,0,0,,${escapeText(cut.bubble.trim())}`,
      });
    }
  }

  const punch = (episode.punchline?.text ?? "").trim();
  if (punch) {
    const moment = episode.punchline?.t ?? Math.max(0, total - 2);
    events.push({
      start: moment,
      layer: 2,
      line: `Dialogue: 2,${assTime(moment)},${assTime(Math.min(total, moment + 2.4))},Punch,,0,0,0,,${escapeText(wrapCaption(punch, 12, 2).join("\n"))}`,
    });
  }

  events.sort((a, b) => a.start - b.start || a.layer - b.layer);
  return [...lines, ...events.map((event) => event.line)].join("\n") + "\n";
}

export function buildSrt(episode: Episode): string {
  const blocks: string[] = [];
  for (const cut of episode.cuts ?? []) {
    const caption = (cut.caption ?? "").trim();
    if (!caption) continue;
    blocks.push(`${blocks.length + 1}\n${srtTime(cut.tStart)} --> ${srtTime(cut.tEnd)}\n${caption}\n`);
  }
  const punch = (episode.punchline?.text ?? "").trim();
  if (punch) {
    const start = episode.punchline?.t ?? 0;
    blocks.push(`${blocks.length + 1}\n${srtTime(start)} --> ${srtTime(start + 2.4)}\n${punch}\n`);
  }
  return blocks.join("\n");
}

export function buildCoverAss(episode: Episode, config: Config): string {
  const hookText = (episode.hook?.text ?? "").trim();
  const lines = wrapCaption(hookText, 13, 3);
  return (
    [
      ...header(config, [
        styleLine({
          name: "Cover",
          font: config.hookFont,
          size: 86,
          primary: "&H00FFFFFF",
          outline: 6,
          alignment: 5,
          marginV: 0,
          marginLR: 100,
        }),
      ]),
      `Dialogue: 0,0:00:00.00,0:00:05.00,Cover,,0,0,0,,${escapeText(lines.join("\n"))}`,
    ].join("\n") + "\n"
  );
}

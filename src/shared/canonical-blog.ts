import type { StickerPlacement, StickerAnchor } from "./blog-stickers";
/** Inline canonical prose: only the existing bold, highlight, span and link grammar. */
export interface InlineStyle {
  color?: string;
  background?: string;
  weight?: number;
  size?: number;
}
export interface InlineRun {
  text: string;
  style: InlineStyle;
}
export interface CanonicalParagraph {
  id: string;
  source: string;
}
export interface CanonicalBundle {
  id: string;
  name: string;
  question: string;
  paragraphIds: string[];
}
export interface CanonicalFinding {
  sourceAtReview?: string;
  fresh?: boolean;
  id: string;
  axis?: string;
  severity?: string;
  observation: string;
  proposal?: {
    layer: string;
    tid?: string;
    before?: string;
    after?: string;
    op?: string;
    entry?: {
      id: string;
      phrase: string;
      style: { color?: string; bg?: string; weight?: number; size?: number };
    };
  };
  status?: string;
}
export interface CanonicalReview {
  emphasisDecisions?: import("./markup-review").MarkupReviewResult["reviews"][number]["emphasisDecisions"];
  visual?: import("./markup-review").MarkupReviewResult["reviews"][number]["visual"];
  visualFresh?: boolean;
  screenshots?: Array<{width:number;index:number}>;

  generatedAt?: string;
  provider?: string;
  requestId?: string;
  bundleId: string;
  summary: string;
  verdict: string;
  freshText: boolean;
  findings: CanonicalFinding[];
}
export interface CanonicalDocument {
  nativeClipboard?: boolean;
  stickers?: StickerPlacement[];
  stickerAnchors?: StickerAnchor[];
  savedAt?: string;
  format?: "markup";
  warnings?: string[];
  title: string;
  path: string;
  revision: string;
  paragraphs: CanonicalParagraph[];
  bundles: CanonicalBundle[];
  reviews: CanonicalReview[];
  frameVersion: string;
  fontCss?: string;
}
const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
export const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
export function cssColor(value: string): string | undefined {
  if (/^#[\da-f]{6}$/i.test(value)) return value.toLowerCase();
  const m = value.match(/^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/);
  if (!m || m.slice(1).some((v) => Number(v) > 255)) return undefined;
  return `rgb(${m.slice(1).map(Number).join(",")})`;
}
export function readInline(source: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const stack: InlineStyle[] = [{}];
  let bold = false,
    highlight = false;
  const token = /(<span\s+style="[^"]*">|<\/span>|\*\*|==)/g;
  let at = 0;
  const add = (text: string) => {
    if (text)
      runs.push({
        text,
        style: {
          ...stack[stack.length - 1],
          ...(bold ? { weight: 700 } : {}),
          ...(highlight ? { background: "rgb(255,248,178)" } : {}),
        },
      });
  };
  for (const m of source.matchAll(token)) {
    add(source.slice(at, m.index));
    at = m.index! + m[0].length;
    if (m[0] === "**") bold = !bold;
    else if (m[0] === "==") highlight = !highlight;
    else if (m[0] === "</span>") {
      if (stack.length === 1)
        throw new Error("닫는 span에 대응하는 서식이 없어요.");
      stack.pop();
    } else {
      const style = { ...stack[stack.length - 1] };
      for (const item of m[0].slice(13, -2).split(";")) {
        const [key, ...rest] = item.split(":");
        const value = rest.join(":").trim();
        if (key.trim() === "color" || key.trim() === "background-color") {
          const c = cssColor(value);
          if (!c) throw new Error("지원하지 않는 색상이에요.");
          style[key.trim() === "color" ? "color" : "background"] = c;
        } else if (key.trim() === "font-size") {
          const n = Number.parseFloat(value);
          if (!/^\d+(\.\d+)?(em|px)$/.test(value) || n <= 0)
            throw new Error("글자 크기를 확인해주세요.");
          style.size = value.endsWith("em") ? Math.round(n * 16) : n;
        } else if (key.trim() === "font-weight") {
          if (value === "700") style.weight = 700;
        } else if (key.trim()) throw new Error(`지원하지 않는 서식: ${key}`);
      }
      stack.push(style);
    }
  }
  add(source.slice(at));
  if (stack.length !== 1 || bold || highlight)
    throw new Error("강조 서식의 시작과 끝이 맞지 않아요.");
  return runs;
}
export function inlineSource(runs: InlineRun[]): string {
  return runs
    .map(({ text, style: s }) => {
      if (/[<>]/.test(text))
        throw new Error("본문에 HTML 태그를 직접 넣을 수 없어요.");
      let core = text;
      const css: string[] = [];
      if (s.background === "rgb(255,248,178)" || s.background === "#fff8b2")
        core = `==${core}==`;
      else if (s.background) css.push(`background-color:${s.background}`);
      if (s.weight === 700) core = `**${core}**`;
      if (s.color) css.push(`color:${s.color}`);
      if (s.size) css.push(`font-size:${(s.size / 16).toFixed(2)}em`);
      return css.length
        ? `<span style="${css.join(";")}">${core}</span>`
        : core;
    })
    .join("");
}
export function inlineHtml(source: string): string {
  return readInline(source)
    .map(({ text, style: s }) => {
      const css = [
        s.color && `color:${s.color}`,
        s.background && `background-color:${s.background}`,
        s.weight && `font-weight:${s.weight}`,
        s.size && `font-size:${s.size}px`,
      ]
        .filter(Boolean)
        .join(";");
      let body = escapeHtml(text).replace(/\n/g, "<br>");
      body = body.replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        (_, label, url) => `<a href="${url}">${label}</a>`,
      );
      return css ? `<span style="${css}">${body}</span>` : body;
    })
    .join("");
}
export function restyle(
  source: string,
  start: number,
  end: number,
  style: InlineStyle,
  clear = false,
): string {
  let at = 0;
  const out: InlineRun[] = [];
  for (const run of readInline(source)) {
    const lo = Math.max(0, start - at),
      hi = Math.min(run.text.length, end - at);
    if (lo < hi) {
      if (lo) out.push({ ...run, text: run.text.slice(0, lo) });
      out.push({
        text: run.text.slice(lo, hi),
        style: clear ? {} : { ...run.style, ...style },
      });
      if (hi < run.text.length) out.push({ ...run, text: run.text.slice(hi) });
    } else out.push(run);
    at += run.text.length;
  }
  return inlineSource(out);
}

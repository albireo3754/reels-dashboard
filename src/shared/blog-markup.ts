import { replaceStickers, stickerPlan } from "./blog-stickers";
import { parseDocument } from "yaml";
/**
 * 블로그 리뷰 마크업 (blog-markup v1)
 *
 * 블로그 초안을 모델과 사람이 함께 읽는 텍스트 표현이다. 이 파일 하나가
 * ① 표기 가이드, ② 어휘(컴포넌트·색 이름·글자 크기 단계), ③ 파서·직렬화·검사기다.
 * 리뷰 요청, 미리보기 뷰, 렌더링 엔진이 같은 정의를 import 해서 쓴다.
 *
 * ## 원칙
 * 1. 문장은 원문 그대로 둔다. 줄바꿈·부호·띄어쓰기를 바꾸지 않고, 문장을 props나 조각으로 쪼개지 않는다.
 *    말투·끝맺음 리뷰는 연속된 문장을 읽어야 하기 때문이다.
 * 2. 컴포넌트는 한 줄 태그다. SmartEditor 컴포넌트와 1:1로 대응하는 것만 둔다(COMPONENTS).
 * 3. 강조는 `⟦구절⟧¹`처럼 문장 안에서 티만 내고, 서식은 문단 아래 각주로 내린다.
 *    서식은 rgb 대신 이름(DEFAULT_PALETTE)과 크기 토큰(SIZE_ROLES)으로 쓴다.
 * 4. 묶음(한 경험·질문을 완성하는 단위)은 `<Bundle>`로 감싸고 질문을 속성으로 붙인다.
 * 5. 화면 폭에 따라 달라지는 판단(자동 줄바꿈 위치)은 넣지 않는다. 폭과 무관한 사실만 `※` 메모로 붙인다.
 * 6. 마크업 .md가 원본이다. 문장은 사용자가, 서식·구조는 에이전트·편집기가 고치며 에이전트 저장은 글만 비교 가드를 통과해야 한다. 범례와 ※ 메모는 파생 정보다.
 *
 * ## 문법 (줄 단위)
 * ```
 * <!-- 주석: 파서가 무시한다. 범례는 view에서만 앞에 붙인다 -->
 * <Bundle id="B02" name="대기" core question="들어가기까지 얼마나 기다렸나" in="자리 모양 → 앉기까지">
 * <Photo file="interior.jpg" alt="손님이 가득한 실내"/>
 *
 * ¶ P3
 * 줄이 길어서
 * ⟦40분 정도⟧¹ 기다렸는데
 * 창가 자리가 나서 ⟦완전 럭키!!⟧²
 *   ¹ 적갈 굵게 · 대기 시간
 *   ² 노랑배경 · 착석 결과
 *   ※ 3번째 줄 16자
 *
 * <PriceBox>
 * ¶ P4
 * 아메리카노 ⟦5,000원⟧¹
 *   ¹ 적갈 굵게 · 가격
 * </PriceBox>
 * <Heading>디저트</Heading>
 * </Bundle>
 * ```
 * - `¶ id` 다음 줄부터 빈 줄 전까지가 문단 텍스트다. 각주(`  ¹ …`)와 메모(`  ※ …`)는 두 칸 들여쓰기로 시작한다.
 * - 각주 형식: `  {번호} {서식 토큰…} · {역할}`. 서식 토큰: 색·배경 이름 | `굵게` | 크기(`up19`, `down13`, `크기19`)
 *   | 이름 없는 색 `색#a1b2c3` / `배경#fff8b2`.
 * - 태그 속성은 `key="value"`, 값 안의 `"`는 `&quot;`, `&`는 `&amp;`. 값 없는 속성(`core`)은 true.
 * - 한 줄에 강조가 여러 개면 번호가 다르다. 강조끼리 겹치거나 중첩되지 않는다.
 * - COMPONENTS에 없는 태그 줄은 오류가 아니다. 원문 줄 그대로 보존하고(UnknownNode) 화면에는 원문을 보여 준다.
 */

export const BLOG_MARKUP_VERSION = 1 as const;

// ─── 글자 크기 ───────────────────────────────────────────────────────────────

/** SmartEditor 글자 크기 메뉴(se-fs-fsN). 이 값만 이관된다. 출처: 네이버 뷰어 CSS @se/product-basic v1.78.1. */
export const SE_FONT_STEPS = [11, 13, 15, 16, 19, 24, 26, 28, 30, 32, 34, 38, 45] as const;
export type SeFontStep = (typeof SE_FONT_STEPS)[number];

export type SizeRole = "up" | "strong-up" | "title" | "down" | "aside";

/**
 * 크기로 하는 강조의 역할. 기준 본문은 16px.
 * 근거는 레퍼런스 블로그 두 편의 관찰(본문 15px 기준 19px·13px·11px·38px)이며 개수·비율 목표가 아니다.
 */
export const SIZE_ROLES: Record<SizeRole, { px: SeFontStep; use: string; basis: string }> = {
  up: { px: 19, use: "첫 화면 장소명, 카드·박스 제목, 묶음에서 가장 센 감탄 한 줄", basis: "레퍼런스 A: 본문 15 대비 19px(1.27배) 7곳, 모두 굵게와 함께" },
  "strong-up": { px: 24, use: "up으로 부족할 때만, 글 전체에서 한두 번", basis: "관찰 없음. 19와 38 사이 단계" },
  title: { px: 30, use: "글 위쪽 가게 이름 한 번. 글 제목과 겹치면 쓰지 않음", basis: "레퍼런스 B: 38px(2.53배) 1곳" },
  down: { px: 13, use: "출처·확인일·부가 정보", basis: "레퍼런스 A: 13px(0.87배)" },
  aside: { px: 13, use: "괄호 혼잣말·사진 곁말·속마음 한 줄", basis: "레퍼런스 B: 11px(0.73배) 14줄. 11은 모바일에서도 13이라 13을 기본으로" },
};

/** 가운데 정렬 17px 본문, 좌우 여백 20px, 360px 폭에서 한 줄에 들어가는 글자 수(공백 포함) 실측. */
export const PHONE_LINE_CHARS = 24;

// ─── 색 이름 ────────────────────────────────────────────────────────────────

export interface PaletteEntry {
  name: string;
  kind: "color" | "background";
  hex: string;
  use: string;
}

/** 색은 역할로 이름 붙인다. 같은 역할은 글 전체에서 같은 색. */
export const DEFAULT_PALETTE: readonly PaletteEntry[] = [
  { name: "적갈", kind: "color", hex: "#a64132", use: "추천 문구·대기 시간·핵심 경험·총액" },
  { name: "갈색", kind: "color", hex: "#85613f", use: "메뉴명" },
  { name: "하늘", kind: "color", hex: "#0096dc", use: "장소·방문 시각" },
  { name: "초록", kind: "color", hex: "#54b800", use: "재방문 의사" },
  { name: "노랑배경", kind: "background", hex: "#fff8b2", use: "가장 센 감상·결과" },
  { name: "살구배경", kind: "background", hex: "#ffe3c8", use: "맛 감상·동행 취향" },
];

// ─── 컴포넌트 ───────────────────────────────────────────────────────────────

export type ComponentTag =
  | "Photo" | "Collage" | "Heading" | "Title" | "PriceBox" | "VisitCard" | "Info" | "Source"
  | "Divider" | "Map" | "QuestionCard" | "Tags" | "Sticker";

export interface ComponentSpec {
  /** 대응하는 SmartEditor 컴포넌트(se-* 클래스). */
  smartEditor: string;
  /** tools/blog-preview 쪽 컴포넌트 이름. */
  preview: string;
  /** BlogDraft 블록으로 옮길 때의 모양. null이면 대응 블록 없음(옮기면 사라짐). */
  draft: string | null;
  /** self: 한 줄 자기 닫기, text: 한 줄 텍스트, container: 여는 줄과 닫는 줄 사이에 문단. */
  form: "self" | "text" | "container";
  attrs: readonly string[];
  example: string;
}

export const COMPONENTS: Record<ComponentTag, ComponentSpec> = {
  Sticker: { smartEditor: "se-sticker (기본 스티커에서 직접 선택)", preview: "StickerSlot (자리 표시)", draft: null, form: "self", attrs: ["id", "preset", "note?"], example: '<Sticker id="s1" preset="yum" note="기본 · 먹고 만족하는 표정"/>' },
  Photo: { smartEditor: "se-image", preview: "PhotoBlock", draft: "image", form: "self", attrs: ["file", "alt", "ratio?", "pair?"], example: '<Photo file="grill.jpg" alt="그릴에서 굽는 모습"/>' },
  Collage: { smartEditor: "se-imageGroup se-l-collage", preview: "PhotoCollage4", draft: "image (합성 한 장, 개별 사진 정보 손실)", form: "self", attrs: ["layout", "files", "alts?", "ratios?"], example: '<Collage layout="2x2" files="a.jpg · b.jpg · c.jpg · d.jpg" ratios="3:4 · 4:3 · 4:3 · 4:3"/>' },
  Heading: { smartEditor: "se-quotation se-l-quotation_line", preview: "SectionHeading", draft: "text role=heading", form: "text", attrs: [], example: "<Heading>디저트</Heading>" },
  Title: { smartEditor: "se-documentTitle", preview: "BlogArticle header", draft: "text role=title", form: "text", attrs: [], example: "<Title>동네 카페 후기</Title>" },
  PriceBox: { smartEditor: "se-quotation", preview: "price-box", draft: "text role=info", form: "container", attrs: [], example: "<PriceBox> … </PriceBox>" },
  VisitCard: { smartEditor: "se-text (정보 글꼴) 또는 se-table", preview: "VisitInfoCard", draft: "text role=info + source", form: "container", attrs: [], example: "<VisitCard> … </VisitCard>" },
  Info: { smartEditor: "se-text (정보 글꼴)", preview: "StoryParagraph info", draft: "text role=info", form: "container", attrs: [], example: "<Info> … </Info>" },
  Source: { smartEditor: "se-text (작은 글자)", preview: "SourceNote", draft: "text role=source", form: "container", attrs: [], example: "<Source> … </Source>" },
  Divider: { smartEditor: "se-horizontalLine", preview: "SceneDivider", draft: null, form: "self", attrs: [], example: "<Divider/>" },
  Map: { smartEditor: "se-placesMap", preview: "NativeCard", draft: "text role=native", form: "self", attrs: ["place", "href?"], example: '<Map place="가게 이름"/>' },
  QuestionCard: { smartEditor: "블로그씨 질문 카드(네이버 전용)", preview: "NativeCard", draft: "text role=native", form: "self", attrs: ["topic?"], example: '<QuestionCard topic="야장"/>' },
  Tags: { smartEditor: "태그 입력란(본문 밖)", preview: "TagList", draft: "text role=tags", form: "text", attrs: [], example: "<Tags>#카페 #디저트</Tags>" },
};

// ─── AST ────────────────────────────────────────────────────────────────────

export interface MarkStyle {
  color?: string; // #rrggbb
  background?: string; // #rrggbb
  weight?: 700;
  size?: number; // px, SE_FONT_STEPS 권장
  sizeRole?: SizeRole;
}

/** 문단 한 줄 안의 강조. start/end는 그 줄의 UTF-16 오프셋(end 미포함). */
export interface Mark {
  n: number;
  line: number;
  start: number;
  end: number;
  style: MarkStyle;
  role?: string;
}

export interface ParagraphNode {
  kind: "paragraph";
  id: string;
  lines: string[];
  marks: Mark[];
  notes: string[];
}

export interface ComponentNode {
  kind: "component";
  tag: ComponentTag;
  attrs: Record<string, string | true>;
  text?: string;
  children?: ParagraphNode[];
}

/**
 * 이 버전의 COMPONENTS에 없는 태그 한 줄. 문서를 막지 않고 원문 줄을 그대로 보존한다.
 * 여는 줄과 닫는 줄은 각각 한 노드가 되고, 그 사이 문단은 묶음의 본문 문단으로 읽는다.
 */
export interface UnknownNode {
  kind: "unknown";
  tag: string;
  source: string;
  /** 항상 비어 있다. 문단이 아닌 노드의 text·children을 훑는 코드가 분기 없이 지나가게 한다. */
  text?: undefined;
  children?: undefined;
}

export type MarkupNode = ParagraphNode | ComponentNode | UnknownNode;

export interface MarkupBundle {
  id: string;
  name: string;
  question: string;
  core: boolean;
  transitionIn?: string;
  nodes: MarkupNode[];
}

export interface MarkupDoc {
  version: typeof BLOG_MARKUP_VERSION;
  bundles: MarkupBundle[];
  metadata?: Record<string, unknown>;
  /** Original YAML retained for comments and key order. */
  frontmatter?: string;
}

/** Paragraphs of a bundle in order, including those nested in components. */
export const bundleParagraphs = (bundle: MarkupBundle): ParagraphNode[] =>
  bundle.nodes.flatMap((n) => (n.kind === "paragraph" ? [n] : n.kind === "component" ? n.children ?? [] : []));

// ─── 서식 토큰 ──────────────────────────────────────────────────────────────

const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const toSup = (n: number) => String(n).split("").map((d) => SUP[Number(d)]).join("");
const fromSup = (s: string) => Number(s.split("").map((c) => SUP.indexOf(c)).join(""));
const SUP_RE = `[${SUP}]+`;
const NUM_RE = `(?:${SUP_RE}|\\^[0-9]+)`;
const readNumber = (s: string) => s.startsWith("^") ? Number(s.slice(1)) : fromSup(s);

export function styleTokens(style: MarkStyle, palette: readonly PaletteEntry[] = DEFAULT_PALETTE): string[] {
  const out: string[] = [];
  const named = (hex: string, kind: PaletteEntry["kind"]) =>
    palette.find((p) => p.kind === kind && p.hex.toLowerCase() === hex.toLowerCase())?.name;
  if (style.color) out.push(named(style.color, "color") ?? `색${style.color.toLowerCase()}`);
  if (style.background) out.push(named(style.background, "background") ?? `배경${style.background.toLowerCase()}`);
  if (style.weight === 700) out.push("굵게");
  if (style.size) out.push(style.sizeRole ? `${style.sizeRole}${style.size}` : `크기${style.size}`);
  return out;
}

export function parseStyleTokens(tokens: string[], palette: readonly PaletteEntry[] = DEFAULT_PALETTE): MarkStyle {
  const style: MarkStyle = {};
  for (const t of tokens) {
    const p = palette.find((e) => e.name === t);
    let m: RegExpMatchArray | null;
    if (p) style[p.kind === "color" ? "color" : "background"] = p.hex;
    else if (t === "굵게") style.weight = 700;
    else if ((m = t.match(/^색(#[\da-f]{6})$/i))) style.color = m[1].toLowerCase();
    else if ((m = t.match(/^배경(#[\da-f]{6})$/i))) style.background = m[1].toLowerCase();
    else if ((m = t.match(/^크기(\d+)$/))) style.size = Number(m[1]);
    else if ((m = t.match(/^(up|strong-up|title|down|aside)(\d+)$/))) {
      style.sizeRole = m[1] as SizeRole;
      style.size = Number(m[2]);
    } else throw new Error(`모르는 서식 토큰: ${t}`);
  }
  return style;
}

// ─── 직렬화 ─────────────────────────────────────────────────────────────────

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const unesc = (v: string) => v.replace(/&quot;/g, '"').replace(/&amp;/g, "&");

function attrString(attrs: Record<string, string | true>): string {
  return Object.entries(attrs).map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${esc(v)}"`)).join("");
}

function markLine(text: string, marks: Mark[]): string {
  let out = "";
  let at = 0;
  for (const m of [...marks].sort((a, b) => a.start - b.start)) {
    out += text.slice(at, m.start) + "⟦" + text.slice(m.start, m.end) + "⟧" + toSup(m.n);
    at = m.end;
  }
  return out + text.slice(at);
}

function paragraphLines(p: ParagraphNode, palette: readonly PaletteEntry[]): string[] {
  const out = [`¶ ${p.id}`];
  p.lines.forEach((text, i) => out.push(markLine(text, p.marks.filter((m) => m.line === i))));
  for (const m of [...p.marks].sort((a, b) => a.n - b.n)) {
    out.push(`  ${toSup(m.n)} ${styleTokens(m.style, palette).join(" ")}${m.role ? ` · ${m.role}` : ""}`);
  }

  return out;
}

export function legend(palette: readonly PaletteEntry[] = DEFAULT_PALETTE): string {
  const colors = palette.map((p) => `${p.name}=${p.hex}(${p.use})`).join(", ");
  const sizes = (Object.keys(SIZE_ROLES) as SizeRole[]).map((r) => `${r}${SIZE_ROLES[r].px}=${SIZE_ROLES[r].use}`).join(", ");
  return [
    `<!-- blog-markup v${BLOG_MARKUP_VERSION}`,
    `문장은 원문 그대로. ⟦구절⟧번호 = 강조, 문단 아래 각주 = 서식 · 역할, ※ = 폭과 무관한 사실.`,
    `색: ${colors}`,
    `크기(본문 16, SmartEditor ${SE_FONT_STEPS.join("·")}만 가능): ${sizes}`,
    `-->`,
  ].join("\n");
}

export function serialize(doc: MarkupDoc, opts: { palette?: readonly PaletteEntry[]; legend?: boolean } = {}): string {
  const palette = opts.palette ?? DEFAULT_PALETTE;
  const out: string[] = [];
  if (doc.metadata) {
    const yaml = parseDocument(doc.frontmatter ?? "");
    for (const key of [...((yaml.toJSON() && Object.keys(yaml.toJSON())) || [])])
      if (!(key in doc.metadata)) yaml.delete(key);
    for (const [key, value] of Object.entries(doc.metadata))
      if (JSON.stringify(yaml.toJSON()?.[key]) !== JSON.stringify(value)) yaml.set(key, value);
    out.push("---", String(yaml).trimEnd(), "---", "");
  }
  if (opts.legend ?? false) out.push(legend(palette), "");
  for (const b of doc.bundles) {
    const attrs: Record<string, string | true> = { id: b.id, name: b.name };
    if (b.core) attrs.core = true;
    attrs.question = b.question;
    if (b.transitionIn) attrs.in = b.transitionIn;
    out.push(`<Bundle${attrString(attrs)}>`);
    for (const n of b.nodes) {
      if (n.kind === "paragraph") {
        out.push("", ...paragraphLines(n, palette), "");
        continue;
      }
      if (n.kind === "unknown") {
        out.push(n.source);
        continue;
      }
      const form = COMPONENTS[n.tag].form;
      if (form === "self") out.push(`<${n.tag}${attrString(n.attrs)}/>`);
      else if (form === "text") out.push(`<${n.tag}${attrString(n.attrs)}>${n.text ?? ""}</${n.tag}>`);
      else {
        out.push(`<${n.tag}${attrString(n.attrs)}>`);
        for (const c of n.children ?? []) out.push(...paragraphLines(c, palette), "");
        if (out[out.length - 1] === "") out.pop();
        out.push(`</${n.tag}>`);
      }
    }
    if (out[out.length - 1] === "") out.pop();
    out.push("</Bundle>", "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

// ─── 파서 ───────────────────────────────────────────────────────────────────

/** 강조의 기준 순서는 읽는 순서(줄 → 줄 안 위치)다. 각주 번호 순서와 다를 수 있다. */
export function sortMarks(marks: Mark[]): Mark[] {
  return marks.sort((a, b) => a.line - b.line || a.start - b.start);
}

export class MarkupParseError extends Error {
  constructor(readonly line: number, message: string) {
    super(`${line}행: ${message}`);
  }
}

function parseAttrs(src: string): Record<string, string | true> {
  const attrs: Record<string, string | true> = {};
  let rest = src;
  while (rest.trim()) {
    const m = rest.match(/^\s+([\w-]+)(?:="([^"]*)")?(?=\s|$)/);
    if (!m || m[1] in attrs) throw new Error("잘못되거나 중복된 속성");
    attrs[m[1]] = m[2] === undefined ? true : unesc(m[2]);
    rest = rest.slice(m[0].length);
  }
  return attrs;
}

const isTag = (t: string): t is ComponentTag => Object.prototype.hasOwnProperty.call(COMPONENTS, t);

function parseMarkedLine(src: string, lineIndex: number): { text: string; marks: Omit<Mark, "style" | "role">[] } {
  const marks: Omit<Mark, "style" | "role">[] = [];
  let text = "";
  const re = new RegExp(`⟦([^⟦⟧]*)⟧(${NUM_RE})`, "g");
  let at = 0;
  for (const m of src.matchAll(re)) {
    text += src.slice(at, m.index);
    const start = text.length;
    text += m[1];
    marks.push({ n: readNumber(m[2]), line: lineIndex, start, end: text.length });
    at = (m.index ?? 0) + m[0].length;
  }
  text += src.slice(at);
  if (/[⟦⟧]/.test(text)) throw new Error("짝이 맞지 않거나 번호 없는 ⟦⟧");
  return { text, marks };
}

export function parse(source: string, opts: { palette?: readonly PaletteEntry[] } = {}): MarkupDoc {
  const palette = opts.palette ?? DEFAULT_PALETTE;
  const header = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  let metadata: Record<string, unknown> | undefined;
  if (header) {
    const yaml = parseDocument(header[1]);
    if (yaml.errors.length) throw new Error(yaml.errors.map(e => e.message).join("; "));
    metadata = yaml.toJSON();
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || metadata.markup !== 1)
      throw new Error("frontmatter requires markup: 1");
    source = source.slice(header[0].length);
  }
  const lines = source.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, "")).split("\n");
  const doc: MarkupDoc = { version: BLOG_MARKUP_VERSION, bundles: [] };
  if (metadata) { doc.metadata = metadata; doc.frontmatter = header![1]; }
  let bundle: MarkupBundle | null = null;
  let container: ComponentNode | null = null;
  let para: ParagraphNode | null = null;
  let annotated = false; // 이 문단에서 각주·메모가 시작됐는가(이후 텍스트 줄은 오류)
  const pending = new Map<number, Omit<Mark, "style" | "role">>();

  const closePara = (ln: number) => {
    if (!para) return;
    if (pending.size) throw new MarkupParseError(ln, `각주 없는 강조 ${[...pending.keys()].join(", ")} (${para.id})`);
    sortMarks(para.marks);
    para = null;
    annotated = false;
  };
  const target = () => (container ? (container.children ??= []) : bundle!.nodes);

  lines.forEach((raw, i) => {
    const ln = i + 1;
    const line = raw.replace(/\s+$/, "");
    let m: RegExpMatchArray | null;
    try {
      if (para && (m = line.match(new RegExp(`^  (${NUM_RE}) (.*)$`)))) {
        const n = readNumber(m[1]);
        const base = pending.get(n);
        if (!base) throw new Error(`본문에 없는 각주 번호 ${n}`);
        const [tok, ...role] = m[2].split(" · ");
        para.marks.push({ ...base, style: parseStyleTokens(tok.split(" ").filter(Boolean), palette), ...(role.length ? { role: role.join(" · ") } : {}) });
        pending.delete(n);
        annotated = true;
        return;
      }
      if (para && (m = line.match(/^  ※ (.*)$/))) {
        para.notes.push(m[1]);
        annotated = true;
        return;
      }
      if (line === "") return closePara(ln);
      if ((m = line.match(/^<Bundle(.*)>$/))) {
        if (bundle) throw new Error("Bundle 안에 Bundle");
        const a = parseAttrs(m[1]);
        if (typeof a.id !== "string" || typeof a.name !== "string") throw new Error("Bundle에는 id와 name이 필요");
        bundle = { id: a.id, name: a.name, question: typeof a.question === "string" ? a.question : "", core: a.core === true, nodes: [] };
        if (typeof a.in === "string") bundle.transitionIn = a.in;
        doc.bundles.push(bundle);
        return;
      }
      if (line === "</Bundle>") {
        closePara(ln);
        if (!bundle || container) throw new Error("닫을 Bundle이 없거나 컨테이너가 열려 있음");
        bundle = null;
        return;
      }
      if (!bundle) throw new Error("Bundle 밖의 내용");
      if ((m = line.match(/^¶ (\S+)$/))) {
        closePara(ln);
        para = { kind: "paragraph", id: m[1], lines: [], marks: [], notes: [] };
        target().push(para);
        return;
      }
      if ((m = line.match(/^<\/(\w+)>$/))) {
        closePara(ln);
        if (!container && !isTag(m[1])) {
          bundle.nodes.push({ kind: "unknown", tag: m[1], source: line });
          return;
        }
        if (!container || container.tag !== m[1]) throw new Error(`열지 않은 </${m[1]}>`);
        container = null;
        return;
      }
      if ((m = line.match(/^<(\w+)(.*?)\/>$/)) || (m = line.match(/^<(\w+)([^>]*)>(.*)<\/(\w+)>$/)) || (m = line.match(/^<(\w+)([^>]*)>$/))) {
        closePara(ln);
        const tag = m[1];
        if (!isTag(tag)) {
          // 새 버전에서 쓴 태그일 수 있다. 문서를 막지 않고 원문 줄로 보존한다.
          if (container) throw new Error(`컨테이너 <${container.tag}> 안에는 문단만 (모르는 컴포넌트 <${tag}>)`);
          bundle.nodes.push({ kind: "unknown", tag, source: line });
          return;
        }
        const form = COMPONENTS[tag].form;
        const node: ComponentNode = { kind: "component", tag, attrs: parseAttrs(m[2]) };
        if (line.endsWith("/>")) {
          if (form !== "self") throw new Error(`<${tag}>는 ${form} 형식`);
        } else if (m[4] !== undefined) {
          if (form !== "text" || m[4] !== tag) throw new Error(`<${tag}>는 ${form} 형식`);
          node.text = m[3];
        } else {
          if (form !== "container" || container) throw new Error(`<${tag}>는 ${form} 형식이거나 컨테이너 중첩`);
          node.children = [];
          bundle.nodes.push(node);
          container = node;
          return;
        }
        if (container) throw new Error(`컨테이너 <${container.tag}> 안에는 문단만`);
        bundle.nodes.push(node);
        return;
      }
      if (!para) throw new Error("¶ 없이 시작한 텍스트");
      if (annotated) throw new Error("각주·메모 뒤에 텍스트 줄 — 문단을 빈 줄로 끝내고 새 ¶로 시작");
      // 텍스트는 줄 끝 공백까지 원문 그대로 둔다(구조 판단에만 공백을 뺀 줄을 쓴다).
      const { text, marks } = parseMarkedLine(raw.replace(/\r$/, ""), para.lines.length);
      for (const mk of marks) {
        if (pending.has(mk.n) || para.marks.some((x) => x.n === mk.n)) throw new Error(`강조 번호 ${mk.n} 중복`);
        pending.set(mk.n, mk);
      }
      para.lines.push(text);
    } catch (e) {
      if (e instanceof MarkupParseError) throw e;
      throw new MarkupParseError(ln, (e as Error).message);
    }
  });
  closePara(lines.length);
  if (bundle || container) throw new MarkupParseError(lines.length, "닫히지 않은 Bundle 또는 컨테이너");
  return doc;
}

// ─── 검사 ───────────────────────────────────────────────────────────────────

export interface MarkupIssue {
  level: "error" | "warn" | "fact";
  where: string;
  message: string;
}

export interface ValidateOptions {
  /** 본문 글꼴에 굵은 파일이 없으면(예: 나눔바른히피) 굵게 단독 강조는 화면에서 거의 안 보인다. */
  bodyFontHasBold?: boolean;
  phoneLineChars?: number;
  bodyPx?: number;
}

type Located = { bundle: MarkupBundle; p: ParagraphNode; body: boolean };

function paragraphs(doc: MarkupDoc): Located[] {
  return doc.bundles.flatMap((bundle) =>
    bundle.nodes.flatMap((n): Located[] =>
      n.kind === "paragraph" ? [{ bundle, p: n, body: true }] : n.kind === "component" ? (n.children ?? []).map((p) => ({ bundle, p, body: false })) : [],
    ),
  );
}

/** Photos per row. "2x2" is columns x rows, "2+1" lists each row. Unknown layouts fall back to rows of two. */
export function collageRows(layout: string, count: number): number[] {
  const plus = /^\d+(\+\d+)+$/.test(layout) ? layout.split("+").map(Number) : null;
  if (plus && plus.every((n) => n > 0)) return plus;
  const columns = Math.max(1, Number(/^(\d+)x\d+$/.exec(layout)?.[1] ?? 2));
  const rows: number[] = [];
  for (let left = count; left > 0; left -= columns) rows.push(Math.min(columns, left));
  return rows;
}

/** Width / height of each photo in a mixed-ratio collage; null when the attribute is absent or malformed. */
export function collageRatios(value: unknown, count: number): number[] | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parts = value.split(" · ").map((p) => /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(p.trim()));
  if (parts.length !== count || parts.some((p) => !p || !Number(p[1]) || !Number(p[2]))) return null;
  return parts.map((p) => Number(p![1]) / Number(p![2]));
}

/**
 * 폭과 무관하게 판정할 수 있는 것만 본다. 강조 개수·비율에는 목표를 두지 않는다.
 * 줄 길이와 굵게 단독 검사는 본문 문단에만 한다. 컨테이너(PriceBox·VisitCard·Info·Source) 안은 정보 글꼴과 다른 폭을 쓴다.
 */
export function validate(doc: MarkupDoc, opts: ValidateOptions = {}): MarkupIssue[] {
  const { bodyFontHasBold = false, phoneLineChars = PHONE_LINE_CHARS, bodyPx = 16 } = opts;
  const issues: MarkupIssue[] = [];
  try { replaceStickers(structuredClone(doc), stickerPlan(doc)); }
  catch (error) { issues.push({ level: "error", where: "Sticker", message: String(error) }); }
  const ids = new Set<string>();
  for (const b of doc.bundles) {
    if (ids.has(b.id)) issues.push({ level: "error", where: b.id, message: "묶음 id 중복" });
    ids.add(b.id);
    if (!b.question) issues.push({ level: "warn", where: b.id, message: "묶음 질문이 비어 있음" });
    for (const n of b.nodes) {
      if (n.kind === "component" && n.tag === "Photo" && !n.attrs.alt) issues.push({ level: "warn", where: b.id, message: `사진 alt 없음: ${n.attrs.file}` });
      if (n.kind === "component" && n.tag === "Collage" && n.attrs.ratios !== undefined) {
        const count = String(n.attrs.files ?? "").split(" · ").length;
        const layout = String(n.attrs.layout ?? "");
        if (!collageRatios(n.attrs.ratios, count)) issues.push({ level: "error", where: b.id, message: `Collage ratios는 사진 ${count}장마다 "가로:세로"를 " · "로 구분해 적음: ${n.attrs.ratios}` });
        if (collageRows(layout, count).reduce((a, c) => a + c, 0) !== count) issues.push({ level: "error", where: b.id, message: `Collage layout ${layout}의 칸 수가 사진 ${count}장과 다름` });
      }
      if (n.kind === "unknown") issues.push({ level: "warn", where: b.id, message: `모르는 컴포넌트 <${n.tag}> — 원문 줄만 보여 주고 그대로 보존함` });
    }
  }
  const pids = new Set<string>();
  for (const { bundle, p, body } of paragraphs(doc)) {
    const where = `${bundle.id}/${p.id}`;
    if (pids.has(p.id)) issues.push({ level: "error", where, message: "문단 id 중복" });
    pids.add(p.id);
    p.lines.forEach((text, i) => {
      if (body && [...text.trimEnd()].length > phoneLineChars) issues.push({ level: "fact", where, message: `${i + 1}번째 줄 ${[...text].length}자, 폰 한 줄(${phoneLineChars}자)보다 김 — 어디서 접힐지는 기기마다 다름` });
      const ms = p.marks.filter((m) => m.line === i).sort((a, b) => a.start - b.start);
      ms.forEach((m, k) => {
        if (m.start < 0 || m.end > text.length || m.start >= m.end) issues.push({ level: "error", where, message: `강조 ${m.n} 범위가 줄 밖` });
        if (k && ms[k - 1].end > m.start) issues.push({ level: "error", where, message: `강조 ${ms[k - 1].n}·${m.n} 겹침` });
      });
    });
    for (const m of p.marks) {
      const s = m.style;
      const phrase = p.lines[m.line]?.slice(m.start, m.end) ?? "";
      if (s.size !== undefined) {
        if (!(SE_FONT_STEPS as readonly number[]).includes(s.size)) {
          const lo = [...SE_FONT_STEPS].reverse().find((x) => x < s.size!);
          const hi = SE_FONT_STEPS.find((x) => x > s.size!);
          issues.push({ level: "error", where, message: `“${phrase}” ${s.size}px은 SmartEditor에 없음 → 아래 ${lo ?? "-"} / 위 ${hi ?? "-"}` });
        }
        if (!s.sizeRole) issues.push({ level: "warn", where, message: `“${phrase}” 크기 역할(sizeRole) 없음` });
        else if ((s.sizeRole === "down" || s.sizeRole === "aside") !== s.size < bodyPx)
          issues.push({ level: "warn", where, message: `“${phrase}” 역할 ${s.sizeRole}와 ${s.size}px 방향이 다름` });
      }
      if (body && !bodyFontHasBold && s.weight === 700 && !s.color && !s.background && !s.size)
        issues.push({ level: "warn", where, message: `“${phrase}” 굵게 단독 — 본문 글꼴에 굵은 파일이 없어 거의 안 보임` });
      if (!m.role) issues.push({ level: "warn", where, message: `“${phrase}” 강조 역할 없음` });
    }
  }
  return issues;
}

// ─── BlogDraft에서 만들기 ───────────────────────────────────────────────────

/** BlogDraft와 구조만 맞춘 최소 타입. shared/blog.ts의 blogDraft를 그대로 넘길 수 있다. */
export interface DraftLike {
  blocks: (
    | { id: string; type: "text"; text: string; role?: string; spans?: { text: string; color?: string; background?: string; weight?: number; occurrence?: "first" | "all" }[] }
    | { id: string; type: "image"; path: string; alt: string }
  )[];
  reviewGroups?: { id: string; startBlockId: string; name: string; question: string }[];
}

const ROLE_TAG: Record<string, ComponentTag | undefined> = { heading: "Heading", title: "Title", info: "Info", source: "Source", tags: "Tags" };

/**
 * BlogDraft → 마크업. 묶음 경계는 reviewGroups(시작 블록)만 따른다.
 * 반환하는 lost에는 마크업으로 옮기지 못한 정보를 적는다.
 */
export function fromDraft(draft: DraftLike): { doc: MarkupDoc; lost: string[] } {
  const lost: string[] = [];
  const starts = new Map((draft.reviewGroups ?? []).map((g) => [g.startBlockId, g]));
  const doc: MarkupDoc = { version: BLOG_MARKUP_VERSION, bundles: [] };
  for (const block of draft.blocks) {
    const g = starts.get(block.id);
    if (g || !doc.bundles.length)
      doc.bundles.push({ id: g?.id ?? `bundle:${block.id}`, name: g?.name ?? "첫 묶음", question: g?.question ?? "", core: false, nodes: [] });
    const bundle = doc.bundles[doc.bundles.length - 1];
    if (block.type === "image") {
      bundle.nodes.push({ kind: "component", tag: "Photo", attrs: { file: block.path.split("/").pop() ?? block.path, alt: block.alt } });
      continue;
    }
    const lines = block.text.split("\n");
    const marks: Mark[] = [];
    let n = 0;
    for (const span of block.spans ?? []) {
      const style: MarkStyle = {};
      if (span.color) style.color = span.color.toLowerCase();
      if (span.background) style.background = span.background.toLowerCase();
      if (span.weight && span.weight >= 600) style.weight = 700;
      let hit = false;
      lines.forEach((text, line) => {
        if (hit && span.occurrence !== "all") return;
        let from = 0;
        let at: number;
        while ((at = text.indexOf(span.text, from)) >= 0) {
          if (!marks.some((m) => m.line === line && m.start < at + span.text.length && at < m.end)) {
            marks.push({ n: ++n, line, start: at, end: at + span.text.length, style });
            hit = true;
          }
          if (span.occurrence !== "all") return;
          from = at + span.text.length;
        }
      });
      if (!hit) lost.push(`${block.id}: 본문에서 못 찾은 강조 “${span.text}”`);
    }
    sortMarks(marks).forEach((m, k) => (m.n = k + 1));
    const para: ParagraphNode = { kind: "paragraph", id: block.id, lines, marks, notes: [] };
    const tag = block.role ? ROLE_TAG[block.role] : undefined;
    if (tag && COMPONENTS[tag].form === "text") {
      bundle.nodes.push({ kind: "component", tag, attrs: {}, text: block.text });
      if (marks.length) lost.push(`${block.id}: ${tag} 한 줄 태그에는 강조를 싣지 않음`);
    } else if (tag) bundle.nodes.push({ kind: "component", tag, attrs: {}, children: [para] });
    else if (block.role === "native") bundle.nodes.push({ kind: "component", tag: "QuestionCard", attrs: { topic: block.text } });
    else bundle.nodes.push(para);
  }
  return { doc, lost };
}

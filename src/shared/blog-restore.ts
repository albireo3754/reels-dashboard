// Naver blog reference restoration: pure model shared by the desktop extractor, the MCP tool,
// the restore viewer and tools/blog-restore. No I/O here.
import { z } from "zod";
import { absolutePathSchema } from "./path-schema";

export interface TemplateNode {
  type: "element" | "text-slot" | "image-slot";
  id: string;
  tag?: string;
  className?: string;
  css?: Record<string, string>;
  children?: TemplateNode[];
  pseudo?: { type: string; content: string; css: Record<string, string> }[];
  characters?: number;
  blank?: boolean;
  sample?: string;
  text?: string;
  src?: string;
  loaded?: boolean;
  naturalWidth?: number;
  naturalHeight?: number;
  originalWidth?: number;
  originalHeight?: number;
  link?: boolean;
  embed?: string;
}
export interface TemplateBlock {
  id: string;
  order: number;
  sourceAnchor: string | null;
  sourceClass: string;
  rect: { x: number; y: number; width: number; height: number };
  tree: TemplateNode;
}
export interface TemplateEntry {
  schemaVersion: 1;
  id: string;
  name: string;
  sourceUrl: string;
  referenceWidth: number;
  note: string;
  blocks: TemplateBlock[];
}
export interface StructureBlock {
  order: number;
  id: string;
  anchorId: string | null;
  className: string;
  rect: { x: number; y: number; width: number; height: number };
  css: Record<string, string>;
  paragraphs: { id?: string; characters: number; rect: StructureBlock["rect"]; css: Record<string, string>; runs: unknown[] }[];
  images: { rect: StructureBlock["rect"]; naturalWidth: number; naturalHeight: number; loaded: boolean; css: Record<string, string> }[];
}
export interface StructureEntry {
  name: string;
  url: string;
  pageUrl: string;
  width: number;
  capturedAt: string;
  viewport: { width: number; height: number };
  blocks: StructureBlock[];
}
export interface PageCapture {
  capturedAt: string;
  viewport: { width: number; height: number };
  title: { characters: number; text: string; sample: string; css: Record<string, string> } | null;
  fontsLoaded: { family: string; weight: string; style: string }[];
  stylesheets: string[];
  template: TemplateEntry;
  structure: StructureEntry;
}

export const blogExtractInput = z.strictObject({
  url: z.string().url().max(2048).describe("Naver blog post URL (blog.naver.com/<id>/<logNo>, m.blog.naver.com or PostView)."),
  outputDirectory: absolutePathSchema()
    .optional()
    .describe("Absolute parent folder. A <blogId>-<logNo> subfolder is created. Defaults to the last folder used in the app."),
  name: z.string().trim().min(1).max(100).optional().describe("Display name for the author; defaults to the blog id."),
});
export type BlogExtractInput = z.infer<typeof blogExtractInput>;
export interface BlogExtractProgress {
  url: string;
  stage: "open" | "images" | "extract" | "check" | "write" | "verify" | "done" | "error";
  message: string;
}
export interface BlogExtractResult {
  directory: string;
  resultId: string;
  name: string;
  url: string;
  blocks: number;
  kinds: Record<string, number>;
  warnings: string[];
  fidelity?: FidelitySummary;
  mobileCrosscheck: MobileCheck;
}

export function parsePostUrl(input: string) {
  const u = new URL(input);
  if (u.protocol !== "https:" || !["blog.naver.com", "m.blog.naver.com"].includes(u.hostname) || u.username || u.password || u.port)
    throw new Error("네이버 블로그 HTTPS 글 주소만 사용할 수 있어요.");
  let blogId = u.searchParams.get("blogId"),
    logNo = u.searchParams.get("logNo");
  if (!blogId || !logNo) [blogId, logNo] = u.pathname.split("/").filter(Boolean);
  if (!/^[\w-]{1,50}$/.test(blogId || "") || !/^\d{6,20}$/.test(logNo || ""))
    throw new Error("blogId/logNo가 있는 글 주소가 필요해요.");
  return {
    blogId: blogId!,
    logNo: logNo!,
    url: `https://blog.naver.com/${blogId}/${logNo}`,
    mobileUrl: `https://m.blog.naver.com/${blogId}/${logNo}`,
    slug: `${blogId}-${logNo}`,
  };
}

export function isAllowedImageUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && /(^|\.)pstatic\.net$/.test(u.hostname) && !u.username && !u.port;
  } catch {
    return false;
  }
}

type Ctx = { para?: boolean; hidden?: boolean };
export function walkTree(node: TemplateNode, visit: (n: TemplateNode, ctx: Ctx) => Ctx | void, ctx: Ctx = {}) {
  const next = visit(node, ctx) || ctx;
  for (const c of node.children || []) walkTree(c, visit, next);
}

export function summarizeBlock(block: Pick<TemplateBlock, "tree">) {
  const s = { textSlots: 0, characters: 0, paragraphCharacters: 0, images: 0, unloadedImages: 0, styledRuns: 0, pseudo: 0 };
  walkTree(block.tree, (n, ctx) => {
    if (n.type === "text-slot") {
      if (ctx.para) s.paragraphCharacters += n.characters ?? 0;
      if (!n.blank) {
        s.textSlots++;
        s.characters += n.characters ?? 0;
      }
      return;
    }
    if (n.type === "image-slot") {
      s.images++;
      if (!n.loaded) s.unloadedImages++;
      return;
    }
    if (n.pseudo) s.pseudo += n.pseudo.length;
    if (["b", "strong", "i", "em", "u", "s"].includes(n.tag ?? "") || /se-fs-fs\d|se-ff-\w/.test(n.className ?? "")) s.styledRuns++;
    if ((n.className ?? "").split(/\s+/).includes("se-text-paragraph")) return { ...ctx, para: true };
  });
  return s;
}

/** TemplateEngine `values` rendering the original: text-slot → original text, image-slot → CDN URL. */
export function sourceValues(block: Pick<TemplateBlock, "tree">, { text = true, images = true } = {}) {
  const v: Record<string, string> = {};
  walkTree(block.tree, (n) => {
    if (text && n.type === "text-slot" && !n.blank && typeof n.text === "string") v[n.id] = n.text;
    if (images && n.type === "image-slot" && isAllowedImageUrl(n.src)) v[n.id] = n.src;
  });
  return v;
}

/** Author components only: PC injects ad slots, mobile renders the title as a component. */
export const NON_AUTHOR_KINDS = ["Ad", "Title"];
/** Kinds the current TemplateEngine draws as a fixed placeholder instead of the measured tree. */
export const PLACEHOLDER_KINDS = ["Map"];

export function blockKind(sourceClass = "") {
  const c = sourceClass;
  if (c.includes("ssp-adcontent")) return "Ad";
  if (c.includes("se-documentTitle")) return "Title";
  return c.includes("quotation_postit") ? "ColorBox"
    : c.includes("quotation") ? "Quote"
    : c.includes("horizontalLine") ? "Divider"
    : c.includes("imageGroup") ? (c.includes("slide") ? "Slide" : "ImageGroup")
    : c.includes("se-image") ? "Image"
    : c.includes("placesMap") ? "Map"
    : c.includes("se-text") ? "Text"
    : c.includes("sticker") ? "Sticker"
    : c.includes("oglink") ? "LinkCard"
    : "Native";
}

export function countKinds(classNames: string[]) {
  const out: Record<string, number> = {};
  for (const c of classNames) {
    const k = blockKind(c);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/** Validates one capture. Errors block writing outputs. */
export function checkCapture(capture: Pick<PageCapture, "template" | "structure"> | null | undefined) {
  const errors: string[] = [],
    warnings: string[] = [];
  const t = capture?.template,
    s = capture?.structure;
  if (!t || !Array.isArray(t.blocks) || !t.blocks.length) errors.push("template blocks가 비어 있음");
  if (!s || !Array.isArray(s.blocks) || !s.blocks.length) errors.push("structure blocks가 비어 있음");
  if (errors.length) return { errors, warnings };
  if (t!.blocks.length !== s!.blocks.length) errors.push(`블록 수 불일치 template ${t!.blocks.length} / structure ${s!.blocks.length}`);
  if (t!.blocks.length > 1000) errors.push("블록 1000개 초과");
  t!.blocks.forEach((b, index) => {
    const sb = s!.blocks[index];
    const i = index + 1; // messages use the same 1-based numbering as the UI
    if (!sb) return;
    if (!b.tree) {
      errors.push(`#${i} tree 없음`);
      return;
    }
    const sum = summarizeBlock(b);
    const paraChars = sb.paragraphs.reduce((n, p) => n + p.characters, 0);
    if (sum.paragraphCharacters !== paraChars) errors.push(`#${i} 문단 글자수 불일치 tree ${sum.paragraphCharacters} / structure ${paraChars} (중복계수 의심)`);
    if (sum.images !== sb.images.length) errors.push(`#${i} 이미지 수 불일치 tree ${sum.images} / structure ${sb.images.length}`);
    const kind = blockKind(b.sourceClass);
    const noSrc: string[] = [];
    walkTree(b.tree, (n) => {
      if (n.type === "image-slot" && n.loaded && !isAllowedImageUrl(n.src)) noSrc.push(n.id);
    });
    if (noSrc.length && !NON_AUTHOR_KINDS.includes(kind)) warnings.push(`#${i} 원본 URL 없는 사진 ${noSrc.length}개`);
    if (sum.unloadedImages) warnings.push(`#${i} ${kind} 미로딩 이미지 ${sum.unloadedImages}개`);
    if ((b.sourceAnchor || null) !== (sb.anchorId || null)) errors.push(`#${i} anchor 불일치`);
    if (!sb.anchorId && !NON_AUTHOR_KINDS.includes(kind)) warnings.push(`#${i} 이동 앵커 없음`);
  });
  return { errors, warnings };
}

/** Cross-check idea from NomaDamas/k-skill naver-blog-research: count components in the mobile page's static HTML. */
export function mobileComponentClasses(html: string) {
  return [...html.matchAll(/class="(se-component [^"]*)"/g)].map((m) => m[1]);
}
export interface MobileCheck {
  ok: boolean;
  reason?: string;
  pcBlocks?: number;
  mobileBlocks?: number;
  allMatch?: boolean;
  kinds?: { kind: string; pc: number; mobile: number; match: boolean }[];
}
export function compareKinds(pc: Record<string, number>, mobile: Record<string, number>) {
  const keys = [...new Set([...Object.keys(pc), ...Object.keys(mobile)])].filter((k) => !NON_AUTHOR_KINDS.includes(k)).sort();
  return keys.map((k) => ({ kind: k, pc: pc[k] || 0, mobile: mobile[k] || 0, match: (pc[k] || 0) === (mobile[k] || 0) }));
}
export function mobileCheck(pcClasses: string[], mobileHtml: string): MobileCheck {
  const classes = mobileComponentClasses(mobileHtml);
  const kinds = compareKinds(countKinds(pcClasses), countKinds(classes));
  return { ok: true, pcBlocks: pcClasses.length, mobileBlocks: classes.length, allMatch: kinds.every((r) => r.match), kinds };
}

/** Visible, non-blank text the restoration should render (se-blind = screen-reader only). */
export function expectedRenderedLength(block: Pick<TemplateBlock, "tree">) {
  let n = 0;
  walkTree(block.tree, (x, ctx) => {
    if (x.type === "text-slot") {
      if (!x.blank && !ctx.hidden) n += (x.sample ?? "").length;
      return;
    }
    if (/\bse-blind\b/.test(x.className || "")) return { ...ctx, hidden: true };
  });
  return n;
}

export interface FidelityRow {
  order: number;
  kind: string;
  originalHeight: number;
  restoredHeight: number;
  ratio: number;
  textCharacters: number;
  renderedCharacters: number;
}
export interface FidelitySummary {
  blocks: number;
  measured: number;
  within5pct: number;
  within15pct: number;
  originalTotalHeight: number;
  restoredTotalHeight: number;
  textRendered: boolean;
  missingText: number[];
  excluded: { order: number; kind: string; reason: string; originalHeight: number; restoredHeight: number }[];
  outliers: { order: number; kind: string; ratio: number }[];
}
/** Compares original block heights with the restored render at the same width. */
export function fidelity(
  structureBlocks: Pick<StructureBlock, "className" | "rect">[],
  rendered: { height: number; characters: number }[],
  templateBlocks: Pick<TemplateBlock, "tree">[],
): { blocks: FidelityRow[]; summary: FidelitySummary } {
  const rows = structureBlocks.map((b, i) => {
    const r = rendered[i] || { height: 0, characters: 0 };
    const ratio = b.rect.height > 0 ? r.height / b.rect.height : r.height === 0 ? 1 : Infinity;
    return {
      order: i,
      kind: blockKind(b.className),
      originalHeight: round(b.rect.height),
      restoredHeight: round(r.height),
      ratio: round(ratio, 3),
      textCharacters: expectedRenderedLength(templateBlocks[i]),
      renderedCharacters: r.characters,
    };
  });
  const sized = rows.filter((r) => r.originalHeight >= 4 && !NON_AUTHOR_KINDS.includes(r.kind) && !PLACEHOLDER_KINDS.includes(r.kind));
  const real = rows.filter((r) => !NON_AUTHOR_KINDS.includes(r.kind));
  const within = (th: number) => sized.filter((r) => Math.abs(r.ratio - 1) <= th).length;
  const total = (k: "originalHeight" | "restoredHeight") => real.reduce((n, r) => n + r[k], 0);
  return {
    blocks: rows,
    summary: {
      blocks: rows.length,
      measured: sized.length,
      within5pct: within(0.05),
      within15pct: within(0.15),
      originalTotalHeight: round(total("originalHeight")),
      restoredTotalHeight: round(total("restoredHeight")),
      textRendered: sized.every((r) => r.renderedCharacters >= r.textCharacters),
      missingText: sized.filter((r) => r.renderedCharacters < r.textCharacters).map((r) => r.order),
      excluded: rows
        .filter((r) => !sized.includes(r))
        .map((r) => ({
          order: r.order,
          kind: r.kind,
          reason: NON_AUTHOR_KINDS.includes(r.kind) ? "non-author" : PLACEHOLDER_KINDS.includes(r.kind) ? "TemplateEngine placeholder" : "height<4px",
          originalHeight: r.originalHeight,
          restoredHeight: r.restoredHeight,
        })),
      outliers: sized.filter((r) => Math.abs(r.ratio - 1) > 0.15).map((r) => ({ order: r.order, kind: r.kind, ratio: r.ratio })),
    },
  };
}

export function upsertBy<T extends Record<string, unknown>>(existing: unknown, entry: T, key: keyof T): T[] {
  const list = (Array.isArray(existing) ? existing : []).filter((x): x is T => !!x && typeof x === "object");
  const i = list.findIndex((x) => x[key] === entry[key]);
  if (i >= 0) list[i] = entry;
  else list.push(entry);
  if (list.length > 30) throw new Error("작성자 30개 초과");
  return list;
}

export function toMarkdown(title: string, meta: Record<string, string>, value: unknown) {
  const lines = Object.entries(meta).map(([k, v]) => `- ${k}: ${v}`);
  return `# ${title}\n\n${lines.join("\n")}\n\ntext-slot의 \`text\`는 원문, \`sample\`은 길이·문장부호를 보존한 가림 문자(가)다. 사진은 파일 없이 원본 CDN \`src\` URL만 기록했다.\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

/** Picks @font-face rules for the families the original actually loaded (Naver CDN only). */
export function fontFaces(css: string, base: string, families: Set<string>) {
  const out: { family: string; weight: number; url: string; file: string }[] = [];
  for (const block of css.match(/@font-face\s*{[^}]*}/g) ?? []) {
    const family = block.match(/font-family\s*:\s*["']?([^;"']+)/)?.[1]?.trim();
    if (!family || !families.has(family)) continue;
    const weightRaw = block.match(/font-weight\s*:\s*([^;]+)/)?.[1]?.trim() ?? "400";
    const weight = weightRaw === "bold" ? 700 : Number.parseInt(weightRaw, 10) || 400;
    const src = [...block.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)\s*format\(\s*["']?woff2/g)][0]?.[1];
    if (!src) continue;
    let url: string;
    try {
      url = new URL(src, base).href;
    } catch {
      continue;
    }
    if (!isAllowedImageUrl(url)) continue; // same https *.pstatic.net rule
    const file = `${family}-${weight >= 700 ? "bold" : "regular"}.woff2`;
    if (!/^[\w-]+\.woff2$/.test(file) || out.some((f) => f.file === file)) continue;
    out.push({ family, weight, url, file });
  }
  return out;
}

function round(v: number, d = 1) {
  if (!Number.isFinite(v)) return v;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

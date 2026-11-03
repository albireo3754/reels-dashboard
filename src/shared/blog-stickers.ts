import type { ComponentNode, MarkupDoc, MarkupNode } from "./blog-markup";

// These are editorial intentions, not Naver product names or copied artwork.
export const STICKER_PRESETS = [
  { id: "hello", label: "인사", icon: "👋", expression: "손 흔드는 표정", placement: "도입 문단 뒤", tip: "첫 사진과 방문 이야기를 먼저 보여준 뒤 가볍게 인사해요." },
  { id: "yum", label: "맛있다", icon: "😋", expression: "먹고 만족하는 표정", placement: "맛을 설명한 문단 뒤", tip: "음식 사진과 실제 맛 이야기를 붙여 두고, 감상 끝에 한 번 넣어요." },
  { id: "like", label: "추천", icon: "👍", expression: "엄지·끄덕이는 표정", placement: "추천 이유를 쓴 문단 뒤", tip: "좋았던 이유를 먼저 쓰고, 추천하는 마음만 보태요." },
  { id: "bye", label: "마무리", icon: "🤗", expression: "웃으며 인사하는 표정", placement: "마지막 감상 뒤", tip: "마지막 감상 뒤에 넣고 주소·지도·태그와는 떨어뜨려요." },
] as const;
export type StickerPreset = typeof STICKER_PRESETS[number]["id"];
export interface StickerPlacement {
  id: string;
  preset: StickerPreset;
  bundleId: string;
  /** Gap before this non-sticker node; nodes.length means the end of a bundle. */
  before: number;
  note?: string;
}
export interface StickerAnchor { bundleId: string; before: number; label: string }
export const stickerKey = (s: Pick<StickerPlacement, "bundleId" | "before">) => JSON.stringify([s.bundleId, s.before]);
export const isSticker = (n: MarkupNode): n is ComponentNode & { tag: "Sticker" } => n.kind === "component" && n.tag === "Sticker";
export const stickerPreset = (id: unknown) => STICKER_PRESETS.find(p => p.id === id);

export function stickerPlan(doc: MarkupDoc): StickerPlacement[] {
  return doc.bundles.flatMap(b => {
    let before = 0;
    return b.nodes.flatMap(n => {
      if (!isSticker(n)) { before++; return []; }
      return [{ id: typeof n.attrs.id === "string" ? n.attrs.id : "", preset: String(n.attrs.preset) as StickerPreset, bundleId: b.id, before, ...(n.attrs.note ? { note: String(n.attrs.note) } : {}) }];
    });
  });
}
function nodeLabel(n: MarkupNode): string {
  if (n.kind === "paragraph") return `문단 · ${n.lines.join(" ").slice(0, 36)}`;
  if (n.tag === "Photo") return `사진 · ${n.attrs.alt || n.attrs.file}`;
  if (n.tag === "Collage") return "사진 묶음";
  return ({ Heading: "소제목", Title: "제목", Tags: "태그", Map: "지도", VisitCard: "방문 정보", PriceBox: "가격 정보", Divider: "구분선", Info: "정보", Source: "출처", QuestionCard: "질문 카드" } as Record<string,string>)[n.tag] ?? n.tag;
}
export function stickerAnchors(doc: MarkupDoc): StickerAnchor[] {
  return doc.bundles.flatMap(b => {
    const nodes = b.nodes.filter(n => !isSticker(n));
    return Array.from({ length: nodes.length + 1 }, (_, before) => ({ bundleId: b.id, before,
      label: `${b.name} / ${before ? nodeLabel(nodes[before - 1]) + " 뒤" : "묶음 시작"}`,
    })).filter(a => {
      const prior = nodes[a.before - 1], next = nodes[a.before];
      // Title is hidden in the editor, tags are outside the published body.
      return !(next?.kind === "component" && next.tag === "Title") && !(prior?.kind === "component" && prior.tag === "Tags");
    });
  });
}
export function replaceStickers(doc: MarkupDoc, placements: StickerPlacement[]): void {
  const anchors = new Set(stickerAnchors(doc).map(stickerKey));
  const ids = new Set<string>(), gaps = new Set<string>();
  for (const s of placements) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(s.id) || ids.has(s.id)) throw new Error("스티커 ID가 잘못됐거나 중복됐어요.");
    if (!stickerPreset(s.preset) || !anchors.has(stickerKey(s))) throw new Error("스티커 종류 또는 위치가 유효하지 않아요.");
    if (gaps.has(stickerKey(s))) throw new Error("같은 자리에는 스티커를 하나만 놓아주세요.");
    if (s.note && (s.note.length > 120 || /[\r\n]/.test(s.note))) throw new Error("스티커 메모는 한 줄 120자까지예요.");
    ids.add(s.id); gaps.add(stickerKey(s));
  }
  for (const b of doc.bundles) {
    const nodes = b.nodes.filter(n => !isSticker(n)), next: MarkupNode[] = [];
    for (let i = 0; i <= nodes.length; i++) {
      for (const s of placements.filter(s => s.bundleId === b.id && s.before === i)) next.push({ kind: "component", tag: "Sticker", attrs: { id: s.id, preset: s.preset, ...(s.note ? { note: s.note } : {}) } });
      if (nodes[i]) next.push(nodes[i]);
    }
    b.nodes = next;
  }
}
export function stickerGuidance(placements: StickerPlacement[]): string[] {
  return placements.length > 3 ? ["스티커가 4개 이상이에요. 감상이 끝나는 곳에 꼭 필요한 것만 남겨 보세요."] : [];
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export function stickerHtml(s: Pick<StickerPlacement, "id" | "preset" | "note">): string {
  const p = stickerPreset(s.preset);
  return `<aside class="blog-sticker-slot" data-sticker-id="${esc(s.id)}" contenteditable="false" aria-label="${esc(p?.label ?? s.preset)} 스티커 자리"><span class="blog-sticker-icon" aria-hidden="true">${p?.icon ?? "◇"}</span><strong>기본 스티커 · ${esc(p?.label ?? s.preset)}</strong><small>${esc(s.note || p?.expression || "기본 스티커에서 선택")}</small><small>자리 표시 · 네이버에서 기본 스티커로 교체</small></aside>`;
}
export const STICKER_CSS = `.blog-sticker-slot{box-sizing:border-box;max-width:260px;margin:28px auto;padding:16px 20px;border:1px dashed #c3cdbf;border-radius:16px;background:#f7f9f3;color:#52634f;text-align:center;font:13px/1.6 system-ui,sans-serif;break-inside:avoid}.blog-sticker-slot strong,.blog-sticker-slot small{display:block;overflow-wrap:anywhere}.blog-sticker-slot small{font-size:11px;color:#697663}.blog-sticker-icon{display:block;font-size:30px;line-height:1.4;margin-bottom:6px}`;

import { isSticker, stickerAnchors, stickerKey } from "./blog-stickers";
import type { MarkupDoc, MarkupNode } from "./blog-markup";

/** One analyzed image as the editor's picker shows it; bytes stay behind the local server. */
export interface EvidenceImage {
  id: string;
  captureId: string;
  kind: string;
  time: string | null;
  description: string;
  tags: string[];
  ocr: string[];
  contextNotes: string[];
  uncertainties: string[];
  faceCount: number;
}
export interface EvidenceLibrary {
  connected: boolean;
  items: EvidenceImage[];
  /** Images whose exact bytes are already placed in the manuscript. */
  usedIds: string[];
  /** Entries left out because analysis did not resolve them. */
  unresolved: number;
}
/** An unsaved placement. `before` uses the same gap numbering as sticker anchors. */
export interface PhotoInsert {
  id: string;
  imageId: string;
  bundleId: string;
  before: number;
  alt: string;
}
export const EVIDENCE_ID = /^[a-zA-Z0-9_-]{1,80}$/;
export const PHOTO_ALT_LIMIT = 200;
export const evidenceImageUrl = (id: string) => "/api/blog/evidence-image?id=" + encodeURIComponent(id);
export const evidenceThumbnailUrl = (id: string) => evidenceImageUrl(id) + "&thumbnail=1";

const fold = (text: string) => text.normalize("NFC").toLowerCase();
/** Every whitespace-separated term must appear somewhere in the row. */
export function searchEvidence(items: EvidenceImage[], query: string, captureId = ""): EvidenceImage[] {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  return items.filter(item => {
    if (captureId && item.captureId !== captureId) return false;
    if (!terms.length) return true;
    const row = fold([item.id, item.captureId, item.description, ...item.tags, ...item.ocr, ...item.contextNotes].join("\n"));
    return terms.every(term => row.includes(term));
  });
}
/** A starting alt text only: the first observed sentence, for the writer to edit. */
export function defaultAlt(description: string): string {
  const first = description.replace(/\s+/g, " ").trim().match(/^.*?[.!?。](?=\s|$)/)?.[0] ?? description.replace(/\s+/g, " ").trim();
  return first.slice(0, PHOTO_ALT_LIMIT);
}
/** Adds Photo nodes at sticker-style gaps; a sticker already in the gap stays first. */
export function insertPhotos(doc: MarkupDoc, inserts: Array<PhotoInsert & { file: string }>): void {
  const anchors = new Set(stickerAnchors(doc).map(stickerKey));
  for (const p of inserts) {
    if (!anchors.has(stickerKey(p))) throw new Error("사진을 넣을 위치가 바뀌었어요. 위치를 다시 골라주세요.");
    if (!p.alt.trim() || p.alt.length > PHOTO_ALT_LIMIT || /[\r\n]/.test(p.alt)) throw new Error(`사진 설명은 한 줄 ${PHOTO_ALT_LIMIT}자까지 입력해주세요.`);
  }
  for (const b of doc.bundles) {
    const photos = (gap: number): MarkupNode[] => inserts
      .filter(p => p.bundleId === b.id && p.before === gap)
      .map(p => ({ kind: "component", tag: "Photo", attrs: { file: p.file, alt: p.alt.trim() } }));
    const next: MarkupNode[] = [];
    let gap = 0;
    for (const node of b.nodes) {
      if (!isSticker(node)) next.push(...photos(gap++));
      next.push(node);
    }
    b.nodes = [...next, ...photos(gap)];
  }
}

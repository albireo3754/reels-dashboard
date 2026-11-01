import { z } from "zod";
const url = z
  .string()
  .url()
  .refine((value) => {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      u.hostname === "blog.naver.com" &&
      !u.username &&
      !u.password &&
      !u.port
    );
  }, "네이버 블로그 HTTPS 주소만 사용할 수 있어요.");
const css = z.record(z.string().max(100), z.string().max(2000));
const rect = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().min(0).max(100000),
  height: z.number().min(0).max(1000000),
});
const run = z.object({
  characters: z.number().int().min(0).max(100000),
  punctuation: z.string().max(100000).optional(),
  /** Original text of this run (in-app extraction, 2026-11-01+). Older files have only counts. */
  text: z.string().max(100000).optional(),
  css,
});
const paragraph = z.object({
  id: z.string().max(300).optional(),
  characters: z.number().int().min(0).max(100000),
  rect,
  css,
  runs: z.array(run).max(1000),
});
const image = z.object({
  rect,
  naturalWidth: z.number().min(0),
  naturalHeight: z.number().min(0),
  loaded: z.boolean(),
  css,
});
export const referenceBlock = z.object({
  order: z.number().int().min(0),
  id: z.string().max(300),
  anchorId: z.string().max(300).nullable().optional(),
  className: z.string().max(1000),
  rect,
  css,
  paragraphs: z.array(paragraph).max(1000),
  images: z.array(image).max(100),
});
export const referenceDocument = z.object({
  name: z.string().min(1).max(200),
  url,
  pageUrl: url,
  width: z.number().min(0),
  capturedAt: z.string().optional(),
  viewport: z.object({ width: z.number(), height: z.number() }).optional(),
  blocks: z.array(referenceBlock).min(1).max(1000),
});
export type ReferenceDocument = z.infer<typeof referenceDocument>;
export type ReferenceBlock = z.infer<typeof referenceBlock>;
export function parseReferences(text: string): ReferenceDocument[] {
  if (new TextEncoder().encode(text).length > 10 * 1024 * 1024)
    throw new Error("10MB 이하의 구조 파일을 선택해주세요.");
  const json = text.match(/```json\s*\n([\s\S]*?)\n```/)?.[1] ?? text;
  return z.array(referenceDocument).min(1).max(30).parse(JSON.parse(json));
}
export function blockKind(block: ReferenceBlock) {
  const c = block.className;
  return c.includes("quotation")
    ? "인용·정보"
    : c.includes("horizontalLine")
      ? "구분선"
      : c.includes("placesMap")
        ? "지도"
        : c.includes("imageGroup")
          ? "이미지 그룹"
          : c.includes("image")
            ? "이미지"
            : c.includes("text")
              ? "텍스트"
              : "기타 요소";
}
export function blockLink(
  reference: ReferenceDocument,
  block: ReferenceBlock,
): string | null {
  const anchor = block.anchorId || block.id;
  if (!anchor) return null;
  const target = new URL(reference.pageUrl);
  target.hash = anchor;
  return target.href;
}

import { z } from "zod";
import { blogBlock, type BlogBlock, type BlogDraft } from "./blog";

export interface Bundle {
  id: string;
  name: string;
  question: string;
  startBlockId: string;
  blocks: BlogBlock[];
}
/** Explicit boundaries only: a photo or paragraph break never implies a new experience. */
export function bundlesOf(draft: BlogDraft): Bundle[] {
  if (!draft.blocks.length) return [];
  const boundaries = new Map(
    (draft.reviewGroups ?? []).map((g) => [g.startBlockId, g]),
  );
  const result: Bundle[] = [];
  for (const block of draft.blocks) {
    const boundary = boundaries.get(block.id);
    if (boundary || !result.length)
      result.push({
        ...boundary,
        id: boundary?.id ?? `bundle:${block.id}`,
        name: boundary?.name ?? "첫 묶음",
        question: boundary?.question ?? "",
        startBlockId: block.id,
        blocks: [],
      });
    result[result.length - 1].blocks.push(block);
  }
  return result;
}
export interface ReviewRequest {
  schemaVersion: 1;
  kind: "blog.bundle-review.request";
  requestId: string;
  projectId: string;
  scope: "selected" | "changed";
  bundleIds: string[];
  draft: BlogDraft;
  bundles: Bundle[];
}
const finding = z.strictObject({
  id: z.string().min(1),
  bundleId: z.string().min(1),
  reason: z.string().min(1).max(4000),
  blockId: z.string().min(1),
  before: blogBlock,
  after: blogBlock,
});
export const reviewResult = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("blog.bundle-review.result"),
  requestId: z.string().min(1),
  reviews: z
    .array(
      z.strictObject({
        bundleId: z.string().min(1),
        verdict: z.enum(["pass", "revise"]),
        summary: z.string().min(1).max(4000),
        findings: z.array(finding).max(100),
      }),
    )
    .max(300),
});
export type ReviewResult = z.infer<typeof reviewResult>;
export function sameBlock(a: BlogBlock | undefined, b: BlogBlock): boolean {
  return (
    !!a &&
    JSON.stringify(blogBlock.parse(a)) === JSON.stringify(blogBlock.parse(b))
  );
}
export function validateResult(
  value: unknown,
  request: ReviewRequest,
): ReviewResult {
  const result = reviewResult.parse(value);
  if (result.requestId !== request.requestId)
    throw new Error("현재 검토 요청의 결과가 아니에요.");
  const ids = result.reviews.map((r) => r.bundleId);
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== request.bundleIds.length ||
    request.bundleIds.some((id) => !ids.includes(id))
  )
    throw new Error("요청한 묶음과 결과의 묶음이 일치하지 않아요.");
  const findingIds = new Set<string>();
  for (const review of result.reviews) {
    if (review.verdict === "pass" && review.findings.length)
      throw new Error("통과한 묶음에는 수정 제안을 넣을 수 없어요.");
    for (const f of review.findings) {
      const original = request.bundles
        .find((b) => b.id === review.bundleId)
        ?.blocks.find((b) => b.id === f.blockId);
      if (
        f.bundleId !== review.bundleId ||
        findingIds.has(f.id) ||
        f.before.id !== f.blockId ||
        f.after.id !== f.blockId ||
        f.before.type !== f.after.type ||
        !sameBlock(original, f.before)
      )
        throw new Error("수정 제안의 대상이나 원문이 요청과 달라요.");
      // The UI accepts editorial text/format/alt changes, not arbitrary local file access.
      if (
        f.before.type === "image" &&
        f.after.type === "image" &&
        f.before.path !== f.after.path
      )
        throw new Error("사진 교체는 연결된 사진 목록에서 직접 선택해주세요.");
      findingIds.add(f.id);
    }
  }
  return result;
}

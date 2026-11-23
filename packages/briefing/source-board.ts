import { z } from "zod";

const localPath =
  /(?:file:\/\/|(?:^|[\s('"=:])(?:~?\/(?=\S)|[A-Z]:\\|\.\.?\/)|\\{2}[^\\ ]+\\)/i;
const filename =
  /\.(?:mov|mp4|m4v|mkv|avi|webm|jpe?g|heic|heif|png|webp|dng|gif|m4a|mp3|wav|srt|vtt|json|md|txt|pdf|csv|xlsx?|docx?|ya?ml|zip)(?=$|[^a-z0-9])/i;
const credential =
  /(?:\b(?:sk-|pk-|rk-|ghp_|gho_|github_pat_|xox[abprs]-|AKIA|AIza)[a-z0-9_-]{8,}|\bbearer\s+\S+|\b[a-f0-9]{32,}\b|(?:password|api[_-]?key|token|secret)\s*[:=]\s*\S+)/i;
const clean = (s: string) =>
  ![localPath, filename, credential].some((pattern) => pattern.test(s)) &&
  !s.includes("\0");
const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(clean, "로컬 경로·파일명·인증정보는 넣을 수 없어요.");
const id = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/)
  .refine(clean);
const instagramPost = z
  .string()
  .max(160)
  .regex(
    /^https:\/\/(?:www\.)?instagram\.com\/(?:reel|p)\/[A-Za-z0-9_-]{1,64}\/?$/,
  );
const scene = z
  .object({
    id,
    day: z.number().int().min(1).max(366),
    time: line(40),
    title: line(120),
  })
  .strict();
const reference = z
  .object({
    url: instagramPost,
    account: z
      .string()
      .regex(/^@[A-Za-z0-9._]{1,30}$/)
      .refine(clean),
    metric: line(160),
    hook: line(240),
    ourVersion: line(300),
  })
  .strict();
const unit = z
  .object({
    id,
    rank: z.number().int().positive().max(999),
    title: line(120),
    status: z.enum(["none", "draft", "published"]),
    statusUrl: instagramPost.optional(),
    footage: z
      .object({
        score: z.number().min(0).max(5).multipleOf(0.1),
        summary: line(300),
        scenes: z
          .array(scene)
          .max(64)
          .refine(
            (rows) => new Set(rows.map((row) => row.id)).size === rows.length,
            "상황 ID가 겹쳐요.",
          ),
      })
      .strict(),
    refs: z.array(reference).max(3),
  })
  .strict()
  .refine(
    (row) => !row.statusUrl || row.status === "published",
    "게시 링크는 게시 완료 소재에만 넣을 수 있어요.",
  );

export const sourceBoardSchema = z
  .object({
    title: line(160),
    basis: line(300),
    updatedAt: z.string().datetime({ offset: true }).max(40),
    units: z
      .array(unit)
      .max(40)
      .refine(
        (rows) => new Set(rows.map((row) => row.id)).size === rows.length,
        "소재 ID가 겹쳐요.",
      )
      .refine(
        (rows) =>
          rows.every((row, i) => i === 0 || rows[i - 1].rank < row.rank),
        "순위는 중복 없이 오름차순이어야 해요.",
      ),
  })
  .strict();
export type SourceBoard = z.infer<typeof sourceBoardSchema>;

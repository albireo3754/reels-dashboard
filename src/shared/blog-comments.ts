import { z } from "zod";

/**
 * Comments the account left (or plans to leave) on other Naver blogs, plus whether the
 * blogger returned the visit. The app only stores them; posting stays manual.
 */
export const blogCommentStatus = z.enum([
  "draft",
  "posted",
  "reciprocated",
  "no_reply",
  "neighbor",
]);
export type BlogCommentStatus = z.infer<typeof blogCommentStatus>;

const text = (max: number) => z.string().trim().min(1).max(max);
const iso = z.string().datetime();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Accepts m.blog / blog.naver.com post URLs (path or PostView query) and returns the canonical mobile URL. */
export function parseNaverPostUrl(value: string): { blogId: string; logNo: string; url: string } {
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    throw new Error("INVALID_POST_URL: 네이버 블로그 글 주소가 아니에요.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    throw new Error("INVALID_POST_URL: 네이버 블로그 글 주소가 아니에요.");
  if (!/^(?:m\.)?blog\.naver\.com$/.test(u.hostname))
    throw new Error("INVALID_POST_URL: 네이버 블로그 글 주소가 아니에요.");
  let blogId = u.searchParams.get("blogId");
  let logNo = u.searchParams.get("logNo");
  if (!blogId || !logNo) {
    const m = /^\/([A-Za-z0-9_-]+)\/(\d+)\/?$/.exec(u.pathname);
    if (!m) throw new Error("INVALID_POST_URL: 글 번호가 있는 주소를 넣어주세요.");
    [, blogId, logNo] = m;
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(blogId) || !/^\d{1,20}$/.test(logNo))
    throw new Error("INVALID_POST_URL: 글 번호가 있는 주소를 넣어주세요.");
  return { blogId, logNo, url: `https://m.blog.naver.com/${blogId}/${logNo}` };
}

const editable = {
  postTitle: text(300).optional(),
  reciprocity: text(500).optional().describe("What the blogger promised, e.g. '공감·댓글 반사, 서이웃'."),
  status: blogCommentStatus.optional(),
  text: text(2000).optional().describe("The comment as actually posted (or the chosen draft)."),
  alternatives: z.array(text(2000)).max(5).optional().describe("Other drafts that were offered."),
  note: text(1000).optional(),
  postedAt: day.optional().describe("YYYY-MM-DD the comment was posted."),
};

export const blogComment = z.strictObject({
  id: z.string().uuid(),
  blogId: z.string(),
  logNo: z.string(),
  postUrl: z.string().url(),
  postTitle: z.string().optional(),
  reciprocity: z.string().optional(),
  status: blogCommentStatus,
  text: z.string().optional(),
  alternatives: z.array(z.string()).optional(),
  note: z.string().optional(),
  postedAt: day.optional(),
  createdAt: iso,
  updatedAt: iso,
});
export type BlogComment = z.infer<typeof blogComment>;

export const blogCommentList = z.strictObject({
  blogId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  postUrl: z.string().max(2048).optional(),
  status: blogCommentStatus.optional(),
  query: z.string().trim().min(1).max(200).optional().describe("Substring match on comment text, drafts, title and note."),
  limit: z.number().int().min(1).max(500).default(50),
});
export type BlogCommentListInput = z.infer<typeof blogCommentList>;

export const blogCommentCreate = z.strictObject({
  postUrl: z.string().min(1).max(2048).describe("Naver blog post URL; the blog id and post number are read from it."),
  ...editable,
});
export type BlogCommentCreateInput = z.infer<typeof blogCommentCreate>;

export const blogCommentUpdate = z.strictObject({
  id: z.string().uuid(),
  expectedUpdatedAt: iso.describe("updatedAt from list/create; stale revisions are rejected."),
  ...editable,
});
export type BlogCommentUpdateInput = z.infer<typeof blogCommentUpdate>;

export const blogCommentDelete = z.strictObject({
  id: z.string().uuid(),
  expectedUpdatedAt: iso,
});
export type BlogCommentDeleteInput = z.infer<typeof blogCommentDelete>;

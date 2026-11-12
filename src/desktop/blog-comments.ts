import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { readJsonFile } from "../shared/lib/fs";
import type { LocalStore } from "../shared/lib/storage";
import {
  blogComment,
  parseNaverPostUrl,
  type BlogComment,
  type BlogCommentCreateInput,
  type BlogCommentDeleteInput,
  type BlogCommentListInput,
  type BlogCommentUpdateInput,
} from "../shared/blog-comments";

const file = z.strictObject({ version: z.literal(1), comments: z.array(blogComment).max(10_000) });

/** Comment history kept in the app profile (`blog-comments.json`). Writes are serialized. */
export class BlogComments {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private store: LocalStore,
    private now: () => Date = () => new Date(),
  ) {}
  private get path() {
    return path.join(this.store.root, "blog-comments.json");
  }
  private async read() {
    return readJsonFile(this.path, (v) => file.parse(v).comments, () => [] as BlogComment[]);
  }
  private write<T>(change: (comments: BlogComment[]) => { comments: BlogComment[]; result: T }) {
    const op = this.queue.then(async () => {
      const { comments, result } = change(await this.read());
      await this.store.atomic(this.path, file.parse({ version: 1, comments }));
      return result;
    });
    this.queue = op.catch(() => {});
    return op;
  }

  async list(input: BlogCommentListInput) {
    const comments = await this.read();
    const url = input.postUrl ? parseNaverPostUrl(input.postUrl).url : undefined;
    const q = input.query?.toLowerCase();
    const matches = comments
      .filter((c) => !input.blogId || c.blogId === input.blogId)
      .filter((c) => !url || c.postUrl === url)
      .filter((c) => !input.status || c.status === input.status)
      .filter(
        (c) =>
          !q ||
          [c.text, c.postTitle, c.note, ...(c.alternatives ?? [])].some((v) => v?.toLowerCase().includes(q)),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { total: matches.length, comments: matches.slice(0, input.limit) };
  }

  create(input: BlogCommentCreateInput) {
    const { postUrl, ...fields } = input;
    const post = parseNaverPostUrl(postUrl);
    return this.write((comments) => {
      const existing = comments.find((c) => c.postUrl === post.url);
      if (existing)
        throw new Error(`DUPLICATE: 이미 기록된 글이에요. 기존 기록(${existing.id})을 수정해주세요.`);
      const stamp = this.now().toISOString();
      const comment = blogComment.parse({
        id: randomUUID(),
        blogId: post.blogId,
        logNo: post.logNo,
        postUrl: post.url,
        ...fields,
        status: fields.status ?? "draft",
        createdAt: stamp,
        updatedAt: stamp,
      });
      return { comments: [...comments, comment], result: comment };
    });
  }

  update(input: BlogCommentUpdateInput) {
    const { id, expectedUpdatedAt, ...fields } = input;
    return this.write((comments) => {
      const index = this.find(comments, id, expectedUpdatedAt);
      const current = comments[index];
      let stamp = this.now().toISOString();
      // Keep revisions strictly increasing so a quick second edit cannot reuse the old stamp.
      if (stamp <= current.updatedAt) stamp = new Date(Date.parse(current.updatedAt) + 1).toISOString();
      const next = blogComment.parse({ ...current, ...fields, updatedAt: stamp });
      const copy = [...comments];
      copy[index] = next;
      return { comments: copy, result: next };
    });
  }

  remove(input: BlogCommentDeleteInput) {
    return this.write((comments) => {
      const index = this.find(comments, input.id, input.expectedUpdatedAt);
      return { comments: comments.filter((_, i) => i !== index), result: { deleted: input.id } };
    });
  }

  private find(comments: BlogComment[], id: string, expectedUpdatedAt: string) {
    const index = comments.findIndex((c) => c.id === id);
    if (index < 0) throw new Error("NOT_FOUND: 댓글 기록을 찾지 못했어요.");
    if (comments[index].updatedAt !== expectedUpdatedAt)
      throw new Error("STALE_COMMENT: 기록이 변경됐어요. 다시 조회하고 수정해주세요.");
    return index;
  }
}

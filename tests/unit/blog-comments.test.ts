import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BlogComments } from "../../src/desktop/blog-comments";
import { LocalStore } from "../../src/shared/lib/storage";
import { blogCommentCreate, blogCommentList, parseNaverPostUrl } from "../../src/shared/blog-comments";
import { createAgentDispatch, toolDefinitions } from "../../src/features/agent-tools";

async function setup(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "blog-comments-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalStore(root);
  await store.initialize();
  let clock = Date.parse("2026-11-12T01:00:00.000Z");
  return { root, comments: new BlogComments(store, () => new Date(clock)), tick: () => (clock += 1000) };
}

test("post URLs normalize to the mobile post URL", () => {
  const expected = { blogId: "park_mong", logNo: "224473424099", url: "https://m.blog.naver.com/park_mong/224473424099" };
  for (const url of [
    "https://m.blog.naver.com/park_mong/224473424099",
    "https://blog.naver.com/park_mong/224473424099?trackingCode=x",
    "https://m.blog.naver.com/PostView.naver?blogId=park_mong&logNo=224473424099",
  ])
    assert.deepEqual(parseNaverPostUrl(url), expected);
  for (const url of ["https://example.com/park_mong/1", "https://m.blog.naver.com/park_mong", "not a url"])
    assert.throws(() => parseNaverPostUrl(url), /INVALID_POST_URL/);
});

test("create, list, update and delete keep one record per post with revision checks", async (t) => {
  const { root, comments, tick } = await setup(t);
  const created = await comments.create(
    blogCommentCreate.parse({
      postUrl: "https://blog.naver.com/park_mong/224473424099",
      postTitle: "광안리 술집 부사노뎅",
      reciprocity: "공감·댓글 반사, 서이웃",
      alternatives: ["초안 1", "초안 2"],
    }),
  );
  assert.equal(created.status, "draft");
  assert.equal(created.postUrl, "https://m.blog.naver.com/park_mong/224473424099");
  await assert.rejects(
    comments.create(blogCommentCreate.parse({ postUrl: "https://m.blog.naver.com/PostView.naver?blogId=park_mong&logNo=224473424099" })),
    /DUPLICATE/,
  );

  tick();
  const posted = await comments.update({
    id: created.id,
    expectedUpdatedAt: created.updatedAt,
    status: "posted",
    text: "오뎅기에서 하나씩 꺼내 먹는 방식이 재밌어 보여요.",
    postedAt: "2026-11-12",
  });
  assert.equal(posted.status, "posted");
  assert.deepEqual(posted.alternatives, ["초안 1", "초안 2"]);
  assert.ok(posted.updatedAt > created.updatedAt);
  await assert.rejects(
    comments.update({ id: created.id, expectedUpdatedAt: created.updatedAt, status: "neighbor" }),
    /STALE_COMMENT/,
  );

  tick();
  await comments.create(blogCommentCreate.parse({ postUrl: "https://m.blog.naver.com/other_blog/1", text: "다른 글" }));
  const all = await comments.list(blogCommentList.parse({}));
  assert.equal(all.total, 2);
  assert.equal(all.comments[0].blogId, "other_blog", "newest first");
  assert.equal((await comments.list(blogCommentList.parse({ blogId: "park_mong" }))).total, 1);
  assert.equal((await comments.list(blogCommentList.parse({ status: "posted" }))).total, 1);
  assert.equal((await comments.list(blogCommentList.parse({ query: "오뎅기" }))).total, 1);
  assert.equal((await comments.list(blogCommentList.parse({ query: "초안 2" }))).total, 1, "drafts are searchable");
  assert.equal(
    (await comments.list(blogCommentList.parse({ postUrl: "https://blog.naver.com/park_mong/224473424099" }))).total,
    1,
  );

  const saved = JSON.parse(await readFile(path.join(root, "blog-comments.json"), "utf8"));
  assert.equal(saved.version, 1);
  assert.equal(saved.comments.length, 2);

  await assert.rejects(comments.remove({ id: created.id, expectedUpdatedAt: created.updatedAt }), /STALE_COMMENT/);
  assert.deepEqual(await comments.remove({ id: posted.id, expectedUpdatedAt: posted.updatedAt }), { deleted: posted.id });
  assert.equal((await comments.list(blogCommentList.parse({}))).total, 1);
  await assert.rejects(comments.remove({ id: posted.id, expectedUpdatedAt: posted.updatedAt }), /NOT_FOUND/);
});

test("concurrent creates are serialized", async (t) => {
  const { comments } = await setup(t);
  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      comments.create(blogCommentCreate.parse({ postUrl: `https://m.blog.naver.com/b${i}/${i + 1}` })),
    ),
  );
  assert.equal((await comments.list(blogCommentList.parse({}))).total, 5);
});

test("agent tools expose comment CRUD and report UNSUPPORTED without the port", async () => {
  for (const name of ["reels_list_blog_comments", "reels_create_blog_comment", "reels_update_blog_comment", "reels_remove_blog_comment"])
    assert.ok(Object.hasOwn(toolDefinitions, name), name);
  assert.equal(toolDefinitions.reels_list_blog_comments.readOnly, true);
  const dispatch = createAgentDispatch({ session: { assertWritable() {} } } as never);
  await assert.rejects(dispatch("reels_list_blog_comments", {}), /UNSUPPORTED/);
  const calls: unknown[] = [];
  const withPort = createAgentDispatch({
    session: { assertWritable() {} },
    blogComments: {
      list: async (input: unknown) => (calls.push(input), { total: 0, comments: [] }),
      create: async () => null,
      update: async () => null,
      remove: async () => null,
    },
  } as never);
  assert.deepEqual(await withPort("reels_list_blog_comments", { blogId: "park_mong" }), { total: 0, comments: [] });
  assert.deepEqual(calls, [{ blogId: "park_mong", limit: 50 }]);
  await assert.rejects(withPort("reels_create_blog_comment", { postUrl: "x", extra: 1 }), /Unrecognized|unrecognized/);
});

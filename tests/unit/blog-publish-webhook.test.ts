import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { blogPublishWebhook } from "../../src/desktop/blog-publish-webhook";
import { LocalStore } from "../../src/shared/lib/storage";

const post = {
  url: "https://blog.naver.com/example_owner/123456789",
  title: "여행 & 산책",
  pubDate: "2026-11-19T00:10:00+09:00",
};
const now = Date.parse("2026-11-19T00:20:00+09:00");

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "blog-webhook-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: { url: string; init: RequestInit }[] = [];
  const server = { status: 503 };
  const request = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("", { status: server.status });
  }) as unknown as typeof fetch;
  const secretFile = path.join(root, "secret");
  const configure = async () => {
    await writeFile(secretFile, "test-secret\n");
    await writeFile(
      path.join(root, "blog-publish-webhook.json"),
      JSON.stringify({ url: "https://example.com/hook", secretFile }),
    );
  };
  const queue = async () =>
    JSON.parse(await readFile(path.join(root, "blog-publish-webhook-queue.json"), "utf8"));
  return { webhook: blogPublishWebhook(new LocalStore(root), request), calls, server, configure, queue };
}

test("without a config file nothing is queued or sent", async (t) => {
  const f = await fixture(t);
  await f.webhook.enqueue(post);
  await f.webhook.flush(now, true);
  await assert.rejects(f.queue(), /ENOENT/);
  assert.equal(f.calls.length, 0);
});

test("a signed delivery stays queued through failures and leaves on 2xx", async (t) => {
  const f = await fixture(t);
  await f.configure();
  await f.webhook.enqueue(post);
  await f.webhook.enqueue(post);
  await f.webhook.flush(now);
  assert.equal((await f.queue()).length, 1);
  await f.webhook.flush(now + 59_000);
  assert.equal(f.calls.length, 1);
  f.server.status = 202;
  await f.webhook.flush(now + 60_000);
  assert.deepEqual(await f.queue(), []);
  assert.equal(f.calls.length, 2);

  const { url, init } = f.calls[1];
  const headers = init.headers as Record<string, string>;
  const body = init.body as string;
  assert.equal(url, "https://example.com/hook");
  assert.deepEqual(JSON.parse(body), { type: "blog_published", occurredAt: post.pubDate, data: post });
  assert.equal(headers["x-openbot-delivery-id"], "rosy-blog-post-123456789");
  const signed = `${headers["x-openbot-timestamp"]}.rosy-blog-post-123456789.${body}`;
  assert.equal(
    headers["x-openbot-signature"],
    "sha256=" + createHmac("sha256", "test-secret").update(signed).digest("hex"),
  );
});

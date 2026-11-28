import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parsePostUrl } from "../shared/blog-restore";
import { readJsonFile } from "../shared/lib/fs";
import type { LocalStore } from "../shared/lib/storage";

export type BlogPost = { url: string; title: string; pubDate: string };

const webhookConfig = z.strictObject({
  url: z.url({ protocol: /^https$/ }),
  secretFile: z.string().refine((value) => path.isAbsolute(value)),
});
const queueSchema = z.array(
  z.object({
    post: z.object({ url: z.string(), title: z.string(), pubDate: z.string() }),
    attempts: z.number().int().min(0),
    nextAttemptAt: z.number(),
  }),
);

/**
 * "Blog published" notifications. Nothing is queued or sent without
 * `blog-publish-webhook.json`; a queued post leaves only on a 2xx response.
 * Calls must not overlap: the booking loop is the only caller.
 */
export function blogPublishWebhook(store: LocalStore, request: typeof fetch = fetch) {
  const file = path.join(store.root, "blog-publish-webhook-queue.json");
  const config = () =>
    readJsonFile(path.join(store.root, "blog-publish-webhook.json"), (v) => webhookConfig.parse(v), () => null);
  const load = () => readJsonFile(file, (v) => queueSchema.parse(v), () => [] as z.infer<typeof queueSchema>);

  async function send(post: BlogPost, url: string, secret: string, now: number) {
    const body = JSON.stringify({ type: "blog_published", occurredAt: post.pubDate, data: post });
    const timestamp = String(Math.floor(now / 1000));
    const id = `rosy-blog-post-${parsePostUrl(post.url).logNo}`;
    const signature = createHmac("sha256", secret).update(`${timestamp}.${id}.${body}`).digest("hex");
    const response = await request(url, {
      method: "POST",
      body,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "Content-Type": "application/json",
        "x-openbot-timestamp": timestamp,
        "x-openbot-delivery-id": id,
        "x-openbot-signature": `sha256=${signature}`,
      },
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  }

  return {
    async enqueue(post: BlogPost) {
      try {
        if (!(await config())) return;
      } catch {
        // A broken config still keeps the post for a later send.
        console.warn("[blog-webhook] blog-publish-webhook.json을 읽지 못했습니다.");
      }
      const queue = await load();
      if (queue.some((item) => item.post.url === post.url)) return;
      await store.atomic(file, [...queue, { post, attempts: 0, nextAttemptAt: 0 }]);
    },
    async flush(now = Date.now(), force = false) {
      let queue = await load();
      const due = queue.filter((item) => force || item.nextAttemptAt <= now);
      if (!due.length) return;
      const target = await config();
      if (!target) return;
      const secret = (await readFile(target.secretFile, "utf8")).trim();
      if (!secret) throw new Error("웹훅 비밀키 파일이 비어 있습니다.");
      for (const item of due) {
        try {
          await send(item.post, target.url, secret, now);
          queue = queue.filter((other) => other !== item);
        } catch (error) {
          item.attempts++;
          item.nextAttemptAt = now + Math.min(60, 2 ** (item.attempts - 1)) * 60_000;
          console.warn("[blog-webhook] 전송 실패:", error instanceof Error ? error.message : error);
        }
        await store.atomic(file, queue);
      }
    },
  };
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { startCanonicalEditor } from "../../src/app/blog-editor/server";
import { markupFixture } from "../fixtures/markup-editor";

// The desktop blog tab frames the editor from its file:// renderer. Only the desktop
// option lets that cross-site iframe navigation in; `npm run blog:editor` keeps refusing it.
const iframeNavigation = { "sec-fetch-site": "cross-site", "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" };

/** node:http, because fetch (undici) rewrites sec-fetch-mode to "cors". */
function get(url: string, headers: Record<string, string> = {}, method = "GET", body?: string) {
  return new Promise<{ status: number; csp: string | undefined }>((resolve, reject) => {
    const req = httpRequest(url, { method, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode!, csp: res.headers["content-security-policy"] as string | undefined }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function withEditor(desktopFrame: boolean, run: (url: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "reels-embed-"));
  const web = path.join(root, "web");
  await mkdir(web);
  await writeFile(path.join(web, "index.html"), "<!doctype html><title>editor</title>");
  const server = await startCanonicalEditor(await markupFixture(root), web, undefined, undefined, desktopFrame ? { desktopFrame: true } : {});
  try {
    await run(server.url);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("CLI editor keeps refusing cross-site frames and frame-ancestors 'self'", async () => {
  await withEditor(false, async (url) => {
    assert.equal((await get(url + "/?blogEditor=1", iframeNavigation)).status, 403);
    const same = await get(url + "/?blogEditor=1", { "sec-fetch-site": "same-origin" });
    assert.equal(same.status, 200);
    assert.equal(same.csp, undefined);
    assert.match((await get(url + "/api/blog/frame")).csp!, /frame-ancestors 'self'$/);
  });
});

test("desktop editor admits only the iframe navigation to its page and limits ancestors to 'self' file:", async () => {
  await withEditor(true, async (url) => {
    const page = await get(url + "/?blogEditor=1", iframeNavigation);
    assert.equal(page.status, 200);
    assert.equal(page.csp, "frame-ancestors 'self' file:");
    assert.match((await get(url + "/api/blog/frame")).csp!, /frame-ancestors 'self' file:$/);
    // Everything else that is cross-site stays refused.
    for (const [target, headers] of [
      ["/?blogEditor=1", { ...iframeNavigation, "sec-fetch-dest": "document" }],
      ["/?blogEditor=1", { ...iframeNavigation, "sec-fetch-mode": "cors" }],
      ["/", iframeNavigation],
      ["/api/blog/document", iframeNavigation],
      ["/api/blog/frame", iframeNavigation],
    ] as const)
      assert.equal((await get(url + target, headers)).status, 403, `${target} ${JSON.stringify(headers)}`);
    const post = await get(url + "/api/blog/save", { ...iframeNavigation, "content-type": "application/json", origin: "null" }, "POST", "{}");
    assert.equal(post.status, 403);
  });
});

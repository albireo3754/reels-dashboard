import {MarkupReviewWorker} from "./review-worker";
import { AnnotationStore } from "./annotations";
import { MarkupStore } from "./markup-store";
import {proxyWorkflow} from "./workflow-proxy";
import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { CanonicalStore, type EditorConfig } from "./store";
import { frameScript } from "./frame-script";
export async function startCanonicalEditor(
  config: EditorConfig,
  webRoot = path.resolve("dist"),
) {
  const store = config.format === "markup" ? new MarkupStore(config) : new CanonicalStore(config);
  await store.load();
  const annotations = config.format === "markup" ? new AnnotationStore(config.canon) : undefined;
  const worker = config.format === "markup" ? new MarkupReviewWorker(config) : undefined;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const json = (code: number, value: unknown) => {
      res.writeHead(code, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(value));
    };
    try {
      const host = `127.0.0.1:${(server.address() as { port: number }).port}`;
      if (
        req.headers["sec-fetch-site"] === "cross-site" ||
        req.headers.host !== host ||
        (req.headers.origin && req.headers.origin !== `http://${host}`)
      )
        return json(403, { error: "Invalid origin" });
      const u = new URL(req.url ?? "/", `http://${host}`);
      if (await proxyWorkflow(req, res, u)) return;
      if (req.method === "POST") {
        if (
          req.headers.origin !== `http://${host}` ||
          !req.headers["content-type"]?.startsWith("application/json")
        )
          return json(403, { error: "Same-origin JSON required" });
        let body = "";
        for await (const c of req) {
          body += c;
          if (Buffer.byteLength(body) > 512000)
            throw new Error("본문이 너무 커요.");
        }
        const v = JSON.parse(body);
        if (u.pathname === "/api/blog/annotations" && annotations) return json(200, await annotations.update(v));
        if (u.pathname === "/api/blog/save")
          return json(200, await store.save(v));
        if (u.pathname === "/api/blog/review") {
          const request=await store.request(v);void worker?.tick();
          return json(200, request);
        }
        return json(404, { error: "Unknown action" });
      }
      if (req.method !== "GET")
        return json(405, { error: "Method not allowed" });
      if (u.pathname === "/api/blog/annotations" && annotations) return json(200, await annotations.list());
      if (u.pathname === "/api/blog/review-status" && worker)
        return json(200,{requests:await worker.status(),reviews:(await store.load()).reviews});
      if (u.pathname === "/api/blog/document")
        return json(200, await store.load());
      if (u.pathname === "/api/blog/frame") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; frame-ancestors 'self'",
        });
        res.end(await store.frame());
        return;
      }
      if (u.pathname === "/editor-frame.js") {
        res.writeHead(200, { "Content-Type": "text/javascript" });
        res.end(frameScript);
        return;
      }
      let file: string;
      if (u.pathname === "/api/blog/asset")
        file = await store.asset(
          u.searchParams.get("kind") ?? "",
          u.searchParams.get("name") ?? "",
        );
      else {
        if (u.pathname === "/" && !u.search) {
          res.writeHead(302, { Location: "/?blogEditor=1" });
          res.end();
          return;
        }
        if (
          u.pathname === "/index.html" ||
          (u.pathname === "/" && u.searchParams.has("blogEditor"))
        )
          file = path.join(webRoot, "index.html");
        else if (u.pathname.startsWith("/assets/"))
          file = path.resolve(webRoot, decodeURIComponent(u.pathname).slice(1));
        else return json(404, { error: "Not found" });
        const root = await realpath(webRoot);
        file = await realpath(file);
        if (!file.startsWith(root + path.sep)) throw new Error("Invalid path");
      }
      const types: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".css": "text/css",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".woff2": "font/woff2",
        ".svg": "image/svg+xml",
      };
      if (!(await stat(file)).isFile())
        return json(404, { error: "Not found" });
      res.writeHead(200, {
        "Content-Type": types[path.extname(file)] ?? "application/octet-stream",
      });
      res.end(await readFile(file));
    } catch (e) {
      json(409, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port ?? 4320, "127.0.0.1", resolve);
  });
  worker?.start();
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: async () => {
      await worker?.close();
      return new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}

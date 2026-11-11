import { readJsonBody } from "../lib/http";
import { errorMessage } from "../../shared/lib/errors";
import type {VisualEvidence} from "../../shared/markup-review";
import {MarkupReviewWorker} from "./review-worker";
import { AnnotationStore } from "./annotations";
import { MarkupStore } from "./markup-store";
import {proxyWorkflow} from "./workflow-proxy";
import {handleSuggest,type SuggestCall} from "./inline-suggest";
import {handleChat,type ChatCall} from "./blog-chat";
import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { CanonicalStore, type EditorConfig } from "./store";
import { frameScript } from "./frame-script";
export async function startCanonicalEditor(
  config: EditorConfig,
  webRoot = path.resolve("dist"),
  capture?: (url:string,bundleIds:string[],directory:string,revision:string)=>Promise<VisualEvidence[]>,
  nativeClipboard?: (text:string)=>void | Promise<void>,
  deps: {suggest?: SuggestCall; chat?: ChatCall; desktopFrame?: boolean} = {},
) {
  // desktopFrame: the desktop app embeds this page in an iframe of its file:// renderer.
  // Electron 45 accepted only `'self' file:` for that parent (`file://`, an exact file URL and `*` were refused).
  const frameAncestors = deps.desktopFrame ? "'self' file:" : "'self'";
  const store = config.format === "markup" ? new MarkupStore(config,capture?((ids,dir,rev)=>capture("http://127.0.0.1:"+(server.address() as {port:number}).port+"/api/blog/frame",ids,dir,rev)):undefined) : new CanonicalStore(config);
  await store.load();
  const annotations = config.format === "markup" ? new AnnotationStore(config.canon) : undefined;
  const worker = config.format === "markup" ? new MarkupReviewWorker(config) : undefined;
  let closing = false;
  const active = new Set<import("node:http").ServerResponse>();
  const server = createServer(async (req, res) => {
    active.add(res);
    res.once("close", () => active.delete(res));
    if (closing) res.shouldKeepAlive = false;
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
      // The desktop iframe's document request comes from the file:// parent, so it is cross-site.
      const desktopEmbed =
        deps.desktopFrame &&
        req.method === "GET" &&
        req.url === "/?blogEditor=1" &&
        req.headers["sec-fetch-dest"] === "iframe" &&
        req.headers["sec-fetch-mode"] === "navigate";
      if (
        (req.headers["sec-fetch-site"] === "cross-site" && !desktopEmbed) ||
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
        const v: any = await readJsonBody(req, 8_000_000, "본문이 너무 커요.");
        if (u.pathname === "/api/blog/annotations" && annotations) return json(200, await annotations.update(v));
        if (u.pathname === "/api/blog/copy-sticker-plan" && nativeClipboard) {
          if (typeof v.text !== "string" || !v.text.trim() || v.text.length > 20000) throw new Error("잘못된 배치 메모");
          await nativeClipboard(v.text);
          return json(200, {ok:true});
        }
        if (u.pathname === "/api/blog/save") {
          const result=await store.save(v);
          return json(200, {...result,document:{...result.document,...(nativeClipboard?{nativeClipboard:true}:{})}});
        }
        if (u.pathname === "/api/blog/suggest") {
          // Synchronous, read-only; abort the engine call when the editor cancels.
          const controller = new AbortController();
          res.once("close", () => {
            if (!res.writableFinished) controller.abort();
          });
          const result = await handleSuggest(store instanceof MarkupStore ? store : undefined, v, controller.signal, deps.suggest);
          if (res.destroyed) return;
          return json(result.status, result.body);
        }
        if (u.pathname === "/api/blog/chat") {
          // Synchronous, read-only; abort the engine call when the editor cancels.
          const controller = new AbortController();
          res.once("close", () => {
            if (!res.writableFinished) controller.abort();
          });
          const result = await handleChat(store instanceof MarkupStore ? store : undefined, v, controller.signal, deps.chat);
          if (res.destroyed) return;
          return json(result.status, result.body);
        }
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
        {
        const current=await store.load();
        return json(200,{requests:await worker.status(),reviews:current.reviews,revision:current.revision});
      }
      if (u.pathname === "/api/blog/evidence" && store instanceof MarkupStore)
        return json(200, await store.evidenceLibrary());
      if (u.pathname === "/api/blog/document")
        return json(200, {...await (store instanceof MarkupStore?store.load(true):store.load()),...(nativeClipboard?{nativeClipboard:true}:{})});
      if (u.pathname === "/api/blog/frame") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; frame-ancestors " + frameAncestors,
        });
        res.end(await store.frame());
        return;
      }
      if (u.pathname === "/editor-frame.js") {
        res.writeHead(200, { "Content-Type": "text/javascript" });
        res.end(frameScript);
        return;
      }
      if(u.pathname==="/api/blog/review-image"&&config.requests){
        const id=u.searchParams.get("request")??"",index=Number(u.searchParams.get("index"));
        if(!/^[0-9a-f-]{36}$/i.test(id)||!Number.isInteger(index)||index<0)return json(400,{error:"Invalid evidence"});
        const request=JSON.parse(await readFile(path.join(config.requests,id+".json"),"utf8"));
        const evidence=request.visualEvidence?.[index];if(!evidence)return json(404,{error:"Evidence missing"});
        const root=await realpath(path.join(config.requests,"evidence",id)),file=await realpath(evidence.path);
        if(!file.startsWith(root+path.sep)||!file.endsWith(".png"))return json(403,{error:"Invalid evidence path"});
        res.writeHead(200,{"Content-Type":"image/png"});res.end(await readFile(file));return;
      }
      let file: string;
      if (u.pathname === "/api/blog/asset")
        file = await store.asset(
          u.searchParams.get("kind") ?? "",
          u.searchParams.get("name") ?? "",
        );
      else if (u.pathname === "/api/blog/evidence-image" && store instanceof MarkupStore)
        file = await store.evidenceImage(u.searchParams.get("id") ?? "", u.searchParams.has("thumbnail"));
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
        ...(deps.desktopFrame && path.extname(file) === ".html" ? { "Content-Security-Policy": "frame-ancestors " + frameAncestors } : {}),
      });
      res.end(await readFile(file));
    } catch (e) {
      json(409, { error: errorMessage(e) });
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
      // A page that keeps polling (review-status every 1.5s) reuses its keep-alive socket
      // forever, so server.close() alone may never finish. Answer in-flight requests with
      // "Connection: close", drop idle sockets, and force the rest after a short grace period.
      closing = true;
      for (const res of active) if (!res.headersSent) res.shouldKeepAlive = false;
      return new Promise<void>((resolve, reject) => {
        const force = setTimeout(() => server.closeAllConnections(), 2000);
        force.unref();
        server.close((e) => {
          clearTimeout(force);
          if (e) reject(e);
          else resolve();
        });
        server.closeIdleConnections();
      });
    },
  };
}

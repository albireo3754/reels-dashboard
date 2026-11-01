import { createServer, type Server } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { LocalStore } from "../shared/lib/storage";
import { parseReferences } from "../shared/blog-references";
import type { BlogResult } from "../shared/blog";
const registry = z
  .array(
    z.strictObject({ id: z.string(), directory: z.string().startsWith("/") }),
  )
  .max(100);
const allowed =
  /^(?:index\.html|blog-preview\.(?:js|css)|(?:restore-)?viewer\.(?:js|css)|reference-(?:structures|templates)\.(?:json|md)|render-spec\.md|restore-report\.json|fonts\/[\w.-]+\.woff2?|media\/[^/\\]+\.(?:png|jpe?g|webp|gif))$/i;
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".md": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
export class BlogResults {
  private servers = new Map<string, { server: Server; url: string }>();
  /** `changed` fires after the registry changes, so open UIs refresh when MCP links/unlinks a folder. */
  constructor(private store: LocalStore, private changed: () => void = () => {}) {}
  private get file() {
    return path.join(this.store.root, "blog-results.json");
  }
  private async entries() {
    try {
      return registry.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }
  private async describe(entry: {
    id: string;
    directory: string;
  }): Promise<BlogResult> {
    try {
      const text = await this.readStructures(entry.directory);
      const refs = parseReferences(text);
      let preview = false;
      try {
        preview = (
          await stat(path.join(entry.directory, "index.html"))
        ).isFile();
      } catch {}
      return {
        ...entry,
        names: refs.map((r) => r.name),
        blocks: refs.reduce((n, r) => n + r.blocks.length, 0),
        preview,
      };
    } catch (e) {
      return {
        ...entry,
        names: [path.basename(entry.directory)],
        blocks: 0,
        preview: false,
        error: String(e),
      };
    }
  }
  private async readStructures(directory: string) {
    for (const name of [
      "reference-structures.json",
      "reference-structures.md",
    ]) {
      try {
        const file = path.join(directory, name);
        if ((await realpath(file)) !== file)
          throw new Error("연결 경로가 변경됐어요.");
        if ((await stat(file)).size > 10 * 1024 * 1024)
          throw new Error("10MB 이하의 구조 파일을 선택해주세요.");
        return await readFile(file, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    throw new Error("reference-structures.json 또는 .md 파일이 없는 폴더예요.");
  }
  async list() {
    return Promise.all(
      (await this.entries()).map((entry) => this.describe(entry)),
    );
  }
  async register(directory: string) {
    const resolved = await realpath(
      z.string().startsWith("/").max(4096).parse(directory),
    );
    parseReferences(await this.readStructures(resolved));
    const entries = await this.entries();
    const entry = {
      id: createHash("sha256").update(resolved).digest("hex"),
      directory: resolved,
    };
    if (!entries.some((e) => e.id === entry.id)) {
      entries.push(entry);
      await this.store.atomic(this.file, registry.parse(entries));
    }
    this.changed();
    return this.describe(entry);
  }
  /** Unlinks a registered folder (e.g. after it was moved). Never touches the folder's files. */
  async remove(id: string) {
    const entries = await this.entries();
    const next = entries.filter((e) => e.id !== id);
    if (next.length === entries.length) throw new Error("등록된 분석 결과를 선택해주세요.");
    await this.store.atomic(this.file, registry.parse(next));
    const running = this.servers.get(id);
    if (running) {
      running.server.closeAllConnections();
      running.server.close();
      this.servers.delete(id);
    }
    this.changed();
    return { removed: id };
  }
  private async entry(id: string) {
    const entry = (await this.entries()).find((e) => e.id === id);
    if (!entry) throw new Error("등록된 분석 결과를 선택해주세요.");
    return entry;
  }
  async read(id: string) {
    return this.readStructures((await this.entry(id)).directory);
  }
  async preview(id: string) {
    const entry = await this.entry(id);
    if (this.servers.has(id)) return this.servers.get(id)!.url;
    const token = randomBytes(24).toString("hex");
    const prefix = "/" + token + "/";
    const server = createServer(async (req, res) => {
      try {
        if (req.method !== "GET") throw new Error("method");
        const url = new URL(req.url ?? "", "http://localhost");
        if (!url.pathname.startsWith(prefix)) throw new Error("token");
        const name =
          decodeURIComponent(url.pathname.slice(prefix.length)) || "index.html";
        if (!allowed.test(name)) throw new Error("file");
        const file = path.resolve(entry.directory, name);
        if (
          !file.startsWith(entry.directory + path.sep) ||
          (await realpath(file)) !== file
        )
          throw new Error("path");
        const body = await readFile(file);
        res
          .writeHead(200, {
            "Content-Type":
              types[path.extname(file)] ?? "application/octet-stream",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          })
          .end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("미리보기를 열지 못했어요.");
    const url = `http://127.0.0.1:${address.port}${prefix}`;
    this.servers.set(id, { server, url });
    return url;
  }
  dispose() {
    for (const { server } of this.servers.values()) {
      server.closeAllConnections();
      server.close();
    }
    this.servers.clear();
  }
}

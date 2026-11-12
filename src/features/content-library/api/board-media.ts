import { sha256Hex } from "../../../shared/lib/hash";
import { ExecutionLogs } from "../../../shared/lib/execution-logs";
import { loggedSpawn } from "../../../shared/lib/logged-process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { type ChildProcess } from "node:child_process";
import path from "node:path";
import {
  mediaKind,
  type ContentMediaOpenOptions,
  type OpenedContentMedia,
} from "../../../shared/content-media";
import { ContentLibrary } from "./library";
import { parseRange } from "../../../shared/lib/http-range";
import {
  isDatalessFile,
  videoContentType,
  type PlaybackMode,
} from "../../../shared/lib/media-playback";

export class BoardMedia {
  private thumbnails = new Map<string, Promise<string>>();
  private grants = new Map<
    string,
    { projectId: string; source: string; file: string; type: string }
  >();
  private pending = new Map<string, Promise<void>>();
  private children = new Set<ChildProcess>();
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  constructor(
    private library: ContentLibrary,
    private cache: string,
    private runtime: string,
    private logs: ExecutionLogs,
    private thumbnailer: (file: string, width: number) => Promise<string>,
    private dataless: (file: string) => Promise<boolean> = isDatalessFile,
  ) {}
  async thumbnail(projectId: string, file: string) {
    const checked = await this.library.resolveMedia(projectId, file);
    if (
      !["image", "video"].includes(mediaKind(file)) ||
      checked.info.isDirectory()
    )
      throw new Error("미리보기 없음");
    const key = `${file}:${checked.info.size}:${checked.info.mtimeMs}`;
    if (!this.thumbnails.has(key)) {
      if (this.thumbnails.size >= 128)
        this.thumbnails.delete(this.thumbnails.keys().next().value!);
      this.thumbnails.set(
        key,
        this.thumbnailer(file, 360).catch((e) => {
          this.thumbnails.delete(key);
          throw e;
        }),
      );
    }
    return this.thumbnails.get(key)!;
  }
  async open(
    projectId: string,
    source: string,
    options: ContentMediaOpenOptions = {},
  ): Promise<OpenedContentMedia> {
    const checked = await this.library.resolveMedia(projectId, source);
    if (checked.info.isDirectory())
      throw new Error("재생할 파일을 선택해주세요.");
    const kind = mediaKind(source);
    if (kind === "image")
      return { kind, url: await this.thumbnailer(source, 1600) };
    if (kind !== "video" && kind !== "audio")
      throw new Error("이 자료는 위치 열기로 확인해주세요.");
    let file = checked.path;
    let playback: PlaybackMode | undefined;
    if (kind === "video") {
      // Originals stream as they are. A cached copy is made only after the renderer
      // could not play the original, or for an iCloud file that is not downloaded.
      playback =
        options.copy === true || (await this.dataless(checked.path))
          ? "copy"
          : "original";
      if (playback === "copy") file = await this.copy(projectId, source, checked.info);
    }
    await this.library.resolveMedia(projectId, source);
    const token = randomUUID();
    if (this.grants.size >= 128)
      this.grants.delete(this.grants.keys().next().value!);
    const type =
      kind === "video"
        ? playback === "copy"
          ? "video/mp4"
          : videoContentType(file)
        : { ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4" }[
            path.extname(file).toLowerCase()
          ]!;
    this.grants.set(token, { projectId, source, file, type });
    return {
      kind,
      url: `reels-media://content/${token}`,
      ...(playback ? { playback } : {}),
    };
  }
  private async copy(
    projectId: string,
    source: string,
    info: { size: number; mtimeMs: number },
  ) {
    const hash = sha256Hex(`${source}:${info.size}:${info.mtimeMs}`);
    await mkdir(this.cache, { recursive: true, mode: 0o700 });
    const file = path.join(this.cache, `${hash}.mp4`);
    if (!(await stat(file).catch(() => null))?.size) {
      if (!this.pending.has(file)) {
        const work = this.queue.then(() => this.proxy(source, file, projectId));
        this.pending.set(file, work);
        this.queue = work.catch(() => {});
        void work.finally(() => this.pending.delete(file)).catch(() => {});
      }
      await this.pending.get(file);
    }
    return file;
  }
  private async proxy(source: string, output: string, projectId: string) {
    if (this.closing) throw new Error("앱이 종료 중이에요.");
    const temporary = output + `.${randomUUID()}.mp4`;
    try {
      await new Promise<void>((resolve, reject) => {
        const child = loggedSpawn(
          this.logs, { source: "library", label: "보관함 재생용 사본 준비", projectId },
          path.join(this.runtime, "reels-editor"),
          ["proxy", source, temporary],
          { detached: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        this.children.add(child);
        const kill = () => {
          if (child.pid)
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {}
        };
        const timer = setTimeout(kill, 300_000);
        const finish = () => {
          clearTimeout(timer);
          this.children.delete(child);
        };
        child.once("error", () => {
          finish();
          reject(
            new Error(
              "재생용 사본을 준비하지 못했어요. 편집 엔진을 확인해주세요.",
            ),
          );
        });
        child.once("exit", (code) => {
          finish();
          code === 0
            ? resolve()
            : reject(
                new Error(
                  "재생용 사본 준비에 실패했어요. 원본을 확인한 뒤 다시 시도해주세요.",
                ),
              );
        });
      });
      await rename(temporary, output);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  dispose() {
    this.closing = true;
    for (const child of this.children)
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
  }
  async media(request: Request): Promise<Response> {
    const origin = request.headers.get("origin");
    const initiator = (request as Request & { initiatorOrigin?: string })
      .initiatorOrigin;
    if (
      (origin && !["null", "file://"].includes(origin)) ||
      (initiator && !["null", "file://"].includes(initiator))
    )
      return new Response(null, { status: 403 });
    const cors = {
      "access-control-allow-origin": origin === "file://" ? "file://" : "null",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-allow-headers": "Range",
      "access-control-expose-headers":
        "Content-Range, Content-Length, Accept-Ranges",
      vary: "Origin",
    };
    try {
      const url = new URL(request.url);
      if (
        url.host !== "content" ||
        url.search ||
        !["GET", "HEAD", "OPTIONS"].includes(request.method)
      )
        throw new Error();
      const grant = this.grants.get(url.pathname.slice(1));
      if (!grant) throw new Error();
      await this.library.resolveMedia(grant.projectId, grant.source);
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers: cors });
      const info = await stat(grant.file);
      const range = request.headers.get("range");
      let start = 0,
        end = info.size - 1;
      let invalid = false;
      if (range)
        try {
          ({ start, end } = parseRange(range, info.size));
        } catch {
          invalid = true;
        }
      // Also rejects an empty file without a Range header (end < start).
      if (
        invalid ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start > end ||
        start >= info.size
      )
        return new Response(null, {
          status: 416,
          headers: { ...cors, "content-range": `bytes */${info.size}` },
        });
      const headers = {
        ...cors,
        "content-type": grant.type,
        "content-length": String(end - start + 1),
        "accept-ranges": "bytes",
        ...(range
          ? { "content-range": `bytes ${start}-${end}/${info.size}` }
          : {}),
      };
      if (request.method === "HEAD")
        return new Response(null, { status: range ? 206 : 200, headers });
      const stream = createReadStream(grant.file, { start, end });
      request.signal.addEventListener("abort", () => stream.destroy(), {
        once: true,
      });
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: range ? 206 : 200,
        headers,
      });
    } catch {
      return new Response(null, { status: 404, headers: cors });
    }
  }
}

import { realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { parseRange } from "../../../shared/lib/http-range";
import {
  isDatalessFile,
  videoContentType,
} from "../../../shared/lib/media-playback";
export const safeID = (id: unknown) => {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
    throw new Error("알 수 없는 편집 작업이에요.");
  return id;
};
/** The EditorService state the reels-media:// handler reads. */
export interface MediaDeps {
  record: (id: string) => Promise<{ sourcePath: string }>;
  copyPath: (id: string) => string;
  dir: (id: string) => string;
  options: { dataless?: (file: string) => Promise<boolean> };
}
export async function serveMedia(
  request: Request,
  deps: MediaDeps,
): Promise<Response> {
  const origin = request.headers.get("origin");
  const initiator = (request as Request & { initiatorOrigin?: string })
    .initiatorOrigin;
  if (
    (origin && !["null", "file://"].includes(origin)) ||
    (initiator && !["null", "file://"].includes(initiator))
  )
    return new Response("Forbidden", { status: 403 });
  const cors = {
    "access-control-allow-origin": origin === "file://" ? "file://" : "null",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "Range",
    "access-control-expose-headers":
      "Content-Range, Accept-Ranges, Content-Length",
    vary: "Origin",
  };
  try {
    const u = new URL(request.url);
    if (
      u.host !== "video" ||
      !["GET", "HEAD", "OPTIONS"].includes(request.method) ||
      u.search
    )
      throw new Error();
    // reels-media://video/{id} streams the original; /{id}/copy the playback copy.
    const [name, variant, ...extra] = u.pathname.slice(1).split("/");
    if (extra.length || (variant !== undefined && variant !== "copy"))
      throw new Error();
    const id = safeID(name);
    const record = await deps.record(id);
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors });
    const copy = variant === "copy";
    let file: string;
    if (copy) {
      file = await realpath(deps.copyPath(id));
      if (!file.startsWith((await realpath(deps.dir(id))) + path.sep))
        throw new Error();
    } else file = record.sourcePath;
    const info = await stat(file);
    if (!info.isFile()) throw new Error();
    let range;
    try {
      range = parseRange(request.headers.get("range"), info.size);
    } catch {
      return new Response(null, {
        status: 416,
        headers: { ...cors, "content-range": `bytes */${info.size}` },
      });
    }
    // An evicted iCloud original would block until the whole file downloads.
    // Refusing it makes the renderer fall back to a playback copy instead. The
    // check runs once per load (the first range), not for every seek.
    if (
      !copy &&
      range.start === 0 &&
      (await (deps.options.dataless ?? isDatalessFile)(file))
    )
      return new Response(null, { status: 503, headers: cors });
    const headers = {
      ...cors,
      "content-type": copy ? "video/mp4" : videoContentType(file),
      "accept-ranges": "bytes",
      "content-length": String(range.end - range.start + 1),
      ...(range.partial
        ? {
            "content-range": `bytes ${range.start}-${range.end}/${info.size}`,
          }
        : {}),
    };
    if (request.method === "HEAD")
      return new Response(null, {
        status: range.partial ? 206 : 200,
        headers,
      });
    const stream = createReadStream(file, {
      start: range.start,
      end: range.end,
    });
    request.signal.addEventListener("abort", () => stream.destroy(), {
      once: true,
    });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: range.partial ? 206 : 200,
      headers,
    });
  } catch {
    return new Response("Not found", { status: 404, headers: cors });
  }
}

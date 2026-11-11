import { execFile } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { EVIDENCE_ID, type EvidenceImage, type EvidenceLibrary } from "../../shared/blog-evidence";
import { sha256Hex } from "../../shared/lib/hash";

const text = z.array(z.string()).catch([]);
const results = z.object({
  images: z.array(z.object({
    id: z.string().regex(EVIDENCE_ID),
    captureId: z.string(),
    path: z.string().refine(path.isAbsolute),
    kind: z.string(),
    time: z.union([z.string(), z.number()]).nullish(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    status: z.string(),
    fields: z.object({
      description: z.string().catch(""), tags: text, ocr: text, contextNotes: text, uncertainties: text,
      faceRegions: z.array(z.unknown()).catch([]),
    }).optional(),
  })),
});
type Row = z.infer<typeof results>["images"][number];
const EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const THUMBNAIL_PX = "400";
const run = promisify(execFile);

/** Read-only view of a completed evidence run; only listed images can be served or placed. */
export class EvidenceStore {
  private cache?: { key: string; rows: Map<string, Row>; unresolved: number };
  private thumbnails = new Map<string, Promise<string>>();
  constructor(readonly file: string) {}
  private async rows() {
    const info = await stat(this.file), key = info.mtimeMs + ":" + info.size;
    if (this.cache?.key === key) return this.cache;
    const images = results.parse(JSON.parse(await readFile(this.file, "utf8"))).images;
    const usable = images.filter(i => i.status === "resolved" && i.fields && i.sha256 && EXTENSIONS.has(path.extname(i.path).toLowerCase()));
    this.cache = { key, rows: new Map(usable.map(i => [i.id, i])), unresolved: images.length - usable.length };
    return this.cache;
  }
  private async row(id: string) {
    const row = (await this.rows()).rows.get(id);
    if (!row) throw new Error("분석 결과에 없는 사진이에요.");
    return row;
  }
  /** `placed` holds the manuscript's photo files, compared by bytes because names differ. */
  async library(placed: string[]): Promise<EvidenceLibrary> {
    const { rows, unresolved } = await this.rows();
    const hashes = new Set((await Promise.all(placed.map(file => readFile(file).then(sha256Hex, () => "")))).filter(Boolean));
    const list = [...rows.values()];
    return {
      connected: true, unresolved,
      usedIds: list.filter(i => hashes.has(i.sha256!)).map(i => i.id),
      items: list.map((i): EvidenceImage => ({
        id: i.id, captureId: i.captureId, kind: i.kind, time: i.time == null ? null : String(i.time),
        description: i.fields!.description, tags: i.fields!.tags, ocr: i.fields!.ocr,
        contextNotes: i.fields!.contextNotes, uncertainties: i.fields!.uncertainties, faceCount: i.fields!.faceRegions.length,
      })),
    };
  }
  async imagePath(id: string) { return (await this.row(id)).path; }
  /** Full frames are megabytes each, so the grid uses cached small copies beside the results. */
  async thumbnailPath(id: string) {
    const source = (await this.row(id)).path;
    let pending = this.thumbnails.get(id);
    if (!pending) {
      pending = this.makeThumbnail(id, source).finally(() => this.thumbnails.delete(id));
      this.thumbnails.set(id, pending);
    }
    return pending;
  }
  private async makeThumbnail(id: string, source: string) {
    const dir = path.join(path.dirname(this.file), "thumbnails"), target = path.join(dir, id + ".jpg");
    if (await stat(target).then(() => true, () => false)) return target;
    const temporary = `${target}.${process.pid}.tmp.jpg`;
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await run("sips", ["-s", "format", "jpeg", "-Z", THUMBNAIL_PX, source, "--out", temporary]);
      await rename(temporary, target);
      return target;
    } catch { return source; } // A slow picture is better than a missing one.
  }
  /** The media file name keeps the image ID, so a placed photo traces back to its table row. */
  async fileName(id: string) { return id + path.extname((await this.row(id)).path).toLowerCase(); }
  /** Copies verified bytes into the project's media folder; never replaces a different file. */
  async materialize(id: string, media: string) {
    const row = await this.row(id), target = path.join(media, await this.fileName(id));
    const bytes = await readFile(row.path);
    if (sha256Hex(bytes) !== row.sha256) throw new Error("분석 뒤에 사진 파일이 바뀌었어요. 분석 결과를 다시 확인해주세요.");
    try { await writeFile(target, bytes, { flag: "wx" }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (sha256Hex(await readFile(target)) !== row.sha256) throw new Error("미디어 폴더에 같은 이름의 다른 파일이 있어요: " + path.basename(target));
    }
  }
}

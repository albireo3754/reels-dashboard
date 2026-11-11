import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { Project } from "../../../shared/contracts";
import {
  clipUploadInput,
  type ClipUploadBridge,
  type ClipUploadResult,
} from "../../../shared/clip-upload";
import type { ContentLibrary } from "./library";
import { copyVerifiedFile, hash } from "./prepare-local-media";

const extensions = {
  video: [".mp4", ".mov", ".m4v"],
  cover: [".png", ".jpg", ".jpeg"],
};
function select(project: Project, kind: "video" | "cover", explicit?: string) {
  const matches = (role: string, file: string) =>
    (kind === "cover"
      ? role === "cover"
      : role === "final" || role === "draft") &&
    extensions[kind].includes(path.extname(file).toLowerCase());
  const resources = (project.resources ?? []).filter((r) =>
    matches(r.role, r.path),
  );
  const outbound =
    project.outbound?.files
      .filter((f) => matches(f.role, f.name))
      .map((f) => path.join(project.outbound!.directory, f.name)) ?? [];
  if (explicit) {
    if (
      !outbound.includes(explicit) &&
      !resources.some((r) => r.path === explicit)
    )
      throw new Error(
        `UPLOAD_SOURCE: 등록된 ${kind} 출력 파일을 선택해주세요.`,
      );
    return explicit;
  }
  let candidates = outbound;
  if (!candidates.length) {
    const exports =
      project.production?.exports.filter(
        (e) =>
          matches(e.role, e.path) && resources.some((r) => r.path === e.path),
      ) ?? [];
    const newest = exports
      .map((e) => e.recordedAt)
      .sort()
      .at(-1);
    candidates = newest
      ? exports.filter((e) => e.recordedAt === newest).map((e) => e.path)
      : resources.map((r) => r.path);
  }
  candidates = [...new Set(candidates)];
  if (candidates.length !== 1)
    throw new Error(
      `UPLOAD_SELECTION: ${kind} 후보가 ${candidates.length}개예요. get_content로 확인 후 ${kind}Path를 지정해주세요.`,
    );
  return candidates[0];
}

/** Disposable browser-upload copies. No publication, outbound write, or dashboard mutation. */
export class ClipUpload implements ClipUploadBridge {
  constructor(
    private library: Pick<ContentLibrary, "get" | "resolveDeliverySource">,
    private jpeg: (png: Uint8Array) => Promise<Uint8Array>,
    // Fixed ASCII /tmp path on macOS: independent of iCloud and localized user-data paths.
    private temporaryRoot = "/tmp",
  ) {}
  async create(value: unknown): Promise<ClipUploadResult> {
    const input = clipUploadInput.parse(value);
    const content = await this.library.get(input.projectId);
    if (content.updatedAt !== input.expectedUpdatedAt)
      throw new Error("STALE_DASHBOARD");
    const sources = {
      video: select(content.project, "video", input.videoPath),
      cover: select(content.project, "cover", input.coverPath),
    };
    const video = await this.library.resolveDeliverySource(
      input.projectId,
      sources.video,
    );
    const cover = await this.library.resolveDeliverySource(
      input.projectId,
      sources.cover,
    );
    if (cover.info.size > 50 * 1024 * 1024)
      throw new Error("UPLOAD_COVER_TOO_LARGE");
    const directory = await mkdtemp(
      path.join(this.temporaryRoot, "reels-clip-"),
    );
    try {
      await chmod(directory, 0o700);
      const videoPath = path.join(
        directory,
        "video" + path.extname(video.path).toLowerCase(),
      );
      const videoCopy = await copyVerifiedFile(
        video.path,
        videoPath,
        video.info,
      );
      const coverStage = path.join(
        directory,
        "source-cover" + path.extname(cover.path).toLowerCase(),
      );
      const coverCopy = await copyVerifiedFile(
        cover.path,
        coverStage,
        cover.info,
      );
      // Check current outbound identities, including files being replaced by an in-flight delivery.
      for (const [kind, copied] of [
        ["video", videoCopy],
        ["cover", coverCopy],
      ] as const) {
        const outbound = content.project.outbound;
        const expected = outbound?.files.find(
          (f) => path.join(outbound.directory, f.name) === sources[kind],
        );
        if (
          expected &&
          (expected.sha256 !== copied.sha256 || expected.bytes !== copied.bytes)
        )
          throw new Error("OUTBOUND_CHANGED");
      }
      const coverPath = path.join(directory, "cover.jpg");
      const jpeg = await this.jpeg(await readFile(coverStage));
      if (
        jpeg.length < 4 ||
        jpeg[0] !== 0xff ||
        jpeg[1] !== 0xd8 ||
        jpeg[jpeg.length - 2] !== 0xff ||
        jpeg[jpeg.length - 1] !== 0xd9
      )
        throw new Error("UPLOAD_JPEG_INVALID");
      await writeFile(coverPath, jpeg, { flag: "wx", mode: 0o600 });
      await unlink(coverStage);
      await chmod(videoPath, 0o600);
      const descriptionPath = path.join(directory, "description.txt");
      await writeFile(descriptionPath, input.description, {
        flag: "wx",
        mode: 0o600,
      });
      if (
        (await this.library.get(input.projectId)).updatedAt !==
        input.expectedUpdatedAt
      )
        throw new Error("STALE_DASHBOARD");
      const describe = async (file: string) => ({
        path: file,
        bytes: (await stat(file)).size,
        sha256: await hash(file),
      });
      const result = {
        projectId: input.projectId,
        createdAt: new Date().toISOString(),
        directory,
        sources,
        files: {
          video: { path: videoPath, ...videoCopy },
          cover: await describe(coverPath),
          description: await describe(descriptionPath),
        },
        cleanup: "temporary-manual-or-os" as const,
      };
      const receiptPath = path.join(directory, "receipt.json");
      await writeFile(
        receiptPath,
        JSON.stringify(
          {
            schemaVersion: 1,
            ...result,
            sourceHashes: { video: videoCopy.sha256, cover: coverCopy.sha256 },
          },
          null,
          2,
        ) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      return { ...result, receipt: await describe(receiptPath) };
    } catch (error) {
      // Only the new, private folder belongs to this invocation.
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}

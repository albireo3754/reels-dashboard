import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  configureOutboundInput,
  icloudDeliveryInput,
  icloudStatusInput,
  icloudPathsSchema,
  type ICloudBridge,
  type ICloudDeliveryJob,
  type ICloudUploadStatus,
  type OutboundFile,
} from "../../../shared/icloud-delivery";
import type { ContentLibrary } from "./library";
import { hash } from "./prepare-local-media";
import { publishOutbound } from "./publish-outbound";

/** One persistent outbound folder per project; history stays in app-local storage. */
export class ICloudDelivery implements ICloudBridge {
  private jobs = new Map<string, ICloudDeliveryJob>();
  private starting = new Set<string>();
  constructor(
    private library: Pick<
      ContentLibrary,
      "get" | "resolveDeliverySource" | "configureOutbound" | "completeOutbound"
    >,
    private exportRoot: string,
    private nativeStatus: (paths: string[]) => Promise<ICloudUploadStatus>,
    private historyRoot: string,
  ) {}
  get busy() {
    return (
      this.starting.size > 0 ||
      [...this.jobs.values()].some((j) => j.state === "copying")
    );
  }
  async list() {
    return structuredClone([...this.jobs.values()]);
  }
  private async withinRoot(candidate: string) {
    const root = await realpath(this.exportRoot);
    if (
      candidate !== path.resolve(candidate) ||
      !candidate.startsWith(root + path.sep)
    )
      throw new Error(
        "ICLOUD_DESTINATION: 설정된 iCloud 전달 폴더 안의 경로를 선택해주세요.",
      );
  }
  async status(paths: string[]) {
    icloudStatusInput.parse({ paths });
    for (const file of paths) {
      await this.withinRoot(file);
      if ((await realpath(file)) !== file)
        throw new Error("ICLOUD_DESTINATION: 심볼릭 링크는 사용할 수 없어요.");
    }
    return this.nativeStatus(paths);
  }
  async configure(value: unknown) {
    const input = configureOutboundInput.parse(value);
    const content = await this.library.get(input.projectId);
    if (content.updatedAt !== input.expectedUpdatedAt)
      throw new Error("STALE_DASHBOARD");
    await this.withinRoot(input.directory);
    if (
      (await realpath(path.dirname(input.directory))) !==
      path.dirname(input.directory)
    )
      throw new Error("OUTBOUND_PATH_CHANGED");
    if (content.project.outbound) {
      if (content.project.outbound.directory !== input.directory)
        throw new Error(
          "OUTBOUND_ALREADY_SET: 프로젝트의 기존 outbound를 사용해주세요.",
        );
      return content;
    }
    try {
      if (
        (await realpath(input.directory)) !== input.directory ||
        !(await stat(input.directory)).isDirectory()
      )
        throw new Error("OUTBOUND_PATH_CHANGED");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const files: OutboundFile[] = [];
    const seen = new Set<string>();
    // Adopt only this project's explicitly linked files, not arbitrary folder contents.
    for (const r of content.project.resources ?? []) {
      if (r.role === "folder" || path.dirname(r.path) !== input.directory)
        continue;
      const source = await this.library.resolveDeliverySource(
        input.projectId,
        r.path,
      );
      const name = path.basename(source.path),
        key = name.normalize("NFC").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      files.push({
        name,
        role:
          r.role === "cover"
            ? "cover"
            : r.role === "document"
              ? "document"
              : "final",
        bytes: source.info.size,
        sha256: await hash(source.path),
      });
    }
    return this.library.configureOutbound(
      input.projectId,
      input.directory,
      files,
      input.expectedUpdatedAt,
    );
  }
  async start(value: unknown) {
    const input = icloudDeliveryInput.parse(value);
    if (this.starting.has(input.projectId)) throw new Error("DELIVERY_BUSY");
    this.starting.add(input.projectId);
    try {
      for (const active of this.jobs.values())
        if (active.projectId === input.projectId) {
          if (active.state === "uploading") await this.get(active.id);
          if (active.state === "copying" || active.state === "uploading")
            throw new Error("DELIVERY_BUSY");
        }
      const content = await this.library.get(input.projectId);
      if (content.updatedAt !== input.expectedUpdatedAt)
        throw new Error("STALE_DASHBOARD: 프로젝트를 다시 조회해주세요.");
      const outbound = content.project.outbound;
      if (!outbound)
        throw new Error(
          "OUTBOUND_NOT_CONFIGURED: 프로젝트 outbound 폴더를 먼저 지정해주세요.",
        );
      await this.withinRoot(outbound.directory);
      for (const f of input.files)
        await this.library.resolveDeliverySource(input.projectId, f.sourcePath);
      const paths = icloudPathsSchema.parse(
        input.files.map((f) => path.join(outbound.directory, f.name)),
      );
      const job: ICloudDeliveryJob = {
        id: randomUUID(),
        projectId: input.projectId,
        destination: outbound.directory,
        state: "copying",
        createdAt: new Date().toISOString(),
        paths,
      };
      this.jobs.set(job.id, job);
      const history = path.join(
        this.historyRoot,
        createHash("sha256").update(input.projectId).digest("hex").slice(0, 24),
        job.id,
      );
      void publishOutbound(this.library, input, outbound, history, job.id)
        .then((result) => {
          job.receiptPath = result.receiptPath;
          job.files = result.files;
          job.state = "uploading";
        })
        .catch((error) => {
          job.state = "failed";
          job.error = error instanceof Error ? error.message : String(error);
        });
      return structuredClone(job);
    } finally {
      this.starting.delete(input.projectId);
    }
  }
  async get(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job)
      throw new Error(
        "DELIVERY_NOT_FOUND: 이 앱 실행에서 시작한 전달 작업을 선택해주세요.",
      );
    if (job.state === "uploading") {
      job.upload = await this.status(job.paths);
      if (job.upload.state === "completed") {
        for (const f of job.files ?? []) {
          const file = path.join(job.destination, f.name),
            info = await lstat(file);
          if (
            !info.isFile() ||
            info.isSymbolicLink() ||
            info.size !== f.bytes ||
            (await hash(file)) !== f.sha256
          ) {
            job.state = "failed";
            job.error = "OUTBOUND_CHANGED";
            return structuredClone(job);
          }
        }
        job.state = "completed";
      }
      if (job.upload.state === "failed") {
        job.state = "failed";
        job.error = "ICLOUD_UPLOAD: iCloud 파일 상태를 확인해주세요.";
      }
    }
    return structuredClone(job);
  }
}

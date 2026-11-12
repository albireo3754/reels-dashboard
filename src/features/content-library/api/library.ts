import { validateDashboard } from "../../../shared/data";
import { randomUUID } from "node:crypto";
import {
  attachEdit,
  editKey,
  editOwner,
  linkEditSchema,
  mergeProjects,
  mergeProjectsSchema,
  recordExports,
  type EditRef,
  type MergeProjectsInput,
  type LinkEditInput,
} from "../../../shared/production-project";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  allChannelsPublished,
  withPublication,
  withoutPublication,
} from "../../../shared/publications";
import {
  mediaKind,
  type ContentMediaPage,
} from "../../../shared/content-media";
import type { LocalResource, Dashboard } from "../../../shared/contracts";
import {
  contentInputSchema,
  localPathSchema,
  setPublicationSchema,
  type ContentInput,
  type SetPublicationInput,
} from "../../../shared/local-resources";
import { LocalStore } from "../../../shared/lib/storage";
import { scanOrphanEdits } from "./orphan-edits";
import type { OutboundFile } from "../../../shared/icloud-delivery";

const media = new Set([
  ".mov",
  ".mp4",
  ".m4v",
  ".jpg",
  ".jpeg",
  ".png",
  ".heic",
  ".webp",
  ".m4a",
  ".mp3",
  ".wav",
  ".zip",
]);
export const mediaExtensions = [...media];
/** The path is registered, but the app does not handle this file type. */
export class UnsupportedMedia extends Error {}
const documents = new Set([".md", ".txt", ".json", ".srt", ".vtt", ".html"]);

export class ContentLibrary {
  constructor(
    private store: LocalStore,
    private changed: (dashboard: Dashboard) => void = () => {},
    private savedEdits: () => Promise<
      Array<EditRef & { title: string }>
    > = async () => [],
    /** Naver Clip export root: footage in the same first-level shoot folder counts as a folder match. */
    private clipRoot?: string,
  ) {}

  async listEdits() {
    const dashboard = await this.store.load();
    return (await this.savedEdits()).map((edit) => ({
      ...edit,
      ownerId: editOwner(dashboard, edit)?.id,
    }));
  }

  async linkEdit(value: LinkEditInput) {
    const input = linkEditSchema.parse(value);
    if (
      !(await this.savedEdits()).some((e) => editKey(e) === editKey(input.edit))
    )
      throw new Error("EDIT_NOT_FOUND: 저장된 편집 구성을 선택해주세요.");
    const dashboard = await this.store.update((current) => {
      const target = current.projects.find((p) => p.id === input.projectId);
      if (!target) throw new Error("CONTENT_NOT_FOUND");
      const owner = editOwner(current, input.edit);
      if (owner && owner.id !== target.id)
        throw new Error("EDIT_ALREADY_LINKED: 기존 카드를 먼저 합쳐주세요.");
      target.production = attachEdit(target, input.edit);
      return current;
    }, input.expectedUpdatedAt);
    this.changed(dashboard);
    return dashboard;
  }

  async merge(value: MergeProjectsInput) {
    const input = mergeProjectsSchema.parse(value);
    const edits = await this.savedEdits();
    let backupPath = "";
    const dashboard = await this.store.update(async (current) => {
      const before = structuredClone(current);
      for (const project of current.projects) {
        if (
          project.id !== input.targetId &&
          !input.sourceIds.includes(project.id)
        )
          continue;
        for (const edit of edits.filter((e) => e.id === project.id)) {
          const ref = { kind: edit.kind, id: edit.id };
          project.production = recordExports(
            project,
            ref,
            project.resources ?? [],
            new Date().toISOString(),
            randomUUID,
          );
        }
      }
      const next = mergeProjects(current, input.targetId, input.sourceIds);
      // Validate before backup/write. Snapshot preserves every source field for recovery.
      validateDashboard(next);
      backupPath = await this.store.document("project-merge-backup", before);
      return next;
    }, input.expectedUpdatedAt);
    this.changed(dashboard);
    return { dashboard, backupPath };
  }

  /**
   * Read-only: cards the video editor created on its own and the projects that may own them.
   * The project-tidy skill reviews this and merges with `merge()`; nothing merges here.
   */
  async scanOrphanEdits() {
    const dashboard = await this.store.load();
    const texts = new Map<string, string>();
    for (const project of dashboard.projects) {
      const parts: string[] = [];
      for (const r of project.resources ?? []) {
        if (r.role !== "document" || ![".md", ".txt", ".json"].includes(path.extname(r.path).toLowerCase())) continue;
        try {
          if ((await stat(r.path)).size <= 2 * 1024 * 1024) parts.push(await readFile(r.path, "utf8"));
        } catch {}
      }
      if (parts.length) texts.set(project.id, parts.join("\n"));
    }
    return { updatedAt: dashboard.updatedAt, cards: scanOrphanEdits(dashboard, this.clipRoot, texts) };
  }

  private async resolve(resource: LocalResource): Promise<LocalResource> {
    localPathSchema.parse(resource.path);
    const resolved = await realpath(resource.path);
    const info = await stat(resolved);
    if (resource.role === "folder" ? !info.isDirectory() : !info.isFile())
      throw new Error("INVALID_RESOURCE: 파일과 폴더 구분을 확인해주세요.");
    if (
      info.isFile() &&
      !(resource.role === "document" ? documents : media).has(
        path.extname(resolved).toLowerCase(),
      )
    )
      throw new Error(
        "INVALID_RESOURCE: 지원하는 미디어·문서 파일을 연결해주세요.",
      );
    return { ...resource, path: resolved };
  }

  async get(projectId: string) {
    const dashboard = await this.store.load();
    const project = dashboard.projects.find((p) => p.id === projectId);
    if (!project)
      throw new Error("CONTENT_NOT_FOUND: 등록한 콘텐츠를 찾지 못했어요.");
    const resources = await Promise.all(
      (project.resources ?? []).map(async (resource) => {
        try {
          const checked = await this.resolve(resource);
          const info = await stat(checked.path);
          return {
            ...resource,
            available: true,
            kind: info.isDirectory() ? "directory" : "file",
            bytes: info.isFile() ? info.size : undefined,
          };
        } catch (error) {
          return {
            ...resource,
            available: false,
            error: (error as NodeJS.ErrnoException).code ?? "INVALID_RESOURCE",
          };
        }
      }),
    );
    return { project, updatedAt: dashboard.updatedAt, resources };
  }

  async upsert(value: ContentInput, expectedUpdatedAt: string) {
    const input = contentInputSchema.parse(value);
    // Resolve every explicit reference before changing any state. Never read or copy media contents.
    const resources = await Promise.all(
      input.resources.map((r) => this.resolve(r)),
    );
    const keys = resources.map((r) => `${r.role}:${r.path}`);
    if (new Set(keys).size !== keys.length)
      throw new Error("DUPLICATE_RESOURCE: 같은 역할의 자료가 중복됐어요.");
    const dashboard = await this.store.update((current) => {
      if (
        current.projects.some((p) => p.production?.mergedIds.includes(input.id))
      )
        throw new Error(
          "PROJECT_MERGED: 합쳐진 ID예요. 대표 프로젝트 ID를 사용해주세요.",
        );
      const old = current.projects.find((p) => p.id === input.id);
      const project = {
        ...old,
        ...input,
        resources,
        shared: old?.shared ?? false,
      };
      current.projects = old
        ? current.projects.map((p) => (p.id === input.id ? project : p))
        : [...current.projects, project];
      return current;
    }, expectedUpdatedAt);
    this.changed(dashboard);
    return this.get(input.id);
  }

  /**
   * Records one channel's posting state without resending the whole entry.
   * The project is marked published once every channel it targets is live;
   * it is never moved back when a channel is added or reset later.
   */
  async setPublication(value: SetPublicationInput) {
    const input = setPublicationSchema.parse(value);
    const dashboard = await this.store.update((current) => {
      const old = current.projects.find((p) => p.id === input.projectId);
      if (!old)
        throw new Error(
          current.projects.some((p) =>
            p.production?.mergedIds.includes(input.projectId),
          )
            ? "PROJECT_MERGED: 합쳐진 ID예요. 대표 프로젝트 ID를 사용해주세요."
            : "CONTENT_NOT_FOUND: 등록한 콘텐츠를 찾지 못했어요.",
        );
      const publications =
        input.status === "none"
          ? withoutPublication(old.publications, input.channel)
          : withPublication(old.publications, {
              channel: input.channel,
              status: input.status,
              url: input.url ?? "",
              ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
            });
      const { publications: _previous, ...rest } = old;
      const project = {
        ...rest,
        ...(publications.length ? { publications } : {}),
      };
      if (allChannelsPublished(project)) project.stage = "published";
      current.projects = current.projects.map((p) =>
        p.id === old.id ? project : p,
      );
      return current;
    }, input.expectedUpdatedAt);
    this.changed(dashboard);
    return this.get(input.projectId);
  }

  async listFolder(directory: string, offset = 0, limit = 100) {
    localPathSchema.parse(directory);
    const resolved = await realpath(directory);
    if (!(await stat(resolved)).isDirectory())
      throw new Error("폴더 경로를 지정해주세요.");
    const entries = (await readdir(resolved, { withFileTypes: true }))
      .filter(
        (e) =>
          !e.name.startsWith(".") &&
          (e.isDirectory() ||
            (e.isFile() && media.has(path.extname(e.name).toLowerCase()))),
      )
      .sort((a, b) => a.name.localeCompare(b.name, "ko"));
    const page = await Promise.all(
      entries.slice(offset, offset + limit).map(async (e) => {
        const file = path.join(resolved, e.name);
        const info = await lstat(file);
        return {
          name: e.name,
          path: file,
          kind: e.isDirectory() ? "directory" : "file",
          bytes: info.size,
        };
      }),
    );
    return {
      directory: resolved,
      entries: page,
      total: entries.length,
      nextOffset: offset + limit < entries.length ? offset + limit : null,
    };
  }

  async configureOutbound(projectId: string, directory: string, files: OutboundFile[], expectedUpdatedAt: string) {
    const dashboard = await this.store.update(current => {
      const project = current.projects.find(p => p.id === projectId);
      if (!project) throw new Error("CONTENT_NOT_FOUND");
      if (project.outbound && project.outbound.directory !== directory)
        throw new Error("OUTBOUND_ALREADY_SET: 이 프로젝트는 기존 outbound 폴더를 사용해요.");
      project.outbound ??= { directory, generation: 0, files, updatedAt: new Date().toISOString() };
      return current;
    }, expectedUpdatedAt);
    this.changed(dashboard);
    return this.get(projectId);
  }

  async completeOutbound(projectId: string, directory: string, generation: number, files: OutboundFile[], receiptPath: string, archives: Array<{path:string; backup:string}>) {
    const dashboard = await this.store.update(current => {
      const p = current.projects.find(p => p.id === projectId);
      if (!p?.outbound || p.outbound.directory !== directory || p.outbound.generation !== generation)
        throw new Error("STALE_OUTBOUND: outbound가 변경됐어요.");
      const archived = new Map(archives.map(a => [a.path, a.backup]));
      const old = (p.resources ?? []).map(r => archived.has(r.path)
        ? {...r, path: archived.get(r.path)!, label: `이전 전달본 · ${path.basename(r.path)}`} : r);
      if (p.production) p.production.exports = p.production.exports.map(e => archived.has(e.path) ? {...e,path:archived.get(e.path)!} : e);
      const latest: LocalResource[] = files.map(f => ({role:f.role,path:path.join(directory,f.name),label:`outbound · ${f.name}`}));
      latest.push({role:"folder",path:directory,label:"프로젝트 outbound"});
      const seen = new Set<string>();
      p.resources = [...latest,...old].filter(r => { const key=r.path+"|"+r.role; if(seen.has(key))return false;seen.add(key);return true; });
      p.outbound = {directory,generation:generation+1,files,receiptPath,updatedAt:new Date().toISOString()};
      return current;
    });
    this.changed(dashboard);
    return this.get(projectId);
  }

  // Authorize every read against the current record, including folder descendants.
  private async resolveLinkedFile(projectId: string, candidate: string) {
    localPathSchema.parse(candidate);
    const dashboard = await this.store.load();
    const project = dashboard.projects.find((p) => p.id === projectId);
    if (!project) throw new Error("등록된 콘텐츠를 찾지 못했어요.");
    const normalized = path.resolve(candidate);
    const link = project.resources?.find(
      (r) =>
        r.path === normalized ||
        (r.role === "folder" && normalized.startsWith(r.path + path.sep)),
    );
    if (!link || normalized !== candidate)
      throw new Error("등록한 자료만 볼 수 있어요.");
    // Reject replacements by symlink, hidden descendants and escapes from linked folders.
    const base = link.role === "folder" ? link.path : path.dirname(link.path);
    const relative = path.relative(base, normalized);
    if (relative.split(path.sep).some((p) => p.startsWith(".")))
      throw new Error("숨김 자료는 표시하지 않아요.");
    if (
      (await realpath(normalized)) !== normalized ||
      (await lstat(normalized)).isSymbolicLink()
    )
      throw new Error("연결 경로가 변경됐어요. 자료를 다시 연결해주세요.");
    const info = await stat(normalized);
    if (
      !info.isDirectory() &&
      (!info.isFile() || !new Set([...media, ...documents]).has(path.extname(normalized).toLowerCase()))
    )
      throw new UnsupportedMedia("미리보기를 지원하지 않는 자료예요.");
    return { path: normalized, info, role: link.role };
  }

  async resolveMedia(projectId: string, candidate: string) {
    const result = await this.resolveLinkedFile(projectId, candidate);
    if (!result.info.isDirectory() && !media.has(path.extname(result.path).toLowerCase()))
      throw new UnsupportedMedia("미리보기를 지원하지 않는 자료예요.");
    return result;
  }

  async resolveDeliverySource(projectId: string, candidate: string) {
    const result = await this.resolveLinkedFile(projectId, candidate);
    if (!result.info.isFile()) throw new Error("전달할 파일을 선택해주세요.");
    return result;
  }

  async mediaPage(
    projectId: string,
    folder?: string,
    offset = 0,
  ): Promise<ContentMediaPage> {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Invalid page");
    const limit = 24;
    if (folder !== undefined) {
      const checked = await this.resolveMedia(projectId, folder);
      if (!checked.info.isDirectory()) throw new Error("폴더를 선택해주세요.");
      const page = await this.listFolder(checked.path, offset, limit);
      return {
        items: page.entries.map((e) => ({
          path: e.path,
          label: e.name,
          role: checked.role,
          kind: e.kind === "directory" ? "folder" : mediaKind(e.path),
          available: true,
          bytes: e.bytes,
        })),
        total: page.total,
        nextOffset: page.nextOffset,
      };
    }
    const { resources } = await this.get(projectId);
    return {
      items: resources.slice(offset, offset + limit).map((r) => ({
        path: r.path,
        label: r.label,
        role: r.role,
        kind: r.role === "folder" ? "folder" : mediaKind(r.path),
        available: r.available,
        bytes: "bytes" in r ? r.bytes : undefined,
      })),
      total: resources.length,
      nextOffset: offset + limit < resources.length ? offset + limit : null,
    };
  }

  async resolveLinked(projectId: string, resourcePath: string) {
    const { project } = await this.get(projectId);
    const resource = project.resources?.find((r) => r.path === resourcePath);
    if (!resource) throw new Error("등록된 자료만 열 수 있어요.");
    return (await this.resolve(resource)).path;
  }
}

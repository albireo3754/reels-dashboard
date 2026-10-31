import { z } from "zod";
import type { Dashboard, LocalResource, Project } from "./contracts";

export const editRefSchema = z.strictObject({
  kind: z.enum(["video", "card-news"]),
  id: z.uuid(),
});
export type EditRef = z.infer<typeof editRefSchema>;
export const productionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  edits: z.array(editRefSchema).max(500),
  mergedIds: z.array(z.string().min(1).max(160)).max(500),
  exports: z
    .array(
      z.strictObject({
        id: z.uuid(),
        edit: editRefSchema,
        path: z.string().startsWith("/").max(4096),
        role: z.enum(["draft", "final", "cover"]),
        recordedAt: z.iso.datetime(),
      }),
    )
    .max(2000),
});
export type Production = z.infer<typeof productionSchema>;
export const mergeProjectsSchema = z.strictObject({
  targetId: z.string().min(1).max(160),
  sourceIds: z.array(z.string().min(1).max(160)).min(1).max(100),
  expectedUpdatedAt: z.iso.datetime(),
});
export const linkEditSchema = z.strictObject({
  projectId: z.string().min(1).max(160),
  edit: editRefSchema,
  expectedUpdatedAt: z.iso.datetime(),
});
export type MergeProjectsInput = z.infer<typeof mergeProjectsSchema>;
export type LinkEditInput = z.infer<typeof linkEditSchema>;
export const emptyProduction = (): Production => ({
  schemaVersion: 1,
  edits: [],
  mergedIds: [],
  exports: [],
});
export const editKey = (edit: EditRef) => `${edit.kind}:${edit.id}`;
export function editOwner(dashboard: Dashboard, edit: EditRef) {
  return (
    dashboard.projects.find((p) =>
      p.production?.edits.some((e) => editKey(e) === editKey(edit)),
    ) ??
    dashboard.projects.find(
      (p) => p.id === edit.id || p.production?.mergedIds.includes(edit.id),
    )
  );
}
export function attachEdit(project: Project, edit: EditRef): Production {
  const model = project.production ?? emptyProduction();
  return {
    ...model,
    edits: model.edits.some((e) => editKey(e) === editKey(edit))
      ? model.edits
      : [...model.edits, edit],
  };
}
export function recordExports(
  project: Project,
  edit: EditRef,
  outputs: LocalResource[],
  now: string,
  newID: () => string,
): Production {
  const model = attachEdit(project, edit);
  return {
    ...model,
    exports: [
      ...model.exports,
      ...outputs
        .filter(
          (r) =>
            ["draft", "final", "cover"].includes(r.role) &&
            !model.exports.some(
              (e) =>
                e.path === r.path &&
                e.role === r.role &&
                editKey(e.edit) === editKey(edit),
            ),
        )
        .map((r) => ({
          id: newID(),
          edit,
          path: r.path,
          role: r.role as "draft" | "final" | "cover",
          recordedAt: now,
        })),
    ],
  };
}
export function validateProductionLinks(projects: Project[]) {
  const owners = new Set<string>();
  const aliases = new Map(projects.map((p) => [p.id, p.id]));
  const exportIDs = new Set<string>();
  for (const p of projects) {
    const model = p.production;
    if (!model) continue;
    for (const id of model.mergedIds) {
      if (aliases.has(id))
        throw new Error(
          "PROJECT_ALIAS_CONFLICT: 이미 사용 중인 프로젝트 ID예요.",
        );
      aliases.set(id, p.id);
    }
  }
  for (const p of projects) {
    const model = p.production;
    if (!model) continue;
    for (const edit of model.edits) {
      const key = editKey(edit);
      if (owners.has(key))
        throw new Error(
          "EDIT_ALREADY_LINKED: 편집 구성은 한 프로젝트에만 연결할 수 있어요.",
        );
      owners.add(key);
      if (aliases.has(edit.id) && aliases.get(edit.id) !== p.id)
        throw new Error(
          "EDIT_ALREADY_LINKED: 기존 편집 카드를 먼저 합쳐주세요.",
        );
    }
    for (const output of model.exports) {
      if (
        exportIDs.has(output.id) ||
        !model.edits.some((e) => editKey(e) === editKey(output.edit)) ||
        !p.resources?.some(
          (r) => r.path === output.path && r.role === output.role,
        )
      )
        throw new Error(
          "INVALID_PROJECT_EXPORT: 출력 이력의 편집 구성과 자료 연결을 확인해주세요.",
        );
      exportIDs.add(output.id);
    }
  }
}
export function mergeProjects(
  current: Dashboard,
  targetId: string,
  sourceIds: string[],
): Dashboard {
  const ids = new Set(sourceIds);
  const target = current.projects.find((p) => p.id === targetId);
  const sources = current.projects.filter((p) => ids.has(p.id));
  if (
    !target ||
    ids.has(targetId) ||
    ids.size !== sourceIds.length ||
    sources.length !== ids.size
  )
    throw new Error(
      "INVALID_PROJECT_MERGE: 서로 다른 기존 프로젝트를 선택해주세요.",
    );
  if (sources.some((p) => p.publicURL && p.publicURL !== target.publicURL))
    throw new Error(
      "PROJECT_PUBLICATION_CONFLICT: 게시 링크가 달라요. 게시 정보를 먼저 정리해주세요.",
    );
  const model = target.production ?? emptyProduction();
  const merged: Project = {
    ...target,
    resources: [...(target.resources ?? [])],
    production: {
      ...model,
      edits: [...model.edits],
      mergedIds: [...model.mergedIds],
      exports: [...model.exports],
    },
  };
  for (const source of sources) {
    for (const r of source.resources ?? [])
      if (
        !merged.resources!.some(
          (existing) => existing.path === r.path && existing.role === r.role,
        )
      )
        merged.resources!.push(r);
    const child = source.production ?? emptyProduction();
    merged.production!.mergedIds.push(source.id, ...child.mergedIds);
    merged.production!.edits.push(...child.edits);
    merged.production!.exports.push(...child.exports);
    if (source.localNotes)
      merged.localNotes = [
        merged.localNotes,
        `[${source.title}]\n${source.localNotes}`,
      ]
        .filter(Boolean)
        .join("\n\n");
  }
  // Target workflow/title/date/sharing win. The full pre-merge snapshot is backed up by the service.
  return {
    ...current,
    projects: current.projects
      .filter((p) => !ids.has(p.id))
      .map((p) => (p.id === targetId ? merged : p)),
  };
}

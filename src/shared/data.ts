import {
  productionSchema,
  validateProductionLinks,
} from "./production-project";
import { localResourcesSchema } from "./local-resources";
import type { Dashboard, Project, Snapshot } from "./contracts";
const stages = new Set([
  "idea",
  "captured",
  "selected",
  "editing",
  "review",
  "published",
]);
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max)
    throw new Error("Invalid dashboard text");
  return value;
}
export function validateDashboard(value: unknown): Dashboard {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.projects) ||
    value.projects.length > 10000
  )
    throw new Error("Unsupported dashboard schema");
  const seen = new Set<string>();
  const projects: Project[] = value.projects.map((p: unknown) => {
    if (
      !record(p) ||
      !stages.has(String(p.stage)) ||
      typeof p.shared !== "boolean"
    )
      throw new Error("Invalid project");
    const id = text(p.id, 160);
    if (!id || seen.has(id)) throw new Error("Duplicate or empty project ID");
    seen.add(id);
    const publicURL = text(p.publicURL, 2048);
    if (publicURL) {
      const u = new URL(publicURL);
      if (!["https:", "http:"].includes(u.protocol) || u.username || u.password)
        throw new Error("Public link must be HTTP(S)");
    }
    const date = text(p.date, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new Error("Invalid project date");
    return {
      id,
      ...(p.production !== undefined
        ? { production: productionSchema.parse(p.production) }
        : {}),
      title: text(p.title, 500),
      date,
      stage: p.stage as Project["stage"],
      nextAction: text(p.nextAction, 2000),
      publicURL,
      shared: p.shared,
      ...(p.resources !== undefined
        ? { resources: localResourcesSchema.parse(p.resources) }
        : {}),
      ...(p.localNotes !== undefined
        ? { localNotes: text(p.localNotes, 4000) }
        : {}),
      ...(p.dateBasis !== undefined
        ? {
            dateBasis: (() => {
              if (
                !["capture", "publication", "record"].includes(
                  String(p.dateBasis),
                )
              )
                throw new Error("Invalid date basis");
              return p.dateBasis as Project["dateBasis"];
            })(),
          }
        : {}),
    };
  });
  validateProductionLinks(projects);
  const updatedAt = text(value.updatedAt, 40);
  if (!Number.isFinite(Date.parse(updatedAt)))
    throw new Error("Invalid update time");
  return { schemaVersion: 1, projects, updatedAt };
}
export function toSnapshot(
  value: Dashboard,
  now = new Date().toISOString(),
): Snapshot {
  const valid = validateDashboard(value);
  return {
    schemaVersion: 1,
    generatedAt: now,
    projects: valid.projects
      .filter((p) => p.shared)
      .map(({ id, title, date, stage, nextAction, publicURL }) => ({
        id,
        title,
        date,
        stage,
        nextAction,
        publicURL,
      })),
  };
}
export function fromSnapshot(value: unknown): Dashboard {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    typeof value.generatedAt !== "string" ||
    !Array.isArray(value.projects)
  )
    throw new Error("Unsupported snapshot schema");
  return validateDashboard({
    schemaVersion: 1,
    updatedAt: value.generatedAt,
    projects: value.projects.map((p) => {
      if (!record(p)) throw new Error("Invalid snapshot project");
      return {
        id: p.id,
        title: p.title,
        date: p.date,
        stage: p.stage,
        nextAction: p.nextAction,
        publicURL: p.publicURL,
        shared: true,
      };
    }),
  });
}

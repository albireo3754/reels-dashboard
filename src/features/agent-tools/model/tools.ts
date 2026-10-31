import { z } from "zod";
import { settingsPatchSchema } from "../../../entities/agent-session";

const id = z.string().uuid();
const revision = z
  .string()
  .datetime()
  .describe("updatedAt returned by get_project; stale revisions are rejected.");
const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .startsWith("/")
  .refine((v) => !v.includes("\0"));
const nativeID = z
  .string()
  .min(1)
  .max(500)
  .refine((v) => !v.includes("\0"));
export const toolDefinitions = {
  reels_get_app_state: {
    description:
      "Read live editor selection, unsaved changes, current time, runtime availability and render jobs. Start here; unsaved UI changes must not be overwritten.",
    input: z.strictObject({}),
    readOnly: true,
  },
  reels_list_projects: {
    description:
      "List saved editing projects and production dashboard entries. Content prose remains in the content workspace.",
    input: z.strictObject({}),
    readOnly: true,
  },
  reels_get_project: {
    description:
      "Read a saved project and its updatedAt revision before editing or rendering. Does not change the selected UI project.",
    input: z.strictObject({ projectId: id }),
    readOnly: true,
  },
  reels_open_project: {
    description:
      "Open a saved project in the app. Refuses to replace unsaved UI edits.",
    input: z.strictObject({ projectId: id }),
    readOnly: false,
  },
  reels_import_video: {
    description:
      "Import an explicitly selected local video without changing its source. Optionally reuse settings from a revision-checked project; creates a new project, not an overwrite. Proxy generation may take time.",
    input: z.strictObject({
      sourcePath: absolutePath,
      reuse: z
        .strictObject({ projectId: id, expectedUpdatedAt: revision })
        .optional(),
    }),
    readOnly: false,
  },
  reels_update_project: {
    description:
      "Patch only specified place-guide, body-caption, or cover fields. Coordinates select manual placement unless explicitly overridden. Caption items replace the full list; omitted fields are preserved. hookSize:null restores template sizing. Returns a new revision.",
    input: z.strictObject({
      projectId: id,
      expectedUpdatedAt: revision,
      patch: settingsPatchSchema,
    }),
    readOnly: false,
  },
  reels_preview_frame: {
    description:
      "Generate a real PNG and resolved style manifest for one saved project revision. Video uses time; cover uses settings.cover.time. Check only the requested visual change rather than extracting every frame.",
    input: z.strictObject({
      projectId: id,
      expectedUpdatedAt: revision,
      kind: z.enum(["video", "cover"]),
      time: z.number().min(0).optional(),
    }),
    readOnly: true,
  },
  reels_start_render: {
    description:
      "Render video, cover, or both to a new absolute output path. Never overwrites files. Returns a job ID immediately; poll get_render_job until terminal. Does not publish or upload. App owns the job after MCP disconnects.",
    input: z.strictObject({
      projectId: id,
      expectedUpdatedAt: revision,
      target: z.enum(["video", "cover", "both"]),
      outputPath: absolutePath,
    }),
    readOnly: false,
  },
  reels_get_render_job: {
    description:
      "Read actual render progress, terminal state, errors, output paths and style manifest paths. A running job is not completion.",
    input: z.strictObject({ jobId: id }),
    readOnly: true,
  },
  reels_cancel_render: {
    description:
      "Cancel an existing render and wait for its process cleanup. Original media is preserved.",
    input: z.strictObject({ jobId: id }),
    readOnly: false,
  },
  reels_list_templates: {
    description:
      "List templates and their current defaults supported by the bundled engine. Per-content choices do not become global defaults. Output manifests are the evidence of resolved styles.",
    input: z.strictObject({}),
    readOnly: true,
  },
  reels_photos_status: {
    description:
      "Read Photos helper status and existing authorization. This does not grant Photos permission.",
    input: z.strictObject({}),
    readOnly: true,
  },
  reels_photos_search: {
    description: "Search Photos without knowing a capture date. Filter by GPS center/radius, OCR text, or both. Optional inclusive dates narrow the library. Creates a temporary candidate snapshot without replacing the current date index. OCR examines photo/video preview images, not every video frame; misses are possible. Returns scanned count, failures and nextOffset; continue pages even when matches is empty. No Photos changes.",
    input: z.strictObject({
      text: z.string().trim().min(1).max(100).optional(),
      location: z.strictObject({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), radiusMeters: z.number().min(1).max(100000) }).optional(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      pageSize: z.number().int().min(1).max(10).default(5),
    }).refine(value => !!value.text || !!value.location, "Provide OCR text or location"),
    readOnly: true,
  },
  reels_photos_search_page: {
    description: "Continue a Photos search snapshot using its searchId and nextOffset. Offset counts candidates scanned, not matches. Snapshots expire after 30 minutes or helper restart. OCR failures are reported separately. Does not change the current date index.",
    input: z.strictObject({ searchId: nativeID, offset: z.number().int().min(0), pageSize: z.number().int().min(1).max(10).default(5) }),
    readOnly: true,
  },
  reels_photos_index: {
    description:
      "Index an explicitly requested local capture date through the Photos helper. Requires existing Photos permission and returns index-run identifiers used by subsequent tools.",
    input: z.strictObject({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    readOnly: false,
  },
  reels_photos_groups: {
    description:
      "List groups from the current Photos index. Index-run identifiers are temporary, not persistent editing project IDs.",
    input: z.strictObject({ level: z.enum(["coarse", "fine"]) }),
    readOnly: true,
  },
  reels_photos_group: {
    description: "Read assets and metadata in one current Photos group.",
    input: z.strictObject({ groupId: nativeID, indexRunId: nativeID }),
    readOnly: true,
  },
  reels_photos_inspect: {
    description:
      "Generate one bounded evidence page with sample paths, OCR and privacy flags. Does not move or delete Photos assets.",
    input: z.strictObject({
      groupId: nativeID,
      indexRunId: nativeID,
      page: z.number().int().min(1),
      pageSize: z.number().int().min(1).max(10),
    }),
    readOnly: true,
  },
  reels_import_photos_video: {
    description:
      "Import a selected video from the current Photos index into a new edit project using the app's checked materialization service. No Photos deletion.",
    input: z.strictObject({
      groupId: nativeID,
      indexRunId: nativeID,
      assetId: nativeID,
    }),
    readOnly: false,
  },
} as const;
export type ToolName = keyof typeof toolDefinitions;

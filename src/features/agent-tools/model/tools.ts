import { selectionQuery, selectionExecute, selectionUpdate } from "../../../shared/analysis-selection";
import { editsTools } from "../../../shared/edits";
import { clipUploadInput, coverPreferencesSchema } from "../../../shared/clip-upload";
import { gifConvertInput } from "../../../shared/gif-convert";
import { planningUpdateSchema } from "../../../shared/planning";
import { instagramTopicsInput } from "../../../shared/instagram-insights";
import {inputFormTools} from "../../../shared/input-form-tools";
import {formIdInput} from "../../../shared/input-forms";
import { analysisStart, analysisQuery, analysisCorrection } from "../../../shared/media-analysis";
import { dashboardRevision, mergeProjectsSchema, linkEditSchema } from "../../../shared/production-project";
import { z } from "zod";
import { absolutePathSchema } from "../../../shared/path-schema";
import { configureOutboundInput, icloudDeliveryInput, icloudStatusInput } from "../../../shared/icloud-delivery";
import { publishReadinessInput } from "../../../shared/publish-readiness";
import { blogExtractInput } from "../../../shared/blog-restore";
import { blogCommentCreate, blogCommentDelete, blogCommentList, blogCommentUpdate } from "../../../shared/blog-comments";
import {
  contentInputSchema,
  localPathSchema,
  setPublicationSchema,
} from "../../../shared/local-resources";
import { settingsPatchSchema } from "../../../entities/agent-session";

/** Operating rules shared by the MCP server and the `reels` CLI. */
export const agentGuidance =
  "Use get_app_state first, then get_project before editing. Respect unsaved UI changes and updatedAt revisions. Keep place guide, captions and cover independent. Preview the requested frame and inspect the actual image. Render jobs must reach terminal state before claiming completion. Do not retry uncertain writes automatically. Each project has one saved iCloud outbound folder. Delivery updates its managed files and keeps prior versions locally; do not create folders per version. Local copy is not upload completion. Photos originals stay untouched by default: Photos tools only read, and imports copy the original into app storage. No social publishing, Photos deletion or move, or arbitrary shell execution is provided. Content prose stays in the content workspace.";

const id = z.string().uuid();
const revision = z
  .string()
  .datetime()
  .describe("updatedAt returned by get_project; stale revisions are rejected.");
const absolutePath = absolutePathSchema();
const nativeID = z
  .string()
  .min(1)
  .max(500)
  .refine((v) => !v.includes("\0"));
const formDefinitions = Object.fromEntries(inputFormTools.map(([_action,name,input,description,readOnly])=>[name,{input,description,readOnly}])) as Record<typeof inputFormTools[number][1], {input:typeof inputFormTools[number][2];description:string;readOnly:boolean}>;
export const toolDefinitions = {
  ...editsTools,
  reels_get_instagram_insights: {
    description: "Read private Instagram connection status, latest or selected snapshot, history and topic labels. Never returns tokens or credential paths; does not call Instagram. No insights enter shared snapshots.",
    input: z.strictObject({ snapshotId: z.string().uuid().optional() }), readOnly: true,
  },
  reels_refresh_instagram_insights: {
    description: "Start reading the connected owner's Instagram profile and latest 100 media insights using the desktop's configured token file. Returns immediately; poll get_instagram_insights until busy=false and inspect lastError. Saves a private snapshot only on completion; authentication/rate limits preserve the last success. No OAuth, publishing or scheduling. Never retry an uncertain start.",
    input: z.strictObject({}), readOnly: false,
  },
  reels_set_instagram_topics: {
    description: "Update topic labels for media in the current owner's latest Instagram snapshot. Partial merge, empty string clears a label. Does not modify posts, production projects or raw metric history.",
    input: z.strictObject({ topics: instagramTopicsInput }), readOnly: false,
  },
  reels_get_planning: {
    description: "Read the private calendar/Linear import snapshot and revision. This does not query providers. No credentials or private planning data enter shared snapshots.",
    input: z.strictObject({}), readOnly: true,
  },
  reels_sync_planning: {
    description: "Import confirmed Google Calendar events or Linear issues after querying connected providers. Use get_planning.updatedAt. Each supplied provider replaces its complete bounded snapshot; omitted provider is preserved. Report source syncedAt and window honestly. Does not create/update external events, issues or social posts.",
    input: planningUpdateSchema, readOnly: false,
  },
  reels_get_cover_preferences: {
    description: "Read this app profile's local cover signature. Defaults to the public placeholder; never shared in dashboard snapshots.",
    input: z.strictObject({}), readOnly: true,
  },
  reels_set_cover_preferences: {
    description: "Save the local cover signature for subsequent rosy-auto/rosy-large previews and renders. Existing images and explicit rosy-follow signatures are unchanged.",
    input: coverPreferencesSchema, readOnly: false,
  },
  reels_create_clip_upload_bundle: {
    description: "Create temporary ASCII upload copies: video, JPEG cover, exact UTF-8 description and receipt, all with paths/bytes/SHA-256. Current outbound wins; otherwise latest recorded export or unique registered output. Ambiguity requires explicit videoPath/coverPath. Use get_content revision. No originals, outbound files, or dashboard state are changed; no upload. Remove the temporary folder after use; OS may also clear it.",
    input: clipUploadInput, readOnly: false,
  },
  reels_convert_gif: {
    description: "Convert a video file into a silent, endlessly looping GIF for blog motion clips. Default: whole length, width 480, 15 fps, bayer dither; start/end select a range (max 60 s). crop {x,y,width,height} keeps part of the displayed (rotated) frame as 0-1 fractions, e.g. drop the top 15% = {x:0, y:0.15, width:1, height:0.85}; width/fps/maxBytes apply to the cropped area and cropping stays on the VideoToolbox route. Removes audio and all metadata (including location), applies display rotation and tone-maps HDR/HLG to SDR. VideoToolbox (GPU) decode/rotate/tone-map/scale with CPU fallback; palette and GIF encoding on CPU. Returns outputPath, bytes, width, height, fps, frames, duration, elapsedMs, accel, crop (with source pixels) and warnings. Over 20 MB warns (Naver limit unverified); maxBytes lowers fps then width automatically. Source is never changed; existing outputs need overwrite. Not registered to any project.",
    input: gifConvertInput, readOnly: false,
  },
  reels_set_project_outbound: {
    description: "Bind one persistent iCloud outbound directory to a project using get_content's revision. Repeated deliveries reuse this directory. Existing linked files can be adopted; unrelated files are not managed. A different directory is rejected once bound.",
    input: configureOutboundInput, readOnly: false,
  },
  reels_icloud_status: {
    description: "Read native iCloud upload states for explicit files inside the configured delivery root. Reuses PhotosIndex verification; no copies, Photos permission request, deletion, or waiting. completed means every file is uploaded, not uploading and error-free. Local download currency is reported separately.",
    input: icloudStatusInput, readOnly: true,
  },
  reels_start_icloud_delivery: {
    description: "Publish registered files into the project's saved outbound folder; never choose a version-specific folder. files is the complete current output set with stable names. Replaces managed files and archives prior versions locally; unrelated collisions are rejected. Read get_content for revision, then poll get_icloud_delivery. No Photos deletion or social publishing.",
    input: icloudDeliveryInput, readOnly: false,
  },
  reels_get_publish_readiness: {
    description: "Check whether a project can be posted to Instagram from the phone now: its saved iCloud outbound folder must hold final video, cover and post text (caption·pinned comment·reply) at the delivered sizes, all uploaded to iCloud. States: published, ready, uploading, upload-failed, changed, incomplete, not-delivered. Read-only; no copies, hashing, waiting or posting.",
    input: publishReadinessInput, readOnly: true,
  },
  reels_get_icloud_delivery: {
    description: "Read a delivery job; after copying, refresh its native iCloud upload state once. Jobs last for this app instance; receipt and output files persist. After reconnect use the same job ID, never blindly repeat start. No blocking upload wait.",
    input: z.strictObject({ jobId: z.string().uuid() }), readOnly: true,
  },
  ...formDefinitions,
  reels_open_input_form: {description:"Open or focus the shared input form/result window in the Dashboard. Requires a form created by the common forms service; does not start a workflow or edit answers.",input:formIdInput,readOnly:false},
  reels_get_analysis_selection: { description: "Read independent candidate, group/representative and actual-use records.", input: selectionQuery, readOnly: true },
  reels_run_analysis_selection: { description: "Collect every successful analysis as a candidate, then group identical sample JPEGs and select stable representatives. Separate from paid analysis. Revision protected.", input: selectionExecute, readOnly: false },
  reels_update_analysis_selection: { description: "Record human usability, representative choice or actual content/edit usage. Nothing is deleted or hidden.", input: selectionUpdate, readOnly: false },
  reels_start_analysis: {
    description:
      "Analyze a linked project folder with the selected image analyzer. Sends sampled images to the provider using existing CLI login. Async: query analysis for progress; never automatically retry uncertain starts. Photos and three video stills per source, no motion/audio claims.",
    input: analysisStart,
    readOnly: false,
  },
  reels_search_analysis: {
    description:
      "Search project image/frame descriptions, tags, OCR and human corrections; includes run progress/errors and source timestamps.",
    input: analysisQuery,
    readOnly: true,
  },
  reels_correct_analysis: {
    description:
      "Preserve a human correction separately from model results, with revision protection.",
    input: analysisCorrection,
    readOnly: false,
  },

  reels_extract_blog_reference: {
    description:
      "Extract a Naver blog post (SmartEditor ONE) into a local reference folder: DOM block order, nested computed styles, partial text formatting, original text, photo groups/geometry and real anchors. Photos are stored as original CDN URLs only (no files). Validates block/character/image/anchor consistency, cross-checks component counts with the mobile page, writes reference-structures/templates/restore-report and a restore viewer, registers the folder in the Blog tab results, then re-renders it and compares each block height with the original. One extraction at a time; takes ~10-60s. Does not publish, comment or log in.",
    input: blogExtractInput,
    readOnly: false,
  },
  reels_list_blog_references: {
    description: "List registered blog reference result folders (authors, block counts, preview availability, read errors such as a moved folder).",
    input: z.strictObject({}),
    readOnly: true,
  },
  reels_link_blog_reference: {
    description: "Register an existing result folder containing reference-structures.json/.md (e.g. after the folder was moved). Idempotent. The Blog tab list refreshes automatically.",
    input: z.strictObject({ directory: absolutePath }),
    readOnly: false,
  },
  reels_unlink_blog_reference: {
    description: "Remove a registered result folder from the Blog tab list by id (from reels_list_blog_references). Files are not deleted.",
    input: z.strictObject({ id: z.string().regex(/^[a-f0-9]{64}$/) }),
    readOnly: false,
  },
  reels_list_blog_comments: {
    description: "List comments recorded for other Naver blog posts (newest first): post, the blogger's reciprocity promise, status draft/posted/reciprocated/no_reply/neighbor, the comment text and offered drafts. Filter by blogId, postUrl, status or text query. Use it to check earlier comments before drafting a new one.",
    input: blogCommentList,
    readOnly: true,
  },
  reels_create_blog_comment: {
    description: "Record a comment for one Naver blog post (status defaults to draft). The URL is normalized to https://m.blog.naver.com/<blogId>/<logNo>; a post that already has a record is rejected with DUPLICATE. Only stores the record; it never posts, likes or follows on Naver.",
    input: blogCommentCreate,
    readOnly: false,
  },
  reels_update_blog_comment: {
    description: "Change a recorded comment (status, posted text, drafts, note, postedAt) with updatedAt revision protection. Stores only; never posts to Naver.",
    input: blogCommentUpdate,
    readOnly: false,
  },
  reels_remove_blog_comment: {
    description: "Delete one recorded comment by id with updatedAt revision protection. Does not touch the comment on Naver.",
    input: blogCommentDelete,
    readOnly: false,
  },
  reels_merge_projects: {
    description: "Merge explicit source dashboard cards into one target production project. Preserves files and edit bindings, creates a full pre-merge backup, and rejects stale revisions. Target title, stage, date and sharing win; differing publication URLs are rejected.",
    input: mergeProjectsSchema,
    readOnly: false,
  },
  reels_link_project_edit: {
    description: "Attach an existing saved video or card-news edit to a production project so future outputs stay on that card. Rejects another owner; merge its card first.",
    input: linkEditSchema,
    readOnly: false,
  },
  reels_scan_orphan_edits: {
    description: "Read-only scan for dashboard cards the video editor created on its own (title still the footage file name, not published) with candidate owner projects: folderMatch (same folder or Naver Clip shoot folder) and documentMention (a linked document names the footage). suggestedTargetId only when exactly one candidate has both. Merging is a separate reels_merge_projects call.",
    input: z.strictObject({}),
    readOnly: true,
  },
  reels_list_project_edits: {
    description: "List saved video/card-news edits and their owning dashboard project IDs.",
    input: z.strictObject({}),
    readOnly: true,
  },
  reels_get_content: {
    description:
      "Read a production content entry, current dashboard revision and availability of linked local resources. Does not create an edit or read media contents.",
    input: z.strictObject({ projectId: z.string().min(1).max(160) }),
    readOnly: true,
  },
  reels_upsert_content: {
    description:
      "Register or update one production entry by stable ID and current dashboard updatedAt. Resources are an explicit full replacement; omitted content fields are not accepted. Links existing media/folders/documents without copies, proxies, rendering or publication. New entries are private; existing sharing is preserved. Read list_projects and get_content before updating.",
    input: z.strictObject({
      content: contentInputSchema,
      expectedUpdatedAt: dashboardRevision,
    }),
    readOnly: false,
  },
  reels_set_publication: {
    description:
      "Record where one content entry is posted: set a single channel (instagram, naver-clip or blog) to planned or published with its link and the day it went live, or `none` to drop the channel. Other fields, resources and channels are untouched, so no full upsert is needed. When every targeted channel is published the entry's stage becomes published; it is never moved back. Register the channels still to come as planned first, otherwise a single live channel completes the entry. This records state only and does not post, upload or verify anything. Confirm the live post before recording published.",
    input: setPublicationSchema,
    readOnly: false,
  },
  reels_list_local_media: {
    description:
      "List one explicitly selected local folder with pagination. Returns media files and subfolders only; no recursion, symlink traversal or content reads. Use returned paths to connect footage and finished materials.",
    input: z.strictObject({
      directory: localPathSchema,
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(100),
    }),
    readOnly: true,
  },
  reels_get_app_state: {
    description:
      "Read live editor selection, unsaved changes, current time, runtime availability and render jobs. Start here; unsaved UI changes must not be overwritten.",
    input: z.strictObject({}),
    readOnly: true,
  },
  reels_list_projects: {
    description:
      "List saved editing projects and production dashboard entries. Editing tools take editorProjects[].id; content tools take dashboard.projects[].id. Content prose remains in the content workspace.",
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
      "Import an explicitly selected local video without changing its source. Optionally reuse settings from a revision-checked project; creates a new project, not an overwrite. The original plays directly; no playback copy is made on import.",
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
    input: z
      .strictObject({
        projectId: id,
        expectedUpdatedAt: revision,
        kind: z.enum(["video", "cover"]),
        time: z
          .number()
          .min(0)
          .optional()
          .describe("Seconds. Required when kind is video."),
      })
      .refine((value) => value.kind !== "video" || value.time !== undefined, {
        path: ["time"],
        message: "time is required when kind is video.",
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
  reels_import_photos_bundle: {
    description:
      "Default way to bring one visit's Photos material to the dashboard: copy every photo and video of a current Photos group (or only the listed assetIds) into app storage and attach them all to one existing content card. Videos become edit projects linked to that card (no separate card per video, no merge needed); photos and Live Photo motion videos become footage resources on the card. Photos originals stay untouched: read and copy only, no deletion, move, album or metadata change. Idempotent: assets imported before are reused, not copied again, so rerunning after a partial failure is safe. A video already linked to another card stays there and is reported as linked-elsewhere with ownerId. Per-asset failures are reported, not retried. A large group or iCloud download can outlast one call; the import keeps running in the app, and repeating the same call later returns the result without copying again. Split very large groups with assetIds.",
    input: z.strictObject({
      projectId: z.string().min(1).max(160).describe("Existing content card ID, e.g. content:example."),
      groupId: nativeID,
      indexRunId: nativeID,
      assetIds: z.array(nativeID).min(1).max(500).optional().describe("Subset of the group; omit to import the whole group."),
    }),
    readOnly: false,
  },
  reels_import_photos_video: {
    description:
      "Import a selected video from the current Photos index into a new edit project. Copies the original into app storage through the checked materialization service; the Photos original stays untouched (no deletion, move, album or metadata change). Use this to put Photos videos on the dashboard.",
    input: z.strictObject({
      groupId: nativeID,
      indexRunId: nativeID,
      assetId: nativeID,
    }),
    readOnly: false,
  },
} as const;
export type ToolName = keyof typeof toolDefinitions;

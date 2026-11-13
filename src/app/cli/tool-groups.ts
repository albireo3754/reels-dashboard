import type { ToolName } from "../../features/agent-tools";

/**
 * Domain groups for `reels tools --group`. A CLI-only filter: the MCP tool
 * definitions stay unchanged, and groups never become command words.
 * The order is the order of `data.groups`.
 */
export const toolGroups = {
  editor: "Editing projects in the app: state, read, open, import and patch.",
  render: "Preview frames, renders and the cover signature they use.",
  content:
    "Production dashboard entries, linked edits and publication records.",
  photos: "Read-only Photos search, index and inspect; import copies a video.",
  delivery:
    "iCloud outbound delivery, publish readiness and clip upload bundles.",
  forms: "Shared input forms: create, read, save, apply and open.",
  analysis: "Image and frame analysis of a project folder.",
  blog: "Naver blog references, comment records and GIF motion clips.",
  planning: "Calendar and Linear planning snapshots.",
} as const;
export type ToolGroup = keyof typeof toolGroups;
export const toolGroupIds = Object.keys(toolGroups) as ToolGroup[];

/** Exactly one group per tool; a tool added to toolDefinitions fails the type check until listed here. */
export const toolGroupOf = {
  reels_get_app_state: "editor",
  reels_list_projects: "editor",
  reels_get_project: "editor",
  reels_open_project: "editor",
  reels_import_video: "editor",
  reels_update_project: "editor",
  reels_list_templates: "editor",
  reels_list_local_media: "editor",

  reels_preview_frame: "render",
  reels_start_render: "render",
  reels_get_render_job: "render",
  reels_cancel_render: "render",
  reels_get_cover_preferences: "render",
  reels_set_cover_preferences: "render",

  reels_get_content: "content",
  reels_upsert_content: "content",
  reels_set_publication: "content",
  reels_merge_projects: "content",
  reels_link_project_edit: "content",
  reels_scan_orphan_edits: "content",
  reels_list_project_edits: "content",

  reels_photos_status: "photos",
  reels_photos_search: "photos",
  reels_photos_search_page: "photos",
  reels_photos_index: "photos",
  reels_photos_groups: "photos",
  reels_photos_group: "photos",
  reels_photos_inspect: "photos",
  reels_import_photos_video: "photos",

  reels_set_project_outbound: "delivery",
  reels_icloud_status: "delivery",
  reels_start_icloud_delivery: "delivery",
  reels_get_icloud_delivery: "delivery",
  reels_get_publish_readiness: "delivery",
  reels_create_clip_upload_bundle: "delivery",

  reels_forms_list: "forms",
  reels_form_create: "forms",
  reels_form_get: "forms",
  reels_form_wait: "forms",
  reels_form_save: "forms",
  reels_form_results: "forms",
  reels_form_artifact: "forms",
  reels_form_media: "forms",
  reels_form_apply: "forms",
  reels_form_open: "forms",
  reels_form_sync: "forms",
  reels_open_input_form: "forms",

  reels_start_analysis: "analysis",
  reels_search_analysis: "analysis",
  reels_correct_analysis: "analysis",

  reels_extract_blog_reference: "blog",
  reels_list_blog_references: "blog",
  reels_link_blog_reference: "blog",
  reels_unlink_blog_reference: "blog",
  reels_list_blog_comments: "blog",
  reels_create_blog_comment: "blog",
  reels_update_blog_comment: "blog",
  reels_remove_blog_comment: "blog",
  reels_convert_gif: "blog",

  reels_get_planning: "planning",
  reels_sync_planning: "planning",
} as const satisfies Record<ToolName, ToolGroup>;

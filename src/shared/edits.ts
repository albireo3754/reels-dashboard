import { z } from "zod";
import { absolutePathSchema } from "./path-schema";
export const editsScreenLockState = z.union([
  z.boolean(),
  z.literal("unknown"),
]);
export type EditsScreenLockState = z.infer<typeof editsScreenLockState>;

export const editsTarget = z.strictObject({
  pid: z.number().int().positive(),
  root: z.enum(["application", "menuBar"]),
  path: z.array(z.number().int().nonnegative()).max(32),
  fingerprint: z.string().min(1).max(500),
});
export const editsSelector = z
  .strictObject({
    role: z.string().max(200).optional(),
    identifier: z.string().max(500).optional(),
    label: z.string().max(4096).optional(),
  })
  .refine((v) => Object.values(v).some(Boolean), "Specify a selector");
const dryRun = z.boolean().default(false);
export const editsPressIntent = z.enum([
  "editor-control",
  "timeline-select",
  "library-result",
  "import-confirm",
  "duration-confirm",
]);
export const editsValueIntent = z.enum([
  "timecode",
  "audio-search",
  "clip-volume",
  "text-content",
  "import-path",
  "duration",
]);
const uuid = z.string().uuid();
const seconds = z.number().finite().nonnegative().max(86400);
const text = z
  .string()
  .min(1)
  .max(10000)
  .refine((v) => !v.includes("\0"));
const tree = {
  depth: z.number().int().min(1).max(16).default(12),
  maxNodes: z.number().int().min(1).max(4000).default(3000),
};
const tool = <T extends z.ZodType>(
  description: string,
  input: T,
  readOnly = false,
) => ({ description, input, readOnly });

/** Shared input schemas: both socket dispatch and CLI/MCP validate these. */
export const editsTools = {
  reels_edits_status: tool(
    "Read the exact Edits app, Dashboard-spawned helper trust and screenLocked: boolean or unknown without prompts. Only explicit false means unlocked; unknown is not a lock assertion. Does not launch Edits. Ordinary packaged-app TCC remains a separate verification.",
    z.strictObject({}),
    true,
  ),
  reels_edits_ax_tree: tool(
    "Read a bounded Edits accessibility tree. Concrete targets contain pid/path/fingerprint and become stale when UI identity changes. Secure/login values are excluded.",
    z.strictObject(tree),
    true,
  ),
  reels_edits_ax_find: tool(
    "Find Edits AX nodes by exact role/identifier/label, returning all matches; never silently choose an ambiguous control.",
    z.strictObject({ selector: editsSelector, ...tree }),
    true,
  ),
  reels_edits_ax_press: tool(
    "Press a concrete observed Edits AX target in an explicitly allowed intent/context. Unknown targets fail closed. Uncertain AX outcomes never trigger coordinate replay. Inspect verification and after state.",
    z.strictObject({
      target: editsTarget,
      intent: editsPressIntent,
      action: z.enum(["AXPress", "Edit timecode"]).optional(),
      allowCoordinateFallback: z.boolean().default(false),
      dryRun,
    }),
  ),
  reels_edits_ax_set_value: tool(
    "Set an observed, settable Edits AX value in a permitted field/context and read it back. Unknown/secure fields fail closed. dryRun never writes.",
    z.strictObject({
      target: editsTarget,
      intent: editsValueIntent,
      value: z.union([z.string().max(10000), z.number().finite(), z.boolean()]),
      dryRun,
    }),
  ),
  reels_edits_menu: tool(
    "Run an allowed Edits menu path: File>Import Media, File>Close or Clip>Duration. No arbitrary menu automation or publishing.",
    z.strictObject({
      path: z.enum(["File>Import Media", "File>Close", "Clip>Duration"]),
      dryRun,
    }),
  ),
  reels_edits_screenshot: tool(
    "Capture only an Edits window as a PNG data URL. Screen recording permission is checked separately without prompting.",
    z.strictObject({}),
    true,
  ),
  reels_edits_open_project: tool(
    "Open an explicitly named/id Edits project through observed AX controls and verify the editor. Does not launch a missing app or use guessed deep links.",
    z
      .strictObject({
        projectId: uuid.optional(),
        name: text.optional(),
        dryRun,
      })
      .refine((v) => !!(v.projectId || v.name), "Specify projectId or name"),
  ),
  reels_edits_import_media: tool(
    "Import explicit local files into the currently linked Edits project. Verify chooser closure, a new persisted project Media alias and exact available source identity. Does not claim panel visibility. Originals stay untouched; no Photos access. An existing basename requires explicit source inspection.",
    z.strictObject({
      paths: z.array(absolutePathSchema()).min(1).max(30),
      dryRun,
    }),
  ),
  reels_edits_clip_list: tool(
    "Read the current Edits timeline AX clip IDs and optional read-only project metadata. Timeline.db is an observed internal format, never modified.",
    z.strictObject({ projectId: uuid.optional() }),
    true,
  ),
  reels_edits_clip_trim: tool(
    "Trim inward within an observed video clip using Edits timecode/Trim controls. Verify actual source in/out and timeline state from read-only metadata. Expansion is not silently approximated.",
    z
      .strictObject({
        clipId: uuid,
        inSeconds: seconds,
        outSeconds: seconds,
        dryRun,
      })
      .refine(
        (v) => v.outSeconds > v.inSeconds,
        "outSeconds must follow inSeconds",
      ),
  ),
  reels_edits_clip_mute: tool(
    "Mute/unmute a video through Clip volume (-infinity/0dB), preserving the Sound adjustments toggle. Verify actual volume after selection.",
    z.strictObject({ clipId: uuid, muted: z.boolean().default(true), dryRun }),
  ),
  reels_edits_text_add: tool(
    "Add text through Edits Text>Styles>None. Verify a new text object ID and its persisted exact body, not just an inspector field. Optional duration is verified on that object.",
    z.strictObject({
      text,
      durationSeconds: seconds.positive().optional(),
      dryRun,
    }),
  ),
  reels_edits_text_set: tool(
    "Verify the target is text before selection, then verify that exact object's persisted body and any requested duration. Does not rewrite other overlays.",
    z.strictObject({
      clipId: uuid,
      text,
      durationSeconds: seconds.positive().optional(),
      dryRun,
    }),
  ),
  reels_edits_audio_search: tool(
    "Search Edits' own audio library. Return observed completion, explicit empty results or completion=unconfirmed when a fresh response cannot be established. Identical result lists are valid after observed completion. Match title, artist and version; no substitute/download.",
    z.strictObject({ query: text, dryRun }),
  ),
  reels_edits_audio_add: tool(
    "Add an exact resultLabel returned by Edits audio search at timeline zero. Return the new music object and read-only library metadata. Preserve original video audio; no imported reference mix.",
    z.strictObject({ resultLabel: text, dryRun }),
  ),
  reels_edits_audio_volume: tool(
    "Require a music/audio object before selection or writes, set its Clip volume, and verify its UI dB and persisted gain. Refuse video/text IDs and keep original video audio independent.",
    z.strictObject({
      trackId: uuid,
      decibels: z.number().finite().min(-70).max(12),
      dryRun,
    }),
  ),
  reels_edits_audio_segment: tool(
    "Adjust a music source in-point through Edits Slip, Trim, Roll; coordinate fallback is explicitly marked and exact source in/start/duration must be re-read before verified=true. Runtime support is reported honestly.",
    z.strictObject({ trackId: uuid, inSeconds: seconds, dryRun }),
  ),
  reels_edits_export: tool(
    "Start Edits' local Export, observe success and a new stable app output, then copy it to a NEW requested outputPath. Never overwrite, synthesize or Share to Instagram. A timeout means outcome unknown; inspect before retrying.",
    z.strictObject({ outputPath: absolutePathSchema(), dryRun }),
  ),
} as const;
export type EditsToolName = keyof typeof editsTools;
export type AXTarget = z.infer<typeof editsTarget>;
export type AXSelector = z.infer<typeof editsSelector>;
export type AXNode = {
  target: AXTarget;
  role: string;
  title: string;
  description: string;
  identifier: string;
  help: string;
  placeholder?: string;
  value: string | number | boolean | null;
  enabled: boolean;
  selected: boolean;
  focused: boolean;
  settable: boolean;
  actions: { name: string; description: string }[];
  frame: { x: number; y: number; width: number; height: number } | null;
};
export const treeTruncationReason = z.enum([
  "depth-limit",
  "node-limit",
  "byte-limit",
  "children-limit",
  "duplicate",
  "cycle",
  "attributes-read-error",
  "value-read-error",
  "children-read-error",
]);
export const elementIdentityProbeSchema = z.object({
  firstCapturedRole: z.string().max(200).optional(),
  currentRole: z.string().max(200).optional(),
  firstRoleNow: z.string().max(200).optional(),
  currentPid: z.number().int().optional(),
  firstPid: z.number().int().optional(),
  sameReference: z.boolean().optional(),
  currentEqualsFirst: z.boolean().optional(),
  freshApplicationRole: z.string().max(200).optional(),
  freshChildPresent: z.boolean().optional(),
  freshFirstChildRole: z.string().max(200).optional(),
  freshChildEqualsApplication: z.boolean().optional(),
  freshChildEqualsCurrent: z.boolean().optional(),
  probeErrorCode: z.string().max(200).optional(),
  probeAXErrorCode: z.number().int().optional(),
  probeAXAPI: z.string().max(200).optional(),
  probeAXAttribute: z.string().max(200).optional(),
});
export const treeDiagnosticsSchema = z.object({
  counts: z.partialRecord(treeTruncationReason, z.number().int().nonnegative()),
  samples: z
    .array(
      z.object({
        reason: treeTruncationReason,
        root: z.enum(["application", "menuBar"]),
        path: z.array(z.number().int().nonnegative()),
        firstPath: z.array(z.number().int().nonnegative()).optional(),
        errorCode: z.string().max(200).optional(),
        axErrorCode: z.number().int().optional(),
        axAPI: z.string().max(200).optional(),
        axAttribute: z.string().max(200).optional(),
        axRole: z.string().max(200).optional(),
        axAttributeListed: z.boolean().optional(),
        axAttributeListErrorCode: z.number().int().optional(),
        identity: elementIdentityProbeSchema.optional(),
      }),
    )
    .max(16),
  samplesOmitted: z.number().int().nonnegative(),
  confirmedAbsentSubroles: z.number().int().nonnegative(),
  confirmedAbsentSubroleSamples: z
    .array(
      z.object({
        root: z.enum(["application", "menuBar"]),
        path: z.array(z.number().int().nonnegative()),
        role: z.string().max(200),
      }),
    )
    .max(16),
});
export type TreeDiagnostics = z.infer<typeof treeDiagnosticsSchema>;
export const editsHostRejectionReason = z.enum([
  "parent-unavailable-or-changed",
  "parent-metadata-unavailable",
  "parent-executable-mismatch",
  "parent-arguments-unavailable",
  "packaged-layout-mismatch",
  "unsupported-parent-launch",
  "development-project-unverified",
  "development-electron-mismatch",
  "development-entry-mismatch",
  "unsupported-parent-bundle",
  "parent-working-directory-unavailable",
]);
export type EditsHostRejectionReason = z.infer<typeof editsHostRejectionReason>;
export const editsErrorDetailsSchema = z.object({
  reason: editsHostRejectionReason.optional(),
  attempted: z.boolean().optional(),
  fallback: z.enum(["coordinate"]).nullable().optional(),
  diagnostics: treeDiagnosticsSchema.optional(),
  before: z.object({ diagnostics: treeDiagnosticsSchema }).optional(),
  after: z.object({ diagnostics: treeDiagnosticsSchema }).optional(),
  axErrorCode: z.number().int().optional(),
  axAPI: z.string().max(200).optional(),
  axAttribute: z.string().max(200).optional(),
  axRole: z.string().max(200).optional(),
  axAttributeListed: z.boolean().optional(),
  axAttributeListErrorCode: z.number().int().optional(),
  outcome: z.enum(["unknown"]).optional(),
});
export function editsErrorDetails(value: unknown) {
  const result = editsErrorDetailsSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
export type AXSnapshot = {
  pid: number;
  nodes: AXNode[];
  truncated: boolean;
  diagnostics: TreeDiagnostics;
};
export type EditsNativeOperation =
  | "status"
  | "tree"
  | "find"
  | "press"
  | "set-value"
  | "menu"
  | "key"
  | "drag"
  | "screenshot";
export interface EditsNativePort {
  invoke(
    operation: EditsNativeOperation,
    args: Record<string, unknown>,
  ): Promise<any>;
}
export interface EditsBridge {
  request(name: EditsToolName, input: unknown): Promise<unknown>;
}
export const axLabel = (node: AXNode) => node.title || node.description || "";
export function matchesAX(node: AXNode, selector: AXSelector) {
  return (
    (!selector.role || node.role === selector.role) &&
    (!selector.identifier || node.identifier === selector.identifier) &&
    (!selector.label ||
      [node.title, node.description, node.placeholder, node.value].includes(
        selector.label,
      ))
  );
}

import { z } from "zod";
import { Cron } from "croner";

/**
 * Built-in schedules kept in `<userData>/scheduler/schedules.json`.
 * v1 has one trigger kind (cron) and one action kind (aside); both are
 * discriminated unions so another kind can be added without a file migration.
 */
export const scheduleIdSchema = z.string().regex(/^[a-z0-9-]{3,40}$/, "id: 3-40 of a-z, 0-9 and -");
/** A skill folder name: no slashes, dots or path pieces. */
export const skillNameSchema = z.string().regex(/^[a-z0-9-]{3,40}$/, "skill: 3-40 of a-z, 0-9 and -");

export const DEFAULT_TIMEZONE = "Asia/Seoul";
export const DEFAULT_CRON = "10 18 * * *";
export const DEFAULT_CATCH_UP_MINUTES = 300;
export const DEFAULT_TIMEOUT_MINUTES = 45;

function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
/** Five space-separated fields that croner accepts (no seconds field). */
function validCron(value: string) {
  if (value.trim().split(/\s+/).length !== 5) return false;
  try {
    new Cron(value, { paused: true });
    return true;
  } catch {
    return false;
  }
}

export const cronTriggerSchema = z.strictObject({
  type: z.literal("cron"),
  expr: z.string().max(100).refine(validCron, "expr: five-field cron expression, e.g. '10 18 * * *'"),
  timezone: z.string().max(64).refine(validTimezone, "timezone: IANA name, e.g. Asia/Seoul").default(DEFAULT_TIMEZONE),
});
export const triggerSchema = z.discriminatedUnion("type", [cronTriggerSchema]);
export type ScheduleTrigger = z.infer<typeof triggerSchema>;

export const misfireSchema = z.strictObject({
  catchUpWithinMinutes: z.number().int().min(0).max(720).default(DEFAULT_CATCH_UP_MINUTES)
    .describe("Run the latest missed time if the app is up within this many minutes after it; older times are recorded as missed."),
});
export const limitsSchema = z.strictObject({
  timeoutMinutes: z.number().int().min(1).max(120).default(DEFAULT_TIMEOUT_MINUTES),
  maxRunsPerDay: z.number().int().min(1).max(24).default(1)
    .describe("Started runs per calendar day in the schedule's timezone, manual runs included."),
});

const paramKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/);
const paramValue = z.union([z.string().max(200), z.number().finite(), z.boolean()]);
export const paramsSchema = z
  .record(paramKey, paramValue)
  .refine((value) => Object.keys(value).length <= 20, "params: at most 20 keys");
const hostProfileSchema = z.string().min(1).max(100).regex(/^[\p{L}\p{N}._-]+$/u, "hostProfile: an id or name from 'aside host profiles'");
const modelSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9._:/-]+$/, "model: provider/model id");

/** The aside executable is never configured here: it is resolved at runtime (REELS_ASIDE_BIN for tests only). */
export const asideActionSchema = z.strictObject({
  kind: z.literal("aside"),
  skill: skillNameSchema,
  hostProfile: hostProfileSchema.optional(),
  model: modelSchema.optional(),
  params: paramsSchema.default({}),
});
export const actionSchema = z.discriminatedUnion("kind", [asideActionSchema]);
export type ScheduleAction = z.infer<typeof actionSchema>;

const iso = z.string().datetime();
export const scheduleSchema = z.strictObject({
  id: scheduleIdSchema,
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  pausedReason: z.string().max(200).optional(),
  trigger: triggerSchema,
  misfire: misfireSchema.default({ catchUpWithinMinutes: DEFAULT_CATCH_UP_MINUTES }),
  limits: limitsSchema.default({ timeoutMinutes: DEFAULT_TIMEOUT_MINUTES, maxRunsPerDay: 1 }),
  action: actionSchema,
  createdAt: iso,
  updatedAt: iso,
});
export type Schedule = z.infer<typeof scheduleSchema>;

export const scheduleFileSchema = z.strictObject({
  version: z.literal(1),
  schedules: z.array(scheduleSchema).max(20),
});
export type ScheduleFile = z.infer<typeof scheduleFileSchema>;

export const runStatusSchema = z.enum([
  "pending",
  "running",
  "ok",
  "partial",
  "failed",
  "blocked",
  "missed",
  "skipped",
  "interrupted",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;
export const runTriggerSchema = z.enum(["cron", "catchup", "manual"]);
export type RunTrigger = z.infer<typeof runTriggerSchema>;
/** Statuses that count as a started run for the daily limit. */
export const startedStatuses = ["running", "ok", "partial", "failed", "interrupted"] as const satisfies readonly RunStatus[];

// ---- Tool inputs (MCP and `reels` CLI). Every object is strict, so an executable path or unknown key is rejected.

export const getSchedulesInput = z.strictObject({ id: scheduleIdSchema.optional() });
export const setScheduleInput = z.strictObject({
  id: scheduleIdSchema.describe("Stable id; a new id creates the schedule."),
  name: z.string().trim().min(1).max(80).optional(),
  enabled: z.boolean().optional().describe("false pauses, true resumes (and clears pausedReason)."),
  trigger: z
    .strictObject({
      type: z.literal("cron").default("cron"),
      expr: cronTriggerSchema.shape.expr,
      timezone: cronTriggerSchema.shape.timezone,
    })
    .optional()
    .describe(`Default for a new schedule: {"expr":"${DEFAULT_CRON}","timezone":"${DEFAULT_TIMEZONE}"}. A changed trigger restarts its catch-up cursor at now.`),
  misfire: z.strictObject({ catchUpWithinMinutes: misfireSchema.shape.catchUpWithinMinutes.removeDefault() }).optional(),
  limits: z
    .strictObject({
      timeoutMinutes: limitsSchema.shape.timeoutMinutes.removeDefault().optional(),
      maxRunsPerDay: limitsSchema.shape.maxRunsPerDay.removeDefault().optional(),
    })
    .optional(),
  action: z
    .strictObject({
      skill: skillNameSchema.optional().describe("Aside user skill folder name; required for a new schedule."),
      hostProfile: hostProfileSchema.nullable().optional().describe("null clears it."),
      model: modelSchema.nullable().optional().describe("null clears it."),
      params: paramsSchema.optional().describe("Replaces all params: string (≤200 chars), number or boolean values, ≤20 keys."),
    })
    .optional(),
});
export type SetScheduleInput = z.infer<typeof setScheduleInput>;
export const runScheduleNowInput = z.strictObject({ id: scheduleIdSchema });
export const getScheduleRunsInput = z.strictObject({
  id: scheduleIdSchema.optional(),
  status: runStatusSchema.optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type GetScheduleRunsInput = z.infer<typeof getScheduleRunsInput>;

/** Apply a set-schedule input to the current definition (or the defaults for a new id). */
export function mergeSchedule(current: Schedule | undefined, input: SetScheduleInput, now: Date): Schedule {
  const stamp = now.toISOString();
  if (!current && !input.action?.skill) throw new Error("SCHEDULE_INCOMPLETE: a new schedule needs action.skill.");
  const base: Schedule = current ?? {
    id: input.id,
    name: input.id,
    enabled: true,
    trigger: { type: "cron", expr: DEFAULT_CRON, timezone: DEFAULT_TIMEZONE },
    misfire: { catchUpWithinMinutes: DEFAULT_CATCH_UP_MINUTES },
    limits: { timeoutMinutes: DEFAULT_TIMEOUT_MINUTES, maxRunsPerDay: 1 },
    action: { kind: "aside", skill: input.action!.skill!, params: {} },
    createdAt: stamp,
    updatedAt: stamp,
  };
  const action = { ...base.action };
  if (input.action?.skill) action.skill = input.action.skill;
  if (input.action?.params) action.params = input.action.params;
  for (const key of ["hostProfile", "model"] as const) {
    const value = input.action?.[key];
    if (value === null) delete action[key];
    else if (value !== undefined) action[key] = value;
  }
  const enabled = input.enabled ?? base.enabled;
  const next = {
    ...base,
    ...(input.name ? { name: input.name } : {}),
    enabled,
    trigger: input.trigger ? { type: "cron" as const, expr: input.trigger.expr, timezone: input.trigger.timezone } : base.trigger,
    misfire: input.misfire ? { ...base.misfire, ...input.misfire } : base.misfire,
    limits: { ...base.limits, ...input.limits },
    action,
    updatedAt: stamp,
  };
  // Re-enabling is the user's acknowledgement of whatever paused the schedule.
  if (input.enabled === true) delete (next as Partial<Schedule>).pausedReason;
  return scheduleSchema.parse(next);
}

// ---- Result an aside run must end with (the last ```json block of its output).

export const blockedCodes = ["login", "captcha", "restricted", "account-mismatch", "app-offline", "errors", "other"] as const;
/** Account-level stops: the schedule pauses itself until the user turns it on again. */
export const pausingBlockedCodes = ["login", "captcha", "restricted", "account-mismatch"] as const;
const count = z.number().int().min(0);
/** Only the keys the verdict needs are checked; unknown keys are ignored (LLM output may add some). */
export const asideResultSchema = z.object({
  runId: z.string().min(1).max(100),
  accountVerified: z.boolean(),
  accepted: count,
  visited: count,
  commented: count,
  liked: count,
  records: z.array(
    z.object({
      postUrl: z.string().min(1).max(2048),
      action: z.string().max(20).optional(),
      status: z.string().max(20).optional(),
    }),
  ).max(100),
  blocked: z.union([
    z.null(),
    z.object({ code: z.enum(blockedCodes), detail: z.string().max(200).optional() }),
  ]),
  acceptedOnly: z.array(z.string().max(64)).max(100).optional(),
  skipped: z.array(z.unknown()).max(100).optional(),
  notes: z.string().max(2000).optional(),
});
export type AsideResult = z.infer<typeof asideResultSchema>;

import { z } from "zod";
import type { Project } from "./contracts";
import { seoulDate } from "./planning";

export const instagramConnectionInput = z.strictObject({
  username: z
    .string()
    .trim()
    .transform((v) => v.replace(/^@/, "").toLowerCase())
    .pipe(z.string().regex(/^[a-z0-9._]{1,30}$/)),
  login: z.enum(["unified", "instagram"]),
});
export const instagramTopicsInput = z
  .record(z.string().regex(/^\d+$/), z.string().trim().max(60))
  .refine((v) => Object.keys(v).length <= 100);
export const instagramMetricSchema = z.object({
  metric: z.string().min(1).max(80),
  observedAt: z.string().datetime(),
  status: z.enum([
    "available",
    "unavailable",
    "permission_denied",
    "api_error",
  ]),
  value: z.number().finite().nonnegative().nullable(),
  period: z.string().nullable().optional(),
  errorCode: z
    .union([z.number(), z.string().max(80)])
    .nullable()
    .optional(),
  errorSubcode: z.number().nullable().optional(),
});
export const instagramSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  collectedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  apiVersion: z.string(),
  login: z.enum(["unified", "instagram"]),
  ownedMediaCount: z.number().int().nonnegative(),
  account: z.strictObject({
    userId: z.string().regex(/^\d+$/),
    username: z.string(),
    followersCount: z.number().nullable(),
    mediaCount: z.number().nullable(),
  }),
  media: z
    .array(
      z.strictObject({
        id: z.string().regex(/^\d+$/),
        permalink: z
          .string()
          .url()
          .refine((v) => instagramCode(v) !== null),
        mediaType: z.string(),
        mediaProductType: z.string(),
        publishedAt: z.string().datetime({ offset: true }),
        captionHead: z.string(),
        metrics: z.array(instagramMetricSchema),
      }),
    )
    .max(100),
});
export type InstagramSnapshot = z.infer<typeof instagramSnapshotSchema>;
export type InstagramPost = InstagramSnapshot["media"][number];
export type InstagramConnectionInput = z.infer<typeof instagramConnectionInput>;
export interface InstagramInsightsState {
  connection: {
    username: string;
    login: "unified" | "instagram";
    tokenReady: boolean;
  } | null;
  snapshot: InstagramSnapshot | null;
  history: { id: string; collectedAt: string; count: number }[];
  topics: Record<string, string>;
  busy: boolean;
  lastError?: string | null;
}
export interface InstagramInsightsBridge {
  get(input?: { snapshotId?: string }): Promise<InstagramInsightsState>;
  connect(
    input: InstagramConnectionInput,
  ): Promise<InstagramInsightsState | null>;
  refresh(): Promise<InstagramInsightsState>;
  setTopics(input: Record<string, string>): Promise<InstagramInsightsState>;
  onChanged?(callback: () => void): () => void;
}
export const emptyInstagramState = (): InstagramInsightsState => ({
  connection: null,
  snapshot: null,
  history: [],
  topics: {},
  busy: false,
});
export function instagramCode(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !["instagram.com", "www.instagram.com"].includes(url.hostname)
    )
      return null;
    return /\/(?:reel|p)\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}
export function instagramProject(post: InstagramPost, projects: Project[]) {
  const code = instagramCode(post.permalink);
  return projects.find((p) =>
    [
      p.publicURL,
      ...(p.publications
        ?.filter((v) => v.channel === "instagram" && v.status === "published")
        .map((v) => v.url) ?? []),
    ].some((url) => code && instagramCode(url) === code),
  );
}
export function insightValue(
  post: InstagramPost,
  metric: string,
): number | null {
  const item = post.metrics.find((m) => m.metric === metric);
  return item?.status === "available" ? item.value : null;
}
export function insightRates(post: InstagramPost) {
  const reach = insightValue(post, "reach");
  const values = ["likes", "comments", "saved", "shares"].map((k) =>
    insightValue(post, k),
  );
  const rate = (value: number | null) =>
    value !== null && reach !== null && reach > 0
      ? (value / reach) * 100
      : null;
  return {
    interaction: rate(
      values.every((v) => v !== null)
        ? (values as number[]).reduce((a, b) => a + b, 0)
        : null,
    ),
    saved: rate(insightValue(post, "saved")),
    shares: rate(insightValue(post, "shares")),
  };
}
export interface InsightsFilter {
  matureOnly: boolean;
  excludeFrom: string;
  excludeTo: string;
}
export function insightsCohort(
  snapshot: InstagramSnapshot,
  filter: InsightsFilter,
) {
  const at = Date.parse(snapshot.collectedAt);
  return snapshot.media.filter((p) => {
    const day = seoulDate(p.publishedAt);
    return (
      p.mediaProductType === "REELS" &&
      (!filter.matureOnly || at - Date.parse(p.publishedAt) >= 48 * 3600000) &&
      !(
        filter.excludeFrom &&
        filter.excludeTo &&
        day >= filter.excludeFrom &&
        day <= filter.excludeTo
      )
    );
  });
}
export const insightMedian = (values: (number | null)[]): number | null => {
  const numbers = values
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  return numbers.length
    ? (numbers[Math.floor((numbers.length - 1) / 2)]! +
        numbers[Math.ceil((numbers.length - 1) / 2)]!) /
        2
    : null;
};
export function insightsGroups(
  posts: InstagramPost[],
  dimension: "weekday" | "hour" | "topic",
  topics: Record<string, string>,
  metric: "interaction" | "saved" | "shares" = "interaction",
) {
  const labels =
    dimension === "weekday"
      ? ["월", "화", "수", "목", "금", "토", "일"]
      : dimension === "hour"
        ? ["00–05시", "06–11시", "12–17시", "18–23시"]
        : [...new Set(posts.map((p) => topics[p.id] || "미분류"))].sort();
  return labels.map((label) => {
    const members = posts.filter((p) => {
      const kst = new Date(Date.parse(p.publishedAt) + 9 * 3600000);
      const key =
        dimension === "weekday"
          ? labels[(kst.getUTCDay() + 6) % 7]
          : dimension === "hour"
            ? labels[Math.floor(kst.getUTCHours() / 6)]
            : topics[p.id] || "미분류";
      return key === label;
    });
    const rates = members.map((p) => insightRates(p)[metric]);
    return {
      label,
      count: members.length,
      valid: rates.filter((v) => v !== null).length,
      median: insightMedian(rates),
    };
  });
}

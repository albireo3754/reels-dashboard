import { z } from "zod";

/**
 * Where a project is posted. One project (one visit/shoot) can go out on several
 * channels, and each channel finishes on its own schedule, so "published" is
 * tracked per channel instead of once per project.
 */
export const publicationChannels = ["instagram", "naver-clip", "blog"] as const;
export type PublicationChannel = (typeof publicationChannels)[number];
export const publicationChannelLabels: Record<PublicationChannel, string> = {
  instagram: "인스타그램",
  "naver-clip": "네이버클립",
  blog: "블로그",
};
export const publicationStatuses = ["planned", "published"] as const;
export type PublicationStatus = (typeof publicationStatuses)[number];
export const publicationStatusLabels: Record<PublicationStatus, string> = {
  planned: "예정",
  published: "게시 완료",
};

const httpURL = z
  .string()
  .max(2048)
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return (
        ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, "게시 링크는 HTTP 또는 HTTPS 주소를 입력해주세요.");

export const publicationSchema = z.strictObject({
  channel: z.enum(publicationChannels),
  status: z.enum(publicationStatuses),
  /** Empty while planned, or when the post exists but its link is not recorded. */
  url: httpURL,
  /** The day the post went live on this channel; never the day it was recorded. */
  publishedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type Publication = z.infer<typeof publicationSchema>;

export const publicationsSchema = z
  .array(publicationSchema)
  .max(publicationChannels.length)
  .refine(
    (list) => new Set(list.map((p) => p.channel)).size === list.length,
    "같은 채널을 두 번 넣을 수 없어요.",
  )
  .refine(
    (list) => list.every((p) => p.status === "published" || !p.publishedAt),
    "게시일은 게시 완료 채널에만 넣을 수 있어요.",
  );

type WithPublications = { publications?: Publication[] };

const order = (list: Publication[]) =>
  [...list].sort(
    (a, b) =>
      publicationChannels.indexOf(a.channel) -
      publicationChannels.indexOf(b.channel),
  );

/** Replaces the entry for one channel and keeps the fixed channel order. */
export function withPublication(
  list: Publication[] | undefined,
  entry: Publication,
): Publication[] {
  return publicationsSchema.parse(
    order([...(list ?? []).filter((p) => p.channel !== entry.channel), entry]),
  );
}
export function withoutPublication(
  list: Publication[] | undefined,
  channel: PublicationChannel,
): Publication[] {
  return (list ?? []).filter((p) => p.channel !== channel);
}
export const publicationOn = (
  project: WithPublications,
  channel: PublicationChannel,
) => project.publications?.find((p) => p.channel === channel);
export const isPublishedOn = (
  project: WithPublications,
  channel: PublicationChannel,
) => publicationOn(project, channel)?.status === "published";
/** True only when the project targets at least one channel and every one is live. */
export const allChannelsPublished = (project: WithPublications) =>
  Boolean(project.publications?.length) &&
  project.publications!.every((p) => p.status === "published");

import { z } from "zod";
import type { Project } from "./contracts";
import { publicationChannelLabels, publicationChannels, type PublicationChannel } from "./publications";
import { dashboardRevision } from "./production-project";

/**
 * A draft of the next thing to make: a hook that already worked, crossed with footage we have.
 * Pitches sit on the project that owns the footage (a new idea gets its own `idea` card), so
 * choosing one never invents a second copy of the material. They carry the reasoning a person
 * needs to pick: which proven hook, which source, how ready, what only the user can answer.
 *
 * Owner-private but path-free: nothing here may hold a local path, credential or metric
 * snapshot, because the board is mirrored to the owner's mobile briefing.
 */
export const pitchReadiness = ["ready", "needs_edit", "needs_user", "hold"] as const;
export type PitchReadiness = (typeof pitchReadiness)[number];
export const pitchReadinessLabels: Record<PitchReadiness, string> = {
  ready: "바로 올릴 수 있음",
  needs_edit: "편집하면 됨",
  needs_user: "내 답 필요",
  hold: "보류",
};

/** `picked`: the user chose it for production. `dropped`: kept for the record, off the board. */
export const pitchDecisions = ["proposed", "picked", "dropped"] as const;
export type PitchDecision = (typeof pitchDecisions)[number];
export const pitchDecisionLabels: Record<PitchDecision, string> = {
  proposed: "제안",
  picked: "선정",
  dropped: "제외",
};

export const pitchEfforts = ["S", "M", "L"] as const;
export type PitchEffort = (typeof pitchEfforts)[number];
export const pitchEffortLabels: Record<PitchEffort, string> = { S: "작업 적음", M: "작업 보통", L: "작업 많음" };

const line = (max: number) => z.string().trim().min(1).max(max);

export const topicPitchSchema = z.strictObject({
  /** Stable within the project, e.g. `d2`. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  channel: z.enum(publicationChannels),
  /** What this reel is, in a few words: `일본 면세 11월 변경`. */
  title: line(120),
  /** The proven hook family it borrows: `정보형 · 지금 알릴 이유`. */
  hookFamily: line(60),
  /** Cover hook candidates, two lines split by ` / `. The first is the recommendation. */
  coverHooks: z.array(line(80)).min(1).max(4),
  captionHead: z.string().trim().max(200).optional(),
  /** Earlier posts whose hook this borrows, with the observation that made it worth borrowing. */
  basedOn: z.array(z.strictObject({ title: line(120), evidence: line(200) })).max(4).default([]),
  /** The footage and its state: `면세 촬영분 12개 · 공식 안내 대조 완료 · 미편집`. */
  source: line(300),
  hypothesis: z.string().trim().max(400).optional(),
  effort: z.enum(pitchEfforts),
  readiness: z.enum(pitchReadiness),
  /** Questions only the user can answer (taste, own experience, consent). Facts are researched, not asked. */
  asks: z.array(line(200)).max(6).default([]),
  /** Recommended order among proposals, 1 first. */
  rank: z.number().int().min(1).max(99).optional(),
  decision: z.enum(pitchDecisions).default("proposed"),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type TopicPitch = z.infer<typeof topicPitchSchema>;

export const topicPitchesSchema = z
  .array(topicPitchSchema)
  .max(8)
  .refine((list) => new Set(list.map((p) => p.id)).size === list.length, "소재 후보 ID가 겹쳐요.");

/** One row of the board: the pitch plus the card it lives on. */
export interface TopicBoardItem extends TopicPitch {
  projectId: string;
  projectTitle: string;
  channelLabel: string;
  readinessLabel: string;
  effortLabel: string;
}

/** How many posts a channel still needs, so the board says why picking matters now. */
export interface TopicGap {
  channel: PublicationChannel;
  label: string;
  week: "this" | "next";
  remaining: number;
}

export interface TopicBoard {
  /** Picked pitches first, then proposals by readiness and rank. Dropped ones are only counted. */
  items: TopicBoardItem[];
  counts: { picked: number; ready: number; needs_edit: number; needs_user: number; hold: number; dropped: number };
  gaps: TopicGap[];
}

const readinessOrder: Record<PitchReadiness, number> = { ready: 0, needs_edit: 1, needs_user: 2, hold: 3 };

export function topicBoard(projects: Pick<Project, "id" | "title" | "pitches">[], gaps: TopicGap[] = []): TopicBoard {
  const counts = { picked: 0, ready: 0, needs_edit: 0, needs_user: 0, hold: 0, dropped: 0 };
  const items: TopicBoardItem[] = [];
  for (const project of projects) {
    for (const pitch of project.pitches ?? []) {
      if (pitch.decision === "dropped") {
        counts.dropped += 1;
        continue;
      }
      if (pitch.decision === "picked") counts.picked += 1;
      else counts[pitch.readiness] += 1;
      items.push({
        ...pitch,
        projectId: project.id,
        projectTitle: project.title,
        channelLabel: publicationChannelLabels[pitch.channel],
        readinessLabel: pitchReadinessLabels[pitch.readiness],
        effortLabel: pitchEffortLabels[pitch.effort],
      });
    }
  }
  items.sort(
    (a, b) =>
      Number(b.decision === "picked") - Number(a.decision === "picked") ||
      readinessOrder[a.readiness] - readinessOrder[b.readiness] ||
      (a.rank ?? 100) - (b.rank ?? 100) ||
      a.title.localeCompare(b.title, "ko"),
  );
  const pitched = new Set(items.map((i) => i.channel));
  return { items, counts, gaps: gaps.filter((g) => g.remaining > 0 && pitched.has(g.channel)) };
}

/** Channel gaps from the weekly-goals view, for the channels pitches can fill. */
export function topicGaps(goals: {
  thisWeek: { channels: { channel: PublicationChannel; label: string; remaining: number }[] };
  nextWeek: { channels: { channel: PublicationChannel; label: string; remaining: number }[] };
}): TopicGap[] {
  const pick = (week: "this" | "next", channels: { channel: PublicationChannel; label: string; remaining: number }[]) =>
    channels.map(({ channel, label, remaining }) => ({ channel, label, week, remaining }));
  return [...pick("this", goals.thisWeek.channels), ...pick("next", goals.nextWeek.channels)];
}

/** Replace one pitch's decision, keeping everything else. Returns a new list. */
export function decidePitch(pitches: TopicPitch[], id: string, decision: PitchDecision, now = new Date()): TopicPitch[] {
  if (!pitches.some((p) => p.id === id)) throw new Error("PITCH_NOT_FOUND");
  return pitches.map((p) => (p.id === id ? { ...p, decision, updatedAt: now.toISOString() } : p));
}

/** Replace a project's pitches; an empty list removes them. */
export const setPitchesSchema = z.strictObject({
  projectId: z.string().min(1).max(160),
  expectedUpdatedAt: dashboardRevision,
  pitches: topicPitchesSchema,
});
export type SetPitchesInput = z.infer<typeof setPitchesSchema>;

export const decidePitchSchema = z.strictObject({
  projectId: z.string().min(1).max(160),
  pitchId: topicPitchSchema.shape.id,
  decision: z.enum(pitchDecisions),
  expectedUpdatedAt: dashboardRevision,
});
export type DecidePitchInput = z.infer<typeof decidePitchSchema>;

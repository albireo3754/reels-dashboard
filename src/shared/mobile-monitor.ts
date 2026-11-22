import type { Dashboard } from "./contracts";
import type { Planning } from "./planning";
import { computeAutopilotView, outcomeLabel, type AutopilotConfig, type AutopilotState, type ProcessProbe } from "./autopilot";
import { projectState } from "./project-state";
import { weeklyGoalsView } from "./weekly-goals";
import { blockedNotice, statusLine } from "./autopilot-notices";
import { topicBoard, topicGaps } from "./topic-pitch";

/** Owner-private progress only. No source paths, private notes, reports, executor config or provider credentials. */
export function mobileMonitor(dashboard: Dashboard, planning: Planning, state: AutopilotState, config: AutopilotConfig, now: Date, probe: ProcessProbe) {
  const view = computeAutopilotView({ projects: dashboard.projects, planning, state, config, now, probe });
  const goals = weeklyGoalsView(planning, dashboard.projects, now);
  const week = (w: typeof goals.thisWeek) => ({ from: w.from, to: w.to, totals: w.totals, channels: w.channels.map(c => ({
    channel: c.channel, label: c.label, target: c.target, published: c.published, scheduled: c.scheduled, remaining: c.remaining,
    candidates: c.candidates.slice(0, c.remaining).map(({ projectId, title, status, ready }) => ({ projectId, title, status, ready })),
  })) });
  const pick = view.today;
  const sourceBoards = dashboard.projects.flatMap(p => p.sourceBoard ? [{ projectId: p.id, board: p.sourceBoard }] : []);
  const topics = topicBoard(dashboard.projects, topicGaps(goals));
  return {
    states: Object.fromEntries(dashboard.projects.map(p => [p.id, projectState(p, now).state])),
    monitor: {
      generatedAt: now.toISOString(),
      // What to make next. Pitch text is validated path- and credential-free (topic-pitch.ts).
      // Sent only once pitches exist, so a site that predates the field is never handed one.
      ...(sourceBoards.length ? { sourceBoards } : {}),
      ...(topics.items.length ? { topics } : {}),
      thisWeek: week(goals.thisWeek), nextWeek: week(goals.nextWeek),
      queue: { until: goals.queue.until, channels: goals.queue.channels.map(c => ({
        channel: c.channel, label: c.label, cap: c.cap, booked: c.booked.length + c.beyond.length,
        open: c.open, full: c.full, inProduction: c.inProduction,
        rows: [...c.booked.map(b => ({ projectId: b.projectId, title: b.title, day: b.day, status: "scheduled" as const })),
          ...c.slots.map(s => ({ projectId: s.projectId, title: s.title, day: s.day, phase: s.phase, status: "suggested" as const }))].sort((a, b) => a.day.localeCompare(b.day)),
      })) },
      autopilot: { enabled: view.enabled, paused: Boolean(view.paused), notice: blockedNotice(view), status: statusLine(view),
        today: pick ? { title: pick.title, target: /^https?:\/\//.test(pick.target) || pick.target.startsWith("project:") ? pick.target : "",
          why: pick.why, decision: pick.decision, doneWhen: pick.doneWhen,
          outcome: pick.outcome ? outcomeLabel[pick.outcome] : null, changeCount: pick.changes?.length ?? 0 } : null },
    },
  };
}

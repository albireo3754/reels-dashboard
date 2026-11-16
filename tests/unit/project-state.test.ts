import { test } from "node:test";
import assert from "node:assert/strict";
import type { Project } from "../../src/shared/contracts";
import { validateDashboard } from "../../src/shared/data";
import { publicationsSchema } from "../../src/shared/publications";
import { setPublicationSchema, contentInputSchema } from "../../src/shared/local-resources";
import { isActiveState, projectState } from "../../src/shared/project-state";
import { selectBoardProjects, defaultBoardQuery } from "../../src/features/content-board/model/board-query";
import { buildQueue } from "../../src/shared/autopilot";

const now = new Date("2026-11-16T12:00:00+09:00");
const base = (p: Partial<Project> & Pick<Project, "id" | "stage">): Project => ({
  title: p.id, date: "2026-11-01", nextAction: "", publicURL: "", shared: false, ...p,
});
const blogLive = { channel: "blog" as const, status: "published" as const, url: "", publishedAt: "2026-11-13" };

test("work done is complete without claiming any channel is live", () => {
  const p = base({ id: "dosieobu", stage: "done", publications: [blogLive, { channel: "naver-clip", status: "draft", url: "https://clipcreators.naver.com/web/draft/1" }] });
  const s = projectState(p, now);
  assert.equal(s.state, "complete");
  assert.equal(s.needsUserReview, false);
  assert.deepEqual(s.pendingChannels.map((c) => c.status), ["draft"]);
  assert.equal(p.publications!.some((c) => c.channel === "naver-clip" && c.status === "published"), false);
});

test("partial channels stay pending; draft is not complete", () => {
  const s = projectState(base({ id: "kirin", stage: "published", publications: [{ channel: "instagram", status: "published", url: "" }, { channel: "blog", status: "draft", url: "" }] }), now);
  assert.equal(s.state, "channel_pending");
  assert.equal(s.needsUserReview, true);
  assert.equal(isActiveState(s.state), true);
});

test("scheduled channels wait on the channel; a past time is reported, never promoted", () => {
  const p = base({ id: "incheon", stage: "published", publications: [{ channel: "instagram", status: "published", url: "" }, { channel: "naver-clip", status: "scheduled", url: "", scheduledAt: "2026-11-13T15:56:00+09:00" }] });
  const s = projectState(p, now);
  assert.equal(s.state, "scheduled");
  assert.deepEqual(s.scheduledPast, ["naver-clip"]);
  assert.equal(isActiveState(s.state), false);
  assert.equal(p.publications![1].status, "scheduled");
  const future = projectState({ ...p, publications: [{ channel: "naver-clip", status: "scheduled", url: "", scheduledAt: "2026-11-20T15:56:00+09:00" }] }, now);
  assert.deepEqual(future.scheduledPast, []);
});

test("scheduled does not depend on stage published", () => {
  const first = base({ id: "new-clip", stage: "review", publications: [{ channel: "youtube", status: "scheduled", url: "", scheduledAt: "2026-11-20T15:56:00+09:00" }] });
  const s = projectState(first, now);
  assert.equal(s.state, "scheduled");
  assert.equal(s.needsUserReview, false);
  const mixed = projectState({ ...first, publications: [...first.publications!, { channel: "blog", status: "planned", url: "" }] }, now);
  assert.equal(mixed.state, "review", "a planned channel next to a scheduled one keeps the stage reading");
  const doneWins = projectState({ ...first, stage: "done" }, now);
  assert.equal(doneWins.state, "complete");
  const onlyLive = projectState(base({ id: "one", stage: "published", publications: [{ channel: "instagram", status: "published", url: "" }] }), now);
  assert.equal(onlyLive.state, "complete", "published with its only target channel live needs nothing else");
  const noTargets = projectState(base({ id: "legacy", stage: "published" }), now);
  assert.equal(noTargets.state, "complete", "published without channel entries (publicURL era) is complete");
});

test("stage alone decides only for projects that are not published or done", () => {
  assert.equal(projectState(base({ id: "a", stage: "review" }), now).state, "review");
  assert.equal(projectState(base({ id: "b", stage: "captured" }), now).state, "in_progress");
  assert.equal(projectState(base({ id: "c", stage: "published", publications: [blogLive] }), now).state, "complete");
  assert.equal(projectState(base({ id: "op", stage: "idea", kind: "operation" }), now).kind, "operation");
});

test("scheduledAt is required for scheduled and refused elsewhere", () => {
  assert.throws(() => publicationsSchema.parse([{ channel: "naver-clip", status: "scheduled", url: "" }]));
  assert.throws(() => publicationsSchema.parse([{ channel: "blog", status: "draft", url: "", scheduledAt: "2026-11-20T15:56:00+09:00" }]));
  assert.throws(() => publicationsSchema.parse([{ channel: "blog", status: "scheduled", url: "", scheduledAt: "2026-11-20 15:56" }]));
  assert.equal(publicationsSchema.parse([{ channel: "youtube", status: "scheduled", url: "", scheduledAt: "2026-11-20T15:56:00+09:00" }]).length, 1);
  assert.throws(() => setPublicationSchema.parse({ projectId: "x", expectedUpdatedAt: "2026-11-15T13:53:04.351Z", channel: "naver-clip", status: "scheduled" }));
  assert.equal(setPublicationSchema.parse({ projectId: "x", expectedUpdatedAt: "2026-11-15T13:53:04.351Z", channel: "youtube", status: "scheduled", scheduledAt: "2026-11-20T15:56:00+09:00" }).channel, "youtube");
});

test("stored dashboard validates kind, done and scheduled; rejects unknown kind", () => {
  const dash = { schemaVersion: 1, updatedAt: "2026-11-16T03:00:00.000Z", projects: [
    base({ id: "op:x", kind: "operation", stage: "review" }),
    base({ id: "d", stage: "done" }),
    base({ id: "s", stage: "published", publications: [{ channel: "naver-clip", status: "scheduled", url: "", scheduledAt: "2026-11-20T15:56:00+09:00" }] }),
  ] };
  assert.equal(validateDashboard(dash).projects[0].kind, "operation");
  assert.throws(() => validateDashboard({ ...dash, projects: [{ ...dash.projects[0], kind: "series" }] }));
  assert.equal(contentInputSchema.shape.stage.parse("done"), "done");
});

test("board active filter and autopilot use the same reading", () => {
  const projects = [
    base({ id: "done", stage: "done", publications: [{ channel: "naver-clip", status: "draft", url: "" }] }),
    base({ id: "sched", stage: "published", publications: [{ channel: "naver-clip", status: "scheduled", url: "", scheduledAt: "2026-11-20T15:56:00+09:00" }] }),
    base({ id: "pending", stage: "published", publications: [{ channel: "blog", status: "draft", url: "" }] }),
    base({ id: "rev", stage: "review" }),
  ];
  const board = selectBoardProjects(projects, { ...defaultBoardQuery, stage: "active" }).map((p) => p.id).sort();
  assert.deepEqual(board, ["pending", "rev"]);
  const clipBoard = selectBoardProjects(projects, { ...defaultBoardQuery, stage: "active", channel: "naver-clip" }).map((p) => p.id);
  assert.deepEqual(clipBoard, [], "a done or scheduled project is not active in a channel view either");
  const complete = selectBoardProjects(projects, { ...defaultBoardQuery, stage: "complete" }).map((p) => p.id);
  assert.deepEqual(complete, ["done"]);
  const queue = buildQueue({ planning: { schemaVersion: 1 } as never, projects, ledger: [], now, config: { staleAfterMinutes: 60 } as never });
  assert.deepEqual([...queue.review, ...queue.active, ...queue.candidates].map((i) => i.key).sort(), ["pending", "rev"]);
  assert.deepEqual(queue.review.map((i) => i.key).sort(), ["pending", "rev"]);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emptyPlanning, planningSchema, weekPlan, type Planning } from "../../src/shared/planning";
import { PlanningStore } from "../../src/shared/lib/planning-store";
import { bookingQueue, defaultWeeklyTargets, finishedBlogRuns, targetFields, weekGoals, weeklyGoalsView, weeklyTargetsOf } from "../../src/shared/weekly-goals";
import type { Project } from "../../src/shared/contracts";
import type { Publication } from "../../src/shared/publications";

// Monday 2026-11-16, 10:00 KST (the week runs from Sunday 11-15).
const now = new Date("2026-11-16T01:00:00Z");
const project = (id: string, publications: Publication[], extra: Partial<Project> = {}): Project =>
  ({ id, title: id, date: "2026-11-01", nextAction: `next ${id}`, stage: "review", publicURL: "", shared: false, publications, ...extra });
const scheduled = (channel: Publication["channel"], at: string): Publication => ({ channel, status: "scheduled", url: "", scheduledAt: at });
const published = (channel: Publication["channel"], day: string): Publication => ({ channel, status: "published", url: "", publishedAt: day });
const planned = (channel: Publication["channel"], status: "planned" | "draft" = "planned"): Publication => ({ channel, status, url: "" });
/** A YouTube entry marked as a Short; only these count toward the Shorts goal. */
const short = (p: Publication): Publication => ({ ...p, format: "shorts" });

test("targets: defaults per channel, the older clip target when nothing per channel was saved", () => {
  assert.deepEqual(defaultWeeklyTargets, { blog: 2, "naver-clip": 3, instagram: 2, youtube: 1 });
  assert.deepEqual(weeklyTargetsOf({ ...emptyPlanning(), weeklyTarget: 5 }), { ...defaultWeeklyTargets, "naver-clip": 5 });
  const saved = { blog: 1, "naver-clip": 2, instagram: 0, youtube: 1 };
  assert.deepEqual(weeklyTargetsOf({ ...emptyPlanning(), weeklyTargets: saved }), saved);
  // A file saved before per-channel targets still parses.
  assert.equal(planningSchema.safeParse({ ...emptyPlanning(), weeklyTargets: undefined }).success, true);
  assert.equal(planningSchema.safeParse({ ...emptyPlanning(), weeklyTargets: { ...saved, blog: 15 } }).success, false);
});

test("target updates merge one channel and keep the older clip target in step", () => {
  const current = emptyPlanning();
  assert.deepEqual(targetFields(current, {}), {});
  assert.deepEqual(targetFields(current, { weeklyTargets: { blog: 3 } }), { weeklyTargets: { ...defaultWeeklyTargets, blog: 3 }, weeklyTarget: 3 });
  assert.deepEqual(targetFields(current, { weeklyTargets: { "naver-clip": 4 } }).weeklyTarget, 4);
  assert.deepEqual(targetFields(current, { weeklyTarget: 6 }).weeklyTargets?.["naver-clip"], 6);
  // A clip target of 0 leaves the older field (minimum 1) as it was.
  assert.equal("weeklyTarget" in targetFields(current, { weeklyTargets: { "naver-clip": 0 } }), false);
});

test("the store saves a partial target change and keeps the other channels", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "weekly-goals-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PlanningStore(root);
  let current = await store.get();
  current = await store.update({ expectedUpdatedAt: current.updatedAt, weeklyTargets: { youtube: 2 } });
  assert.deepEqual(current.weeklyTargets, { ...defaultWeeklyTargets, youtube: 2 });
  current = await store.update({ expectedUpdatedAt: current.updatedAt, weeklyTargets: { "naver-clip": 4 } });
  assert.deepEqual([current.weeklyTargets?.youtube, current.weeklyTargets?.["naver-clip"], current.weeklyTarget], [2, 4, 4]);
  await assert.rejects(async () => store.update({ expectedUpdatedAt: current.updatedAt, weeklyTargets: {} }), /No update supplied/);
});

test("a booking recorded on the project counts for its week, and wins over the calendar copy", () => {
  const event = { id: "e1", projectId: "torahachi", title: "토라하치", start: "2026-11-18T15:56:00+09:00", url: "https://calendar.google.com/calendar/event?eid=x", channel: "naver-clip" as const, cancelled: false };
  const planning: Planning = { ...emptyPlanning(), calendar: { url: "https://calendar.google.com/calendar/u/0/r/week", syncedAt: "2026-11-12T00:00:00Z", window: { from: "2026-11-09", to: "2026-11-30" }, events: [event] } };
  const moved = [project("torahachi", [published("instagram", "2026-10-01"), scheduled("naver-clip", "2026-11-27T15:56:00+09:00")], { stage: "published" })];
  assert.equal(weekPlan(planning, moved, "2026-11-16", "naver-clip").posts.length, 0, "moved to the next week");
  const next = weekPlan(planning, moved, "2026-11-23", "naver-clip");
  assert.deepEqual(next.posts.map(p => [p.day, p.status]), [["2026-11-27", "planned"]]);
  const here = [project("imopipi", [scheduled("naver-clip", "2026-11-16T15:56:00+09:00")])];
  assert.equal(weekPlan(emptyPlanning(), here, "2026-11-16", "naver-clip", 3).remaining, 2);
});

test("week goals: per-channel counts, totals capped at the target, candidates in work order", () => {
  const projects = [
    project("blog-live", [published("blog", "2026-11-17")], { stage: "published" }),
    project("blog-a", [planned("blog", "draft")], { priority: 2, stage: "editing" }),
    project("blog-b", [planned("blog")], { priority: 1, stage: "editing" }),
    project("reel-1", [published("instagram", "2026-11-16")], { stage: "published" }),
    project("reel-2", [published("instagram", "2026-11-18")], { stage: "published" }),
    project("reel-3", [published("instagram", "2026-11-19")], { stage: "published" }),
    project("short", [short(planned("youtube"))], { stage: "captured" }),
    project("finished", [planned("blog")], { stage: "done" }),
  ];
  const goals = weekGoals(emptyPlanning(), projects, "2026-11-16", now);
  const by = Object.fromEntries(goals.channels.map(c => [c.channel, c]));
  assert.deepEqual([by.blog.published, by.blog.remaining], [1, 1]);
  assert.deepEqual(by.blog.candidates.map(c => [c.projectId, c.status, c.phase, c.ready]), [["blog-b", "planned", "production", false], ["blog-a", "draft", "draft", true]], "priority first; done projects are left out");
  assert.deepEqual([by.instagram.published, by.instagram.remaining], [3, 0]);
  assert.deepEqual(by.youtube.candidates.map(c => [c.projectId, c.ready]), [["short", false]]);
  // 3 reels count as 2 toward a target of 2.
  assert.deepEqual(goals.totals, { target: 8, done: 3, remaining: 5 });
  assert.deepEqual(goals.channels.map(c => c.label), ["블로그", "클립", "릴스", "쇼츠"]);
});

test("clip candidates: projects planned for the clip first, then live Reels without a clip entry, newest first", () => {
  const projects = [
    project("old-reel", [published("instagram", "2026-09-01")], { stage: "published" }),
    project("new-reel", [published("instagram", "2026-11-01")], { stage: "published" }),
    project("on-clip", [published("instagram", "2026-10-01"), published("naver-clip", "2026-10-02")], { stage: "published" }),
    project("clip-draft", [planned("naver-clip", "draft")]),
  ];
  const clip = weekGoals(emptyPlanning(), projects, "2026-11-16", now).channels.find(c => c.channel === "naver-clip")!;
  assert.deepEqual(clip.candidates.map(c => [c.projectId, c.status]), [["clip-draft", "draft"], ["new-reel", "reuse"], ["old-reel", "reuse"]]);
});

test("booking queue: at most two weeks of posts, never a slot past 14 days, nothing more when full", () => {
  const targets = { blog: 2, "naver-clip": 3, instagram: 2, youtube: 1 };
  const planning: Planning = { ...emptyPlanning(), weeklyTargets: targets };
  const ready = (id: string, priority?: number) => project(id, [planned("instagram")], { stage: "editing", resources: [{ role: "final", path: `/tmp/${id}.mp4`, label: "완성본" }], ...(priority ? { priority } : {}) });
  const projects = [
    project("booked-1", [scheduled("instagram", "2026-11-18T19:00:00+09:00")]),
    project("past", [scheduled("instagram", "2026-11-15T19:00:00+09:00")]),
    ready("r1", 1), ready("r2"), ready("r3"), ready("r4"),
    project("wip", [planned("instagram")], { stage: "editing" }),
  ];
  const queue = bookingQueue(planning, projects, now);
  const reels = queue.channels.find(c => c.channel === "instagram")!;
  assert.equal(queue.until, "2026-11-30");
  assert.deepEqual([reels.cap, reels.booked.length, reels.open, reels.full], [4, 1, 3, false], "a passed booking is not ahead");
  assert.deepEqual(reels.ready.map(r => r.projectId), ["r1", "r2", "r3", "r4"]);
  assert.equal(reels.inProduction, 1);
  assert.equal(reels.slots.length, 3, "only up to the cap, though four are ready");
  assert.equal(reels.slots[0].projectId, "r1");
  for (const slot of reels.slots) {
    assert.ok(slot.day > "2026-11-16" && slot.day < "2026-11-30", slot.day);
    assert.notEqual(slot.day, "2026-11-18");
  }
  assert.equal(new Set(reels.slots.map(s => s.day)).size, 3);
  // Spaced by about a week / target (3 days for 2 a week) when the horizon allows it.
  for (const slot of reels.slots) assert.ok(Math.abs(Date.parse(slot.day) - Date.parse("2026-11-18")) >= 3 * 86_400_000, slot.day);

  const full = bookingQueue(planning, [
    ...["a", "b", "c", "d"].map((id, i) => project(id, [scheduled("instagram", `2026-11-${20 + i}T19:00:00+09:00`)])),
    ready("extra"),
  ], now).channels.find(c => c.channel === "instagram")!;
  assert.deepEqual([full.open, full.full, full.slots.length], [0, true, 0]);

  const far = bookingQueue(planning, [project("far", [short(scheduled("youtube", "2026-12-10T19:00:00+09:00"))]), project("s2", [short(planned("youtube"))])], now)
    .channels.find(c => c.channel === "youtube")!;
  assert.deepEqual([far.booked.length, far.beyond.length, far.open], [0, 1, 1], "a booking past the horizon still uses the cap");
});

test("phases: a project waiting for review is kept apart from reviewed work and is never proposed for booking", () => {
  const final = { resources: [{ role: "final" as const, path: "/tmp/cut.mp4", label: "완성본" }] };
  const projects = [
    project("in-review", [planned("instagram")], { stage: "review", priority: 1, ...final }),
    project("on-channel", [planned("instagram", "draft")], { stage: "editing", priority: 2 }),
    project("finished", [planned("instagram")], { stage: "editing", priority: 3, ...final }),
    project("live-elsewhere", [published("naver-clip", "2026-11-01"), planned("instagram")], { stage: "published", priority: 4 }),
    project("making", [planned("instagram")], { stage: "editing", priority: 5 }),
  ];
  const reels = weekGoals(emptyPlanning(), projects, "2026-11-16", now).channels.find(c => c.channel === "instagram")!;
  assert.deepEqual(reels.candidates.map(c => [c.projectId, c.phase, c.ready]), [
    ["in-review", "review", false],
    ["on-channel", "draft", true],
    ["finished", "final", true],
    ["live-elsewhere", "final", true],
    ["making", "production", false],
  ], "a final file does not make a project still in review ready");
  const queue = bookingQueue(emptyPlanning(), projects, now).channels.find(c => c.channel === "instagram")!;
  assert.deepEqual(queue.ready.map(c => c.projectId), ["on-channel", "finished", "live-elsewhere"]);
  assert.deepEqual(queue.inReview.map(c => c.projectId), ["in-review"]);
  assert.equal(queue.inProduction, 1);
  assert.ok(!queue.slots.some(s => s.projectId === "in-review"), "never proposed while in review");
  assert.deepEqual(queue.slots.map(s => [s.projectId, s.phase]), [["on-channel", "draft"], ["finished", "final"], ["live-elsewhere", "final"]]);
  // A draft already on the channel is still waiting for review while the project is in review.
  const early = bookingQueue(emptyPlanning(), [project("early-draft", [planned("instagram", "draft")], { stage: "review" })], now).channels.find(c => c.channel === "instagram")!;
  assert.deepEqual([early.ready.length, early.inReview.map(c => [c.projectId, c.status, c.phase])], [0, [["early-draft", "draft", "review"]]]);
  // A live Reel re-uploaded as a clip has passed review, even if the project is back in review for another channel.
  const clip = weekGoals(emptyPlanning(), [
    project("reel", [published("instagram", "2026-11-02")], { stage: "published" }),
    project("reel-in-review", [published("instagram", "2026-11-01"), short(planned("youtube"))], { stage: "review" }),
  ], "2026-11-16", now).channels.find(c => c.channel === "naver-clip")!;
  assert.deepEqual(clip.candidates.map(c => [c.projectId, c.status, c.phase, c.ready]), [["reel", "reuse", "reuse", true], ["reel-in-review", "reuse", "reuse", true]]);
});

test("booking queue: a channel with no target proposes nothing; every goal channel is queued, the blog first", () => {
  const planning: Planning = { ...emptyPlanning(), weeklyTargets: { blog: 2, "naver-clip": 0, instagram: 2, youtube: 1 } };
  const queue = bookingQueue(planning, [project("c", [planned("naver-clip")])], now);
  assert.deepEqual(queue.channels.map(c => c.channel), ["blog", "naver-clip", "instagram", "youtube"]);
  const clip = queue.channels.find(c => c.channel === "naver-clip")!;
  assert.deepEqual([clip.cap, clip.slots.length, clip.full], [0, 0, true]);
});

// 2026-11-18: the queue was video-only ("영상 예약 큐"); the user asked for the blog in it too ("게시 대기열").
test("posting queue: the blog is queued like the videos — bookings count, drafts get slots, unwritten posts wait", () => {
  const event = { id: "e-blog", projectId: "cal-blog", title: "캘린더 블로그", start: "2026-11-24T10:00:00+09:00", url: "https://calendar.google.com/calendar/event?eid=b", channel: "blog" as const, cancelled: false };
  const planning: Planning = {
    ...emptyPlanning(), weeklyTargets: { blog: 2, "naver-clip": 3, instagram: 2, youtube: 1 },
    calendar: { url: "https://calendar.google.com/calendar/u/0/r/week", syncedAt: "2026-11-16T00:00:00Z", window: { from: "2026-11-09", to: "2026-11-30" }, events: [event] },
  };
  const final = { resources: [{ role: "final" as const, path: "/tmp/cut.mp4", label: "완성본" }] };
  const projects = [
    project("booked-blog", [published("instagram", "2026-11-01"), scheduled("blog", "2026-11-19T10:00:00+09:00")], { stage: "published" }),
    project("cal-blog", [planned("blog")], { stage: "editing" }),
    project("blog-draft", [published("instagram", "2026-11-02"), planned("blog", "draft")], { stage: "published", priority: 1 }),
    // A finished video or a live Reel says nothing about the blog post: not proposed until it is a blog draft.
    project("blog-unwritten", [published("instagram", "2026-11-03"), planned("blog")], { stage: "published", priority: 2, ...final }),
    project("blog-review", [planned("blog", "draft")], { stage: "review", priority: 3 }),
  ];
  const blog = bookingQueue(planning, projects, now).channels.find(c => c.channel === "blog")!;
  assert.deepEqual([blog.label, blog.cap], ["블로그", 4]);
  assert.deepEqual(blog.booked.map(b => [b.projectId, b.day, b.source]), [["booked-blog", "2026-11-19", "dashboard"], ["cal-blog", "2026-11-24", "calendar"]]);
  assert.deepEqual([blog.open, blog.full], [2, false]);
  assert.deepEqual(blog.ready.map(c => [c.projectId, c.phase]), [["blog-draft", "draft"]]);
  assert.deepEqual(blog.inReview.map(c => c.projectId), ["blog-review"]);
  assert.equal(blog.inProduction, 1, "the unwritten post");
  assert.deepEqual(blog.production.map(c => c.projectId), ["blog-unwritten"], "named, not just counted");
  assert.deepEqual(blog.slots.map(s => [s.projectId, s.phase]), [["blog-draft", "draft"]]);
  const slot = blog.slots[0].day;
  assert.ok(slot > "2026-11-16" && slot < "2026-11-30", slot);
  for (const taken of ["2026-11-19", "2026-11-24"]) assert.ok(Math.abs(Date.parse(slot) - Date.parse(taken)) >= 3 * 86_400_000, `${slot} keeps 3 days from ${taken}`);

  const tile = weekGoals(planning, projects, "2026-11-15", now).channels.find(c => c.channel === "blog")!;
  assert.deepEqual(tile.candidates.find(c => c.projectId === "blog-unwritten")?.phase, "production", "the tile badge agrees with the queue");
});

test("posting queue: a blog post whose blog run finished is proposed before it is a Naver draft", () => {
  const planning: Planning = { ...emptyPlanning(), weeklyTargets: { blog: 2, "naver-clip": 0, instagram: 0, youtube: 0 } };
  const projects = [
    project("booked", [scheduled("blog", "2026-11-18T12:00:00+09:00")], { stage: "captured" }),
    project("run-ready", [planned("blog")], { stage: "captured" }),
    project("still-writing", [planned("blog")], { stage: "captured" }),
    project("in-review", [planned("blog")], { stage: "review" }),
  ];
  const finishedBlogs = finishedBlogRuns({ runs: [
    { builtinDefinition: "blog", projectId: "run-ready", status: "ready" },
    { builtinDefinition: "blog", projectId: "still-writing", status: "waiting" },
    { builtinDefinition: "blog", projectId: "in-review", status: "ready" },
    { builtinDefinition: "reels", projectId: "booked", status: "ready" },
    { builtinDefinition: "blog", status: "ready" },
  ] });
  assert.deepEqual([...finishedBlogs].sort(), ["in-review", "run-ready"]);
  const blog = bookingQueue(planning, projects, now, { finishedBlogs }).channels.find(c => c.channel === "blog")!;
  assert.deepEqual(blog.ready.map(c => [c.projectId, c.phase]), [["run-ready", "final"]]);
  assert.deepEqual(blog.slots.map(s => [s.projectId, s.phase]), [["run-ready", "final"]]);
  assert.deepEqual(blog.production.map(c => c.projectId), ["still-writing"]);
  assert.deepEqual(blog.inReview.map(c => c.projectId), ["in-review"], "a project waiting for review stays there");
  // Without the run signal (old callers, workflow host down) the same post stays in production, by name.
  const plain = bookingQueue(planning, projects, now).channels.find(c => c.channel === "blog")!;
  assert.deepEqual([plain.ready.length, plain.production.map(c => c.projectId)], [0, ["run-ready", "still-writing"]]);
  const tile = weeklyGoalsView(planning, projects, now, { finishedBlogs }).thisWeek.channels.find(c => c.channel === "blog")!;
  assert.equal(tile.candidates.find(c => c.projectId === "run-ready")?.phase, "final", "the tile badge agrees with the queue");
  assert.deepEqual([finishedBlogRuns(null).size, finishedBlogRuns({ runs: "x" }).size], [0, 0]);
});

test("the view covers this week, next week and the queue from one snapshot", () => {
  const view = weeklyGoalsView(emptyPlanning(), [], now);
  assert.deepEqual([view.thisWeek.from, view.nextWeek.from, view.queue.horizonDays], ["2026-11-15", "2026-11-22", 14]);
  assert.deepEqual(view.targets, { ...defaultWeeklyTargets, "naver-clip": 3 });
});

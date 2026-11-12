import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emptyPlanning, weekPlan, monday, calendarImportSchema, type Planning } from "../../src/shared/planning";
import { PlanningStore } from "../../src/shared/lib/planning-store";
import type { Project } from "../../src/shared/contracts";

const event = (id: string, projectId: string, start: string) => ({ id, projectId, title: id, start, url: "https://calendar.google.com/calendar/event?eid=sample", channel: "naver-clip" as const, cancelled: false });
const calendar = { url: "https://calendar.google.com/calendar/u/0/r/week", syncedAt: "2026-11-12T08:00:00Z", window: { from: "2026-11-09", to: "2026-11-23" }, events: [event("one", "p1", "2026-11-13T15:56:00+09:00"), event("two", "p2", "2026-11-20T15:56:00+09:00")] };
const project = (id: string, publishedAt?: string): Project => ({ id, title: id, date: "2026-11-12", nextAction: "", stage: "published", publicURL: "", shared: false, publications: [{ channel: "naver-clip", status: "published", url: "", ...(publishedAt ? { publishedAt } : {}) }] });
test("weeks use Seoul Monday boundaries, including year rollover", () => {
  assert.equal(monday(new Date("2026-11-15T15:01:00Z")), "2026-11-16");
  assert.equal(monday(new Date("2027-01-01T00:00:00Z")), "2026-12-28");
});
test("counts completed and calendar plans separately; no project date guessing or double count", () => {
  const data: Planning = { ...emptyPlanning(), calendar: { ...calendar, events: [...calendar.events, event("duplicate", "p1", "2026-11-13T16:00:00+09:00"), { ...event("cancelled", "p3", "2026-11-13T15:56:00+09:00"), cancelled: true }] } };
  const projects = [project("done1", "2026-11-12"), project("done2", "2026-11-12"), project("unknown")];
  const week = weekPlan(data, projects, "2026-11-09", "naver-clip");
  assert.deepEqual([week.published, week.scheduled, week.remaining, week.covered], [2, 1, 0, true]);
  assert.deepEqual(weekPlan(data, projects, "2026-11-16", "naver-clip").remaining, 2);
  assert.equal(weekPlan(data, projects, "2026-11-09", "instagram").posts.length, 0);
  const done = weekPlan(data, [...projects, project("p1", "2026-11-13")], "2026-11-09", "naver-clip");
  assert.deepEqual([done.published, done.scheduled], [3, 0]);
  assert.equal(weekPlan(data, projects, "2026-11-23", "naver-clip").covered, false);
});
test("provider imports reject unsafe links, invalid dates and duplicate event IDs", () => {
  assert.equal(calendarImportSchema.safeParse({ ...calendar, url: "https://evil.example/calendar" }).success, false);
  assert.equal(calendarImportSchema.safeParse({ ...calendar, window: { from: "2026-02-30", to: "2026-03-04" } }).success, false);
  assert.equal(calendarImportSchema.safeParse({ ...calendar, events: [calendar.events[0], calendar.events[0]] }).success, false);
});
test("snapshot updates serialize revisions, preserve omitted provider and reject old observations", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "planning-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new PlanningStore(root);
  const initial = await service.get();
  const results = await Promise.allSettled([service.update({ expectedUpdatedAt: initial.updatedAt, calendar }), service.update({ expectedUpdatedAt: initial.updatedAt, weeklyTarget: 4 })]);
  assert.deepEqual(results.map(r => r.status), ["fulfilled", "rejected"]);
  let current = await service.get();
  current = await service.update({ expectedUpdatedAt: current.updatedAt, weeklyTarget: 4 });
  assert.equal(current.calendar?.events.length, 2);
  assert.equal(current.weeklyTarget, 4);
  await assert.rejects(service.update({ expectedUpdatedAt: current.updatedAt, calendar: { ...calendar, syncedAt: "2026-11-11T00:00:00Z" } }), /STALE_SOURCE/);
  assert.equal((await stat(path.join(root, "planning.json"))).mode & 0o777, 0o600);
  await writeFile(path.join(root, "planning.json"), "broken");
  await assert.rejects(service.get());
});

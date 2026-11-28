import test from "node:test";
import assert from "node:assert/strict";
import { mobileMonitor } from "../../src/shared/mobile-monitor";
import { emptyPlanning } from "../../src/shared/planning";
import { defaultAutopilotConfig, emptyAutopilotState } from "../../src/shared/autopilot";
import { weeklyGoalsView } from "../../src/shared/weekly-goals";
import { projectState } from "../../src/shared/project-state";
import type { Dashboard, Project } from "../../src/shared/contracts";
// @ts-expect-error Plain node SDK is also used by the LaunchAgent.
import { projectSnapshot } from "../../packages/icloud-object-sdk/index.mjs";
const now = new Date("2026-11-17T10:00:00Z");
const project = (id: string, stage: Project["stage"], publications: Project["publications"]): Project => ({ id, title: id, date: "2026-11-17", stage, nextAction: "남은 채널 게시", publicURL: "", shared: false, localNotes: "PRIVATE_NOTE", resources: [], priority: 2, publications });
const dashboard: Dashboard = { schemaVersion: 1, updatedAt: now.toISOString(), projects: [
  project("pending", "published", [{channel:"instagram",status:"published",url:"",publishedAt:"2026-11-16"},{channel:"naver-clip",status:"draft",url:""}]),
  project("scheduled", "review", [{channel:"naver-clip",status:"scheduled",url:"",scheduledAt:"2026-11-19T12:00:00+09:00"}]),
  project("done", "done", [{channel:"blog",status:"draft",url:""}]),
  project("long", "published", [{channel:"youtube",status:"published",url:"",publishedAt:"2026-11-16",format:"long"}]),
  project("short", "published", [{channel:"youtube",status:"published",url:"",publishedAt:"2026-11-16",format:"shorts"}]),
] };
const planning = { ...emptyPlanning(), weeklyTargets: {blog:2,"naver-clip":3,instagram:2,youtube:1} };
const make = (at=now) => mobileMonitor(dashboard,planning,emptyAutopilotState(),defaultAutopilotConfig(),at,{isAlive:()=>false});
test("mobile uses canonical states, week boundaries, Shorts-only goals and today's pick without private context", () => {
 const value=make();
 assert.deepEqual(value.states,Object.fromEntries(dashboard.projects.map(p=>[p.id,projectState(p,now).state])));
 assert.equal(value.states.pending,"channel_pending");assert.equal(value.states.scheduled,"scheduled");assert.equal(value.states.done,"complete");
 assert.equal(value.monitor.thisWeek.from,"2026-11-15");
 const expected=weeklyGoalsView(planning,dashboard.projects,now);
 assert.deepEqual(value.monitor.thisWeek.totals,expected.thisWeek.totals);
 assert.equal(value.monitor.thisWeek.channels.find(c=>c.channel==="youtube")?.published,1);
 assert.ok(value.monitor.autopilot.today?.decision.includes("네이버클립"));
 assert.equal(JSON.stringify(value).includes("PRIVATE_NOTE"),false);
 assert.equal(JSON.stringify(value).includes("reportPath"),false);
});
test("snapshot includes current progress and hashes planning changes even without a dashboard edit",async()=>{
 const first=(await projectSnapshot(dashboard,"fixture",{...make(),countFolders:false})).snapshot;
 assert.equal(first.contents.find((c:any)=>c.id==="done").stage,"done");
 assert.equal(first.contents.find((c:any)=>c.id==="pending").publications[1].status,"draft");
 const later=(await projectSnapshot(dashboard,"fixture",{...make(new Date(now.getTime()+60_000)),countFolders:false})).snapshot;
 assert.equal(first.sourceRevision,later.sourceRevision,"clock-only updates must not duplicate snapshots");
 const changed=mobileMonitor(dashboard,{...planning,weeklyTargets:{...planning.weeklyTargets,blog:3}},emptyAutopilotState(),defaultAutopilotConfig(),now,{isAlive:()=>false});
 const next=(await projectSnapshot(dashboard,"fixture",{...changed,countFolders:false})).snapshot;
 assert.notEqual(first.sourceRevision,next.sourceRevision);

});
test("mobile queue follows the desktop: a finished blog run is suggested as 완성본 with the same payload fields", () => {
 const blog = project("blog-run-ready", "captured", [{channel:"blog",status:"planned",url:""}]);
 const board: Dashboard = { ...dashboard, projects: [...dashboard.projects, blog] };
 const run = (signals?: Parameters<typeof mobileMonitor>[6]) => mobileMonitor(board,planning,emptyAutopilotState(),defaultAutopilotConfig(),now,{isAlive:()=>false},signals).monitor.queue.channels.find(c=>c.channel==="blog")!;
 const before = run(), after = run({ finishedBlogs: new Set(["blog-run-ready"]) });
 assert.equal(before.rows.some(r => r.projectId === "blog-run-ready"), false);
 assert.equal(before.inProduction, 1);
 const row = after.rows.find(r => r.projectId === "blog-run-ready");
 assert.deepEqual([row?.status, (row as { phase?: string } | undefined)?.phase], ["suggested", "final"]);
 assert.equal(after.inProduction, 0);
 assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), "no new fields for the strict site schema");
});

test("briefing displays dashboard weekly posts and upcoming reservations without exposing URLs", () => {
 const checkAt = new Date("2026-11-20T00:00:00Z");
 const expected = weeklyGoalsView(planning, dashboard.projects, checkAt);
 const {monitor} = make(checkAt);
 for (const [i, channel] of expected.thisWeek.channels.entries()) {
   assert.deepEqual(monitor.thisWeek.channels[i].posts, channel.posts.map(({projectId,title,day,status}) => ({projectId,title,day,status})));
 }
 assert.ok(monitor.thisWeek.channels.some(c => c.posts.some(p => p.projectId === "scheduled")));
 assert.ok(!monitor.reservations.some(p => p.projectId === "scheduled"));
 assert.ok(make().monitor.reservations.some(p => p.projectId === "scheduled"));
 assert.equal(monitor.thirdWeek.from, expected.nextWeek.to);
});

test("the running app owns calendar-only and beyond-horizon bookings shown in the briefing", () => {
 const projectId = "calendar-" + "x".repeat(200);
 const calendarUrl = "https://calendar.google.com/calendar/event?eid=private";
 const event = { id: "event", projectId, title: "캘린더 예약", channel: "youtube" as const, start: "2026-12-20T15:00:00+09:00", url: calendarUrl, cancelled: false };
 const livePlanning = { ...planning, calendar: { url: calendarUrl, syncedAt: now.toISOString(), window: {from: "2026-11-15", to: "2026-12-31"}, events: [event, {...event, id: "cancelled", projectId: "cancelled", cancelled: true}] } };
 const live = weeklyGoalsView(livePlanning, dashboard.projects, now);
 const { monitor } = mobileMonitor(dashboard, planning, emptyAutopilotState(), defaultAutopilotConfig(), now, {isAlive: () => false}, {}, live);
 assert.deepEqual(monitor.reservations.map(r => r.projectId), ["scheduled", projectId]);
 assert.ok(!JSON.stringify(monitor).includes(calendarUrl));
});

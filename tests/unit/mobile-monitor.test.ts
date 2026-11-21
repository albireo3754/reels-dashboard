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

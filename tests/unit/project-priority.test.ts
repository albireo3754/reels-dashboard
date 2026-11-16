import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Project } from "../../src/shared/contracts";
import { validateDashboard } from "../../src/shared/data";
import { LocalStore } from "../../src/shared/lib/storage";
import { ContentLibrary } from "../../src/features/content-library";
import type { ContentInput } from "../../src/shared/local-resources";
import { selectBoardProjects, defaultBoardQuery } from "../../src/features/content-board/model/board-query";
import { buildQueue, pickToday } from "../../src/shared/autopilot";
import { upsertExportedProject } from "../../src/shared/production-project";

const now = new Date("2026-11-16T12:00:00+09:00");
const base = (p: Partial<Project> & Pick<Project, "id" | "stage">): Project => ({
  title: p.id, date: "2026-11-01", nextAction: "", publicURL: "", shared: false, ...p,
});

test("upsert keeps the stored order when omitted, clears it with null, and refuses non-positive values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reels-priority-"));
  try {
    const store = new LocalStore(root);
    await store.initialize();
    const lib = new ContentLibrary(store, () => {});
    const content: ContentInput = {
      id: "content:x", title: "x", date: "2026-11-16", dateBasis: "record", stage: "editing",
      nextAction: "", publicURL: "", localNotes: "", resources: [], priority: 3,
    };
    let r = await lib.upsert(content, (await store.load()).updatedAt);
    assert.equal(r.project.priority, 3);
    const { priority: _omit, ...withoutPriority } = content;
    r = await lib.upsert({ ...withoutPriority, title: "renamed" }, r.updatedAt);
    assert.equal(r.project.priority, 3, "omitted keeps the stored order");
    r = await lib.upsert({ ...content, priority: null }, r.updatedAt);
    assert.equal("priority" in r.project, false, "null clears it");
    await assert.rejects(() => lib.upsert({ ...content, priority: 0 }, r.updatedAt));
    await assert.rejects(() => lib.upsert({ ...content, priority: 1.5 }, r.updatedAt));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stored dashboard keeps a valid order and rejects an invalid one", () => {
  const dash = { schemaVersion: 1, updatedAt: "2026-11-16T03:00:00.000Z", projects: [base({ id: "a", stage: "editing", priority: 2 })] };
  assert.equal(validateDashboard(dash).projects[0].priority, 2);
  assert.throws(() => validateDashboard({ ...dash, projects: [{ ...dash.projects[0], priority: 0 }] }));
  assert.throws(() => validateDashboard({ ...dash, projects: [{ ...dash.projects[0], priority: "1" }] }));
});

test("board work-order sort: state first, then the user's order, numbered before unnumbered", () => {
  const projects = [
    base({ id: "done1", stage: "done", priority: 1 }),
    base({ id: "edit-none", stage: "editing" }),
    base({ id: "edit-2", stage: "captured", priority: 2 }),
    base({ id: "review-9", stage: "review", priority: 9 }),
    base({ id: "pending-4", stage: "published", priority: 4, publications: [{ channel: "blog", status: "draft", url: "" }] }),
  ];
  const ids = selectBoardProjects(projects, { ...defaultBoardQuery, stage: "all", sort: "priority" }).map((p) => p.id);
  assert.deepEqual(ids, ["pending-4", "review-9", "edit-2", "edit-none", "done1"]);
});

test("today's pick weighs the user's order among items that need the user; a finished #1 never comes back", () => {
  const projects = [
    base({ id: "late", stage: "review", priority: 8 }),
    base({ id: "first", stage: "review", priority: 1 }),
    base({ id: "closed", stage: "done", priority: 1 }),
  ];
  const queue = buildQueue({ planning: { schemaVersion: 1 } as never, projects, ledger: [], now, config: { staleAfterMinutes: 60 } as never });
  const today = pickToday(queue);
  assert.equal(today?.key, "first");
  assert.ok(today?.why.includes("작업 순번 1"));
  assert.equal(queue.review.some((i) => i.key === "closed"), false);
});

test("re-export keeps the user's order", () => {
  const dash = { schemaVersion: 1 as const, updatedAt: "2026-11-16T03:00:00.000Z", projects: [
    base({ id: "p", stage: "editing", priority: 5, production: { edits: [{ kind: "video", id: "e1" }], mergedIds: [], exports: [] } as never }),
  ] };
  const next = upsertExportedProject(dash, { kind: "video", id: "e1" }, {
    title: "t", stage: "review", nextAction: "검토", resources: [], exported: [],
  } as never, now, () => "id");
  assert.equal(next.projects.find((p) => p.id === "p")?.priority, 5);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Project } from "../../src/shared/contracts";
import { publicationsSchema } from "../../src/shared/publications";
import { setPublicationSchema } from "../../src/shared/local-resources";
import { emptyPlanning } from "../../src/shared/planning";
import { weekGoals, bookingQueue } from "../../src/shared/weekly-goals";
import { LocalStore } from "../../src/shared/lib/storage";
import { ContentLibrary } from "../../src/features/content-library";

const base = (p: Partial<Project> & Pick<Project, "id" | "stage">): Project => ({
  title: p.id, date: "2026-11-15", nextAction: "", publicURL: "", shared: false, ...p,
});
const now = new Date("2026-11-16T10:00:00+09:00");

test("format is YouTube only", () => {
  assert.ok(publicationsSchema.safeParse([{ channel: "youtube", status: "planned", url: "", format: "shorts" }]).success);
  assert.equal(publicationsSchema.safeParse([{ channel: "blog", status: "planned", url: "", format: "shorts" }]).success, false);
  assert.equal(setPublicationSchema.safeParse({ projectId: "a", expectedUpdatedAt: "2026-11-16T00:00:00.000Z", channel: "naver-clip", status: "planned", format: "long" }).success, false);
});

test("the Shorts goal counts Shorts only; long-form or unmarked YouTube posts do not complete it", () => {
  const projects = [
    base({ id: "ep01", stage: "published", publications: [{ channel: "youtube", status: "published", url: "", publishedAt: "2026-11-15" }] }),
    base({ id: "ep02", stage: "published", publications: [{ channel: "youtube", status: "published", url: "", publishedAt: "2026-11-15", format: "long" }] }),
    base({ id: "s01", stage: "review", publications: [{ channel: "youtube", status: "planned", url: "", format: "shorts" }] }),
    base({ id: "long-next", stage: "editing", publications: [{ channel: "youtube", status: "planned", url: "" }] }),
  ];
  const shorts = weekGoals(emptyPlanning(), projects, "2026-11-15", now).channels.find((c) => c.channel === "youtube")!;
  assert.deepEqual([shorts.published, shorts.scheduled, shorts.remaining], [0, 0, 1]);
  assert.deepEqual(shorts.candidates.map((c) => c.projectId), ["s01"]);
  const live = [...projects, base({ id: "s02", stage: "published", publications: [{ channel: "youtube", status: "published", url: "", publishedAt: "2026-11-16", format: "shorts" }] })];
  assert.equal(weekGoals(emptyPlanning(), live, "2026-11-15", now).channels.find((c) => c.channel === "youtube")!.published, 1);
  const queue = bookingQueue(emptyPlanning(), projects, now).channels.find((c) => c.channel === "youtube")!;
  assert.deepEqual(queue.ready.map((c) => c.projectId), ["s01"]);
});

test("set-publication keeps the stored format when it is omitted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reels-format-"));
  try {
    const store = new LocalStore(root);
    await store.initialize();
    const lib = new ContentLibrary(store, () => {});
    let r = await lib.upsert({ id: "s01", title: "s01", date: "2026-11-15", dateBasis: "record", stage: "review", nextAction: "", publicURL: "", localNotes: "", resources: [] }, (await store.load()).updatedAt);
    await lib.setPublication({ projectId: "s01", expectedUpdatedAt: r.updatedAt, channel: "youtube", status: "planned", format: "shorts" });
    const mid = await store.load();
    await lib.setPublication({ projectId: "s01", expectedUpdatedAt: mid.updatedAt, channel: "youtube", status: "published", url: "https://www.youtube.com/watch?v=x", publishedAt: "2026-11-16" });
    const entry = (await store.load()).projects[0].publications?.[0];
    assert.equal(entry?.format, "shorts");
    assert.equal(entry?.status, "published");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

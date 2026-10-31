import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Dashboard, Project } from "../../src/shared/contracts";
import { validateDashboard, toSnapshot } from "../../src/shared/data";
import { emptyProduction, editOwner, recordExports } from "../../src/shared/production-project";
import { LocalStore } from "../../src/shared/lib/storage";
import { ContentLibrary } from "../../src/features/content-library";
const project = (id: string, extra: Partial<Project> = {}): Project => ({
  id, title: id, date: "2026-10-31", stage: "review", nextAction: "", publicURL: "", shared: false, ...extra,
});
const board = (projects: Project[]): Dashboard => ({ schemaVersion: 1, projects, updatedAt: "2026-10-31T00:00:00.000Z" });

test("merge keeps resources, legacy edit ownership and complete backup across restart; rejects stale and alias resurrection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reels-projects-"));
  try {
    const edit = { kind: "card-news" as const, id: randomUUID() };
    const file = path.join(root, "draft.mp4");
    await writeFile(file, "original");
    const resource = { role: "draft" as const, path: file, label: "v7" };
    const input = board([project("content", { resources: [resource], shared: true }), project(edit.id, { resources: [resource], localNotes: "old notes" })]);
    const store = new LocalStore(root); await store.initialize(); await store.save(input);
    const before = await store.load();
    const lib = new ContentLibrary(store, () => {}, async () => [{ ...edit, title: "v7" }]);
    const result = await lib.merge({ targetId: "content", sourceIds: [edit.id], expectedUpdatedAt: before.updatedAt });
    assert.deepEqual(JSON.parse(await readFile(result.backupPath, "utf8")), before);
    const merged = (await new LocalStore(root).load()).projects[0];
    assert.equal(result.dashboard.projects.length, 1);
    assert.equal(merged.resources!.length, 1);
    assert.equal(merged.shared, true);
    assert.match(merged.localNotes!, /old notes/);
    assert.equal(merged.production!.exports.length, 1);
    assert.equal(editOwner(result.dashboard, edit)?.id, "content");
    assert.equal(await readFile(file, "utf8"), "original");
    assert.equal(toSnapshot(result.dashboard).projects[0].id, "content");
    assert.ok(!JSON.stringify(toSnapshot(result.dashboard)).includes(edit.id));
    await assert.rejects(lib.merge({ targetId: "content", sourceIds: [edit.id], expectedUpdatedAt: before.updatedAt }), /STALE_DASHBOARD/);
    const { shared: _shared, ...oldInput } = project(edit.id);
    await assert.rejects(lib.upsert({ ...oldInput, dateBasis: "record", localNotes: "", resources: [resource] }, result.dashboard.updatedAt), /PROJECT_MERGED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("project model rejects multiple owners, duplicate aliases, unknown edit and unlinked export", () => {
  const edit = { kind: "video" as const, id: randomUUID() };
  const model = { ...emptyProduction(), edits: [edit] };
  assert.throws(() => validateDashboard(board([project("a", { production: model }), project("b", { production: model })])), /EDIT_ALREADY_LINKED/);
  assert.throws(() => validateDashboard(board([project("a", { production: { ...model, mergedIds: ["b"] } }), project("b")])), /PROJECT_ALIAS_CONFLICT/);
  assert.throws(() => validateDashboard(board([
    project("a", { production: model }),
    project("b", { production: { ...emptyProduction(), mergedIds: [edit.id] } }),
  ])), /EDIT_ALREADY_LINKED/);
  const output = { role: "cover" as const, path: "/tmp/cover.png", label: "v1" };
  const p = project("a", { resources: [output] });
  p.production = recordExports(p, edit, [output], "2026-10-31T00:00:00.000Z", randomUUID);
  assert.equal(recordExports(p, edit, [output], "2026-10-31T01:00:00.000Z", randomUUID).exports.length, 1);
  assert.throws(() => validateDashboard(board([{ ...p, resources: [] }])), /INVALID_PROJECT_EXPORT/);
  assert.throws(() => validateDashboard(board([{ ...p, production: { ...p.production!, edits: [] } }])), /INVALID_PROJECT_EXPORT/);
});

test("explicit saved edit linkage rejects another owner and unknown IDs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reels-project-links-"));
  try {
    const edit = { kind: "video" as const, id: randomUUID() };
    const store = new LocalStore(root); await store.initialize(); await store.save(board([project("a"), project("b")]));
    const lib = new ContentLibrary(store, () => {}, async () => [{ ...edit, title: "saved video" }]);
    const linked = await lib.linkEdit({ projectId: "a", edit, expectedUpdatedAt: (await store.load()).updatedAt });
    assert.equal(editOwner(linked, edit)?.id, "a");
    await assert.rejects(lib.linkEdit({ projectId: "b", edit, expectedUpdatedAt: linked.updatedAt }), /EDIT_ALREADY_LINKED/);
    await assert.rejects(lib.linkEdit({ projectId: "a", edit: { ...edit, id: randomUUID() }, expectedUpdatedAt: linked.updatedAt }), /EDIT_NOT_FOUND/);
    assert.equal((await lib.listEdits())[0].ownerId, "a");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("merge rejects self, missing sources, publication conflicts without changing storage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reels-project-conflicts-"));
  try {
    const store = new LocalStore(root); await store.initialize();
    await store.save(board([project("a"), project("b", { publicURL: "https://example.com/published" })]));
    const lib = new ContentLibrary(store);
    const before = await store.load();
    for (const ids of [["a"], ["missing"], ["b"]])
      await assert.rejects(lib.merge({ targetId: "a", sourceIds: ids, expectedUpdatedAt: before.updatedAt }));
    assert.deepEqual(await store.load(), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

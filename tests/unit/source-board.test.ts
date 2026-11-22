import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContentLibrary } from "../../src/features/content-library";
import { LocalStore } from "../../src/shared/lib/storage";
import { toSnapshot } from "../../src/shared/data";
import { sourceBoardSchema, type SourceBoard } from "../../src/shared/source-board";
import { mergeProjects } from "../../src/shared/production-project";
import { mobileMonitor } from "../../src/shared/mobile-monitor";
import { emptyPlanning } from "../../src/shared/planning";
import { defaultAutopilotConfig, emptyAutopilotState } from "../../src/shared/autopilot";
import type { Project, Dashboard } from "../../src/shared/contracts";

const at = "2026-01-01T00:00:00.000Z";
const ref = { account: "@example", url: "https://www.instagram.com/reel/test_1/", metric: "조회 100", hook: "여기서 시작", ourVersion: "첫 장면부터" };
const unit = { id: "U01", rank: 1, title: "해변 산책", status: "draft" as const,
  footage: { summary: "바닷가 풍경", score: 4.1, scenes: [{ id: "D2-01", day: 2, time: "09:30", title: "산책" }] }, refs: [ref] };
const board: SourceBoard = { title: "여행 소스 보드", basis: "촬영분과 레퍼런스", updatedAt: at, units: [unit] };
const project: Project = { id: "content-test", title: "촬영 카드", date: "2026-01-01", stage: "idea", shared: true, publicURL: "", nextAction: "검토" };

test("strict bounded mobile contract accepts reel/post links and rejects malformed or private input", () => {
  assert.deepEqual(sourceBoardSchema.parse(board), board);
  assert.ok(sourceBoardSchema.safeParse({ ...board, units: [{ ...unit, status: "published", statusUrl: "https://instagram.com/p/Example/" }] }).success);
  for (const url of ["https://example.com/p/a/", "https://instagram.com.evil.test/reel/x/", "https://instagram.com@evil.test/p/x", "https://instagram.com/p/x/?token=secret", "https://instagram.com/reels/x/", "javascript:alert(1)"]) {
    assert.throws(() => sourceBoardSchema.parse({ ...board, units: [{ ...unit, refs: [{ ...ref, url }] }] }));
  }
  for (const text of ["/Users/example/clip", "~/folder/media", "원본 IMG_0001.MOV", "Bearer abcdefghijklmnop", "api_key=abcd"]) {
    assert.throws(() => sourceBoardSchema.parse({ ...board, units: [{ ...unit, refs: [{ ...ref, ourVersion: text }] }] }));
  }
  for (const units of [
    [unit, unit], [{ ...unit, rank: 2 }, { ...unit, id: "U02", rank: 1 }],
    [{ ...unit, footage: { ...unit.footage, score: 4.15 } }], [{ ...unit, footage: { ...unit.footage, score: 6 } }],
    [{ ...unit, statusUrl: ref.url }], [{ ...unit, refs: Array(4).fill(ref) }], [{ ...unit, refs: [{ ...ref, localPath: "x" }] }],
    Array.from({ length: 41 }, (_, i) => ({ ...unit, rank: i + 1, id: "U" + i })),
  ]) assert.throws(() => sourceBoardSchema.parse({ ...board, units }));
});

test("board writes use the dashboard revision, survive unrelated upserts and can be cleared", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "source-board-"));
  try {
    const store = new LocalStore(root);
    await store.initialize();
    const lib = new ContentLibrary(store);
    const content = { id: project.id, title: project.title, date: project.date, dateBasis: "capture" as const, stage: project.stage, nextAction: "검토", publicURL: "", localNotes: "", resources: [] };
    const original = await lib.upsert(content, (await store.load()).updatedAt);
    const saved = await lib.setSourceBoard({ projectId: project.id, expectedUpdatedAt: original.updatedAt, board });
    await assert.rejects(lib.setSourceBoard({ projectId: project.id, expectedUpdatedAt: original.updatedAt, board: null }));
    const updated = await lib.upsert({ ...content, title: "새 이름" }, saved.updatedAt);
    assert.deepEqual(updated.project.sourceBoard, board);
    await lib.setSourceBoard({ projectId: project.id, expectedUpdatedAt: updated.updatedAt, board: null });
    assert.equal((await lib.get(project.id)).project.sourceBoard, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a board follows a merged card, is mirrored once, and stays out of public snapshots", () => {
  const source = { ...project, id: "source", sourceBoard: board };
  const data: Dashboard = { schemaVersion: 1, updatedAt: at, projects: [project, source] };
  const merged = mergeProjects(data, project.id, [source.id]);
  assert.deepEqual(merged.projects.find(p => p.id === project.id)?.sourceBoard, board);
  const monitor = (d: Dashboard) => mobileMonitor(d, emptyPlanning(), emptyAutopilotState(), defaultAutopilotConfig(), new Date(at), { isAlive: () => false }).monitor;
  assert.deepEqual(monitor(merged).sourceBoards, [{ projectId: project.id, board }]);
  assert.equal(monitor({ ...data, projects: [project] }).sourceBoards, undefined);
  assert.equal(JSON.stringify(toSnapshot(data)).includes("sourceBoard"), false);
  assert.throws(() => mergeProjects({ ...data, projects: [{ ...project, sourceBoard: board }, source] }, project.id, [source.id]), /SOURCE_BOARD_MERGE_CONFLICT/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Dashboard, Project } from "../../src/shared/contracts";
import { LocalStore } from "../../src/shared/lib/storage";
import { ContentLibrary, scanOrphanEdits } from "../../src/features/content-library";

const clip = "/clips";
const project = (id: string, extra: Partial<Project> = {}): Project => ({
  id, title: id, date: "2026-10-31", stage: "editing", nextAction: "", publicURL: "", shared: false, ...extra,
});
const orphan = (id: string, file: string, extra: Partial<Project> = {}) =>
  project(id, {
    title: path.basename(file),
    resources: [{ role: "footage", path: file, label: path.basename(file) }],
    production: { schemaVersion: 1, edits: [{ kind: "video", id }], mergedIds: [], exports: [] },
    ...extra,
  });
const owner = (id: string, folder: string, extra: Partial<Project> = {}) =>
  project(id, { stage: "published", resources: [{ role: "folder", path: folder, label: "원본" }], ...extra });
const board = (projects: Project[]): Dashboard => ({ schemaVersion: 1, projects, updatedAt: "2026-10-31T00:00:00.000Z" });
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const suggestions = (d: Dashboard, docs: Map<string, string>, root: string | null = clip) =>
  scanOrphanEdits(d, root ?? undefined, docs).map((c) => [c.id, c.suggestedTargetId ?? null]);

test("suggests the one project owning the shoot folder and naming the footage, NFD paths included", () => {
  const nfd = "/clips/2026-10-25_공원-산책/클립.mov".normalize("NFD");
  const d = board([
    owner("content:park", "/clips/2026-10-25_공원-산책/originals"),
    orphan(A, nfd, { title: "클립.mov".normalize("NFD") }),
    orphan(B, "/clips/2026-10-25_공원-산책/originals/IMG_1.mov"),
  ]);
  assert.deepEqual(suggestions(d, new Map([["content:park", "촬영본 클립.mov, IMG_1.mov".normalize("NFD")]])), [[A, "content:park"], [B, "content:park"]]);
  const [card] = scanOrphanEdits(d, clip, new Map());
  assert.deepEqual(card.candidates, [{ id: "content:park", title: "content:park", stage: "published", folderMatch: true, documentMention: false }]);
});

test("a reused shoot folder alone is not a suggestion (new reel from an older shoot)", () => {
  const d = board([owner("content:old", "/clips/2026-10-11_park/originals"), orphan(A, "/clips/2026-10-11_park/originals/IMG_2.MOV")]);
  assert.deepEqual(suggestions(d, new Map([["content:old", "IMG_7000.MOV only"]])), [[A, null]]);
});

test("ambiguous, renamed, published and outside-root cards get no suggestion or are not listed", () => {
  const file = "/clips/2026-10-25_x/a.mov";
  const docs = new Map([["t1", "a.mov"], ["t2", "a.mov"]]);
  assert.deepEqual(suggestions(board([owner("t1", "/clips/2026-10-25_x"), owner("t2", "/clips/2026-10-25_x/originals"), orphan(A, file)]), docs), [[A, null]]);
  assert.deepEqual(suggestions(board([owner("t1", "/clips/2026-10-26_y"), orphan(A, file)]), docs), [[A, null]]);
  assert.deepEqual(suggestions(board([owner("t1", "/clips/2026-10-25_x"), orphan(A, file, { title: "직접 붙인 제목" })]), docs), []);
  assert.deepEqual(suggestions(board([owner("t1", "/clips/2026-10-25_x"), orphan(A, file, { stage: "published" })]), docs), []);
  // Without a clip root only footage inside a linked folder matches.
  assert.deepEqual(suggestions(board([owner("t1", "/clips/2026-10-25_x/originals"), orphan(A, file)]), docs, null), [[A, null]]);
  assert.deepEqual(suggestions(board([owner("t1", "/clips/2026-10-25_x"), orphan(A, file)]), docs, null), [[A, "t1"]]);
});

test("ContentLibrary.scanOrphanEdits reads linked documents and changes nothing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reels-orphans-"));
  try {
    const store = new LocalStore(root); await store.initialize();
    const doc = path.join(root, "post.md");
    await writeFile(doc, "촬영본: a.mov");
    await store.save(board([owner("content:park", "/clips/s/originals", { resources: [{ role: "folder", path: "/clips/s/originals", label: "원본" }, { role: "document", path: doc, label: "문안" }] }), orphan(A, "/clips/s/a.mov")]));
    const before = await store.load();
    const lib = new ContentLibrary(store, () => {}, async () => [], clip);
    const result = await lib.scanOrphanEdits();
    assert.equal(result.updatedAt, before.updatedAt);
    assert.equal(result.cards[0].suggestedTargetId, "content:park");
    assert.deepEqual(await store.load(), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalStore } from "../../src/shared/lib/storage";
import { AnalysisSelection } from "../../src/desktop/analysis-selection";
import type { AnalysisView } from "../../src/shared/media-analysis";
test("selection retains all candidates, groups copies, protects human representatives and usage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "selection-"));
  try {
    const image = path.join(root, "synthetic.jpg"); await writeFile(image, "synthetic pixels");
    const matches = ["b", "a"].map(id => ({ sample: { id, imagePath: image, sourcePath: image }, effective: { description: id, uncertainties: [] } }));
    const service = new AnalysisSelection(new LocalStore(root), { search: async () => ({ revision: 7, matches }) as unknown as AnalysisView });
    let d = await service.execute({ projectId: "p", expectedRevision: 0 });
    assert.equal(d.candidates.length, 2); assert.equal(d.groups.length, 1); assert.equal(d.groups[0].representative, "a");
    await assert.rejects(service.execute({ projectId: "p", expectedRevision: 0 }), /STALE/);
    d = await service.update({ projectId: "p", expectedRevision: d.revision, representative: { groupId: d.groups[0].id, sampleId: "b", reason: "better framing" } });
    d = await service.execute({ projectId: "p", expectedRevision: d.revision });
    assert.equal(d.groups[0].representative, "b"); assert.equal(d.groups[0].human, true);
    await writeFile(image, "new anchor digest");
    d = await service.execute({ projectId: "p", expectedRevision: d.revision });
    assert.equal(d.groups[0].representative, "b"); assert.equal(d.groups[0].human, true);
    await assert.rejects(service.update({ projectId: "p", expectedRevision: d.revision, representative: { groupId: d.groups[0].id, sampleId: "missing", reason: "bad" } }), /GROUP_MEMBER/);
    d = await service.update({ projectId: "p", expectedRevision: d.revision, usage: { sampleId: "b", contentId: "p", editId: "edit", used: true } });
    assert.equal(d.usage.length, 1);
    d = await service.update({ projectId: "p", expectedRevision: d.revision, candidate: { sampleId: "b", usable: false, reason: "out of focus" } });
    assert.deepEqual(d.groups[0].sampleIds, ["a"]); assert.equal(d.groups[0].representative, "a");
    assert.equal((await service.search({ projectId: "other" })).usage.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("linked edit usage follows synthetic source bytes and is reconciled", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "selection-usage-"));
  const editId = "11111111-1111-4111-8111-111111111111";
  try {
    const source = path.join(root, "source.jpg"); const copy = path.join(root, "copy.jpg");
    await writeFile(source, "same synthetic bytes"); await writeFile(copy, "same synthetic bytes");
    const store = new LocalStore(root); await store.initialize();
    await store.update(d => ({ ...d, projects: [{ id: "p", title: "synthetic", date: "2026-11-14", stage: "captured", nextAction: "", publicURL: "", shared: false, production: { schemaVersion: 1, edits: [{ kind: "video", id: editId }], mergedIds: [], exports: [] } }] }));
    await mkdir(path.join(root, "editor", editId), { recursive: true });
    await writeFile(path.join(root, "editor", editId, "project.json"), JSON.stringify({ project: { id: editId }, sourcePath: copy }));
    const service = new AnalysisSelection(store, { search: async () => ({ revision: 1, matches: [{ sample: { id: "s", sourcePath: source, imagePath: source }, effective: { description: "synthetic", uncertainties: [], usability: { usable: true, reason: "clear" } } }] }) as unknown as AnalysisView });
    let d = await service.execute({ projectId: "p", expectedRevision: 0 });
    assert.equal(d.usage[0].editId, editId);
    await writeFile(copy, "changed bytes");
    d = await service.execute({ projectId: "p", expectedRevision: d.revision }); assert.equal(d.usage.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("real ffmpeg perceptual selection groups matching synthetic images", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "selection-hash-"));
  try {
    const image = path.join(root, "synthetic.ppm");
    const pixels = Buffer.from(Array.from({ length: 9 * 8 * 3 }, (_, i) => Math.floor(i / 3) % 9 * 28));
    await writeFile(image, Buffer.concat([Buffer.from("P6\n9 8\n255\n"), pixels]));
    const matches = ["a", "b"].map(id => ({ sample: { id, imagePath: image, sourcePath: image }, effective: { description: id, uncertainties: [] } }));
    const service = new AnalysisSelection(new LocalStore(root), { search: async () => ({ revision: 1, matches }) as unknown as AnalysisView }, path.resolve("native/editor-engine/.build/runtime/bin/ffmpeg"));
    let d = await service.execute({ projectId: "p", expectedRevision: 0 }); assert.equal(d.groups.length, 1);
    d = await service.update({ projectId: "p", expectedRevision: d.revision, representative: { groupId: d.groups[0].id, sampleId: "b", reason: "human" } });
    // Replace anchor ID with another member while keeping the human representative.
    matches[0].sample.id = "c";
    d = await service.execute({ projectId: "p", expectedRevision: d.revision }); assert.equal(d.groups[0].representative, "b");
  } finally { await rm(root, { recursive: true, force: true }); }
});

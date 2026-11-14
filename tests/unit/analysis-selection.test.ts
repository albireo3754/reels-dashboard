import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalStore } from "../../src/shared/lib/storage";
import { AnalysisSelection } from "../../src/desktop/analysis-selection";
import type { AnalysisView } from "../../src/shared/media-analysis";
test("selection retains all candidates, groups copies, protects human representatives and usage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "selection-"));
  try {
    const image = path.join(root, "synthetic.jpg"); await writeFile(image, "synthetic pixels");
    const matches = ["b", "a"].map(id => ({ sample: { id, imagePath: image }, effective: { description: id, uncertainties: [] } }));
    const service = new AnalysisSelection(new LocalStore(root), { search: async () => ({ revision: 7, matches }) as unknown as AnalysisView });
    let d = await service.execute({ projectId: "p", expectedRevision: 0 });
    assert.equal(d.candidates.length, 2); assert.equal(d.groups.length, 1); assert.equal(d.groups[0].representative, "a");
    await assert.rejects(service.execute({ projectId: "p", expectedRevision: 0 }), /STALE/);
    d = await service.update({ projectId: "p", expectedRevision: d.revision, representative: { groupId: d.groups[0].id, sampleId: "b", reason: "better framing" } });
    d = await service.execute({ projectId: "p", expectedRevision: d.revision });
    assert.equal(d.groups[0].representative, "b"); assert.equal(d.groups[0].human, true);
    await assert.rejects(service.update({ projectId: "p", expectedRevision: d.revision, representative: { groupId: d.groups[0].id, sampleId: "missing", reason: "bad" } }), /GROUP_MEMBER/);
    d = await service.update({ projectId: "p", expectedRevision: d.revision, usage: { sampleId: "b", contentId: "p", editId: "edit", used: true } });
    assert.equal(d.usage.length, 1);
    assert.equal((await service.search({ projectId: "other" })).usage.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, realpath, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalStore } from "../../src/shared/lib/storage";
import { ContentLibrary, prepareLocalMedia } from "../../src/features/content-library";

test("local media preparation verifies registered copies and rejects missing grants and overwrites", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "prepare-media-")));
  try {
    const source = path.join(root, "영상.mov"); await writeFile(source, "original source");
    const store = new LocalStore(path.join(root, "data")); await store.initialize();
    const library = new ContentLibrary(store);
    await library.upsert({ id: "sample", title: "Sample", date: "2026-11-02", dateBasis: "capture", localNotes: "", stage: "captured", nextAction: "", publicURL: "", resources: [{role: "footage", path: source, label: "source"}] }, (await store.load()).updatedAt);
    // Output must be outside the source directory; use a sibling temporary directory.
    const outputParent = await realpath(await mkdtemp(path.join(tmpdir(), "prepare-output-")));
    try {
      const destination = path.join(outputParent, "selection");
      const input = { projectId: "sample", sources: [source], destination };
      const result = await prepareLocalMedia(library, input);
      assert.equal(await readFile(result.entries[0].path, "utf8"), "original source");
      assert.equal(await readFile(source, "utf8"), "original source");
      assert.match(result.entries[0].sha256, /^[a-f0-9]{64}$/);
      assert.equal(JSON.parse(await readFile(result.receiptPath, "utf8")).entries.length, 1);
      await assert.rejects(prepareLocalMedia(library, input), /already exists/);
      const badDestination = path.join(outputParent, "unregistered");
      const other = path.join(root, "other.mov"); await writeFile(other, "not registered");
      await assert.rejects(prepareLocalMedia(library, { ...input, sources: [source, other], destination: badDestination }), /등록한 자료/);
      await assert.rejects(access(badDestination));
      await assert.rejects(prepareLocalMedia(library, { ...input, destination: path.join(root, "inside-source") }), /outside/);
      await assert.rejects(prepareLocalMedia(library, { ...input, sources: [source, source] }), /distinct/);
    } finally { await rm(outputParent, {recursive: true, force: true}); }
  } finally { await rm(root, {recursive: true, force: true}); }
});

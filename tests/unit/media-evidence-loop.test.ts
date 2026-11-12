import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assembleEvidence, connectEvidence, mergeEvidence, runEvidenceChecks, runEvidenceLoop, type EvidenceDocument } from "../../src/desktop/media-evidence-loop";
import type { ImageAnalyzer } from "../../src/desktop/analysis-provider";
import { readBlogProjects } from "../../src/desktop/blog-projects";
import { markupFixture } from "../fixtures/markup-editor";
import { writeBlogCards } from "../fixtures/blog-cards";

const context = { venue: "Known", location: "", visit: "", menus: "", surroundings: "", notes: "", sources: [] };
async function fixture(t: import("node:test").TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "evidence-loop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = path.join(root, "a.jpg"), copy = path.join(root, "copy-of-a.JPG"), b = path.join(root, "b.jpg");
  await writeFile(a, "frame a");await writeFile(copy, "frame a");await writeFile(b, "frame b");
  const spec = {
    version: 1, projectId: "p", title: "T", context, request: "Inspect", archiveDir: path.join(root, "archive"),
    captures: [{ id: "A", sourcePath: a }, { id: "B", sourcePath: b }],
    images: [
      { captureId: "A", path: a, time: 0, kind: "video-frame" },
      { captureId: "A", path: copy, time: 0, kind: "video-frame" },
      { captureId: "B", path: b, time: null, kind: "photo" },
    ],
  };
  return { root, a, b, spec, out: path.join(root, "out") };
}
function analyzer(calls: string[][], describe = (context: string) => context.includes("fixed") ? "fixed" : "Known", fail = false): ImageAnalyzer {
  return { id: "fake", label: "fake", async analyze(samples, context) {
    calls.push(samples.map((s) => s.id));
    if (fail) throw new Error("provider down");
    return samples.map(() => ({ description: "seen at " + describe(context), tags: ["tag"], ocr: [], uncertainties: [] }));
  } };
}

test("assemble consolidates exact bytes only, retains copies, and keeps every input path", async (t) => {
  const f = await fixture(t);
  const { manifest, audit } = await assembleEvidence(f.spec, f.out);
  assert.equal(audit.registeredImageEntries, 3);
  assert.equal(audit.uniqueInputs, 2);
  assert.equal(audit.aliases.filter((alias) => alias.resultId === manifest.images[0].id).length, 2);
  assert.ok(manifest.images.every((image) => image.path.startsWith(f.spec.archiveDir)));
  await rm(f.a);
  assert.equal(await readFile(manifest.images[0].path, "utf8"), "frame a", "retained copy outlives the temporary input");
});
test("an image-file capture without listed images becomes a photo; unsupported types are refused", async (t) => {
  const f = await fixture(t);
  const { manifest } = await assembleEvidence({ ...f.spec, images: [] }, f.out);
  assert.deepEqual(manifest.images.map((image) => [image.captureId, image.kind, image.time]), [["A", "photo", null], ["B", "photo", null]]);
  await assert.rejects(assembleEvidence({ ...f.spec, images: [{ captureId: "A", path: "/x/clip.mov", time: 0, kind: "video-frame" }] }, f.out), /Unsupported image type/);
});
test("the loop runs to a verified effective result and a rerun reuses every batch", async (t) => {
  const f = await fixture(t), calls: string[][] = [];
  const spec = { ...f.spec, checks: [{ name: "venue noted", includes: ["known"] }, { name: "no wrong venue", excludes: ["other"] }] };
  const first = await runEvidenceLoop(spec, f.out, analyzer(calls));
  assert.equal(first.stage, "verified");assert.equal(first.pass, true);
  assert.equal(calls.length, 1);
  await runEvidenceLoop(spec, f.out, analyzer(calls));
  assert.equal(calls.length, 1, "no provider call on a rerun");
  assert.ok((await readFile(path.join(f.out, "effective/metadata-table.md"), "utf8")).includes("seen at Known"));
});
test("a correction re-analyzes only its images under the new context, preserving the base run", async (t) => {
  const f = await fixture(t), calls: string[][] = [];
  await runEvidenceLoop(f.spec, f.out, analyzer(calls));
  const baseBefore = await readFile(path.join(f.out, "base/results.json"), "utf8");
  const failing = { ...f.spec, checks: [{ name: "B is corrected", captureIds: ["B"], includes: ["fixed"] }] };
  const blocked = await runEvidenceLoop(failing, f.out, analyzer(calls));
  assert.equal(blocked.pass, false);
  assert.deepEqual("failedChecks" in blocked && blocked.failedChecks, ["B is corrected"]);
  const spec = { ...failing, corrections: [{ id: "fix-b", reason: "Writer corrected the venue", context: { ...context, venue: "fixed" }, captureIds: ["B"] }] };
  const fixed = await runEvidenceLoop(spec, f.out, analyzer(calls));
  assert.equal(fixed.pass, true);
  assert.equal(calls.length, 2);assert.equal(calls[1].length, 1);
  assert.equal(await readFile(path.join(f.out, "base/results.json"), "utf8"), baseBefore);
  const effective: EvidenceDocument = JSON.parse(await readFile(path.join(f.out, "effective/results.json"), "utf8"));
  assert.deepEqual(effective.images.map((row) => [row.captureId, row.analysisRun, row.fields?.description]), [["A", "base", "seen at Known"], ["B", "fix-b", "seen at fixed"]]);
});
test("provider failure stops before effective output; a rerun retries only what failed", async (t) => {
  const f = await fixture(t), calls: string[][] = [];
  const failed = await runEvidenceLoop(f.spec, f.out, analyzer(calls, undefined, true));
  assert.equal(failed.stage, "base");assert.equal(failed.pass, false);
  assert.equal((await readdir(f.out)).includes("effective"), false);
  assert.equal((await runEvidenceLoop(f.spec, f.out, analyzer(calls))).pass, true);
});
test("a retained image changed after analysis fails verification", async (t) => {
  const f = await fixture(t);
  await runEvidenceLoop(f.spec, f.out, analyzer([]));
  const effective: EvidenceDocument = JSON.parse(await readFile(path.join(f.out, "effective/results.json"), "utf8"));
  const { verifyEvidence } = await import("../../src/desktop/media-evidence-loop");
  const manifest = JSON.parse(await readFile(path.join(f.out, "input-manifest.json"), "utf8"));
  const table = await readFile(path.join(f.out, "effective/metadata-table.md"), "utf8");
  assert.equal((await verifyEvidence(manifest, effective, table, [])).pass, true);
  await writeFile(effective.images[0].path, "tampered");
  assert.deepEqual((await verifyEvidence(manifest, effective, table, [])).brokenImages, [effective.images[0].id]);
  assert.equal((await verifyEvidence(manifest, effective, table.split("\n").filter((l) => !l.includes(effective.images[1].id + " |")).join("\n"), [])).idsMatch, false);
});
test("a correction naming an unknown capture is refused", async (t) => {
  const f = await fixture(t);
  await assert.rejects(runEvidenceLoop({ ...f.spec, corrections: [{ id: "x", reason: "r", captureIds: ["A", "NOPE"] }] }, f.out, analyzer([])), /unknown IDs: NOPE/);
});
test("merge refuses a correction that changes identity or stays unresolved", () => {
  const row = { id: "i", captureId: "c", path: "/p", sourcePath: "/s", kind: "photo", time: null, status: "resolved", sha256: "a" };
  const doc = (images: EvidenceDocument["images"]): EvidenceDocument => ({ version: 1, fingerprint: "f", provider: "x", projectId: "p", context: {}, request: "r", images });
  const merge = (changed: object) => () => mergeEvidence(doc([row]), [{ id: "c1", reason: "r", document: doc([{ ...row, ...changed }]) }]);
  assert.throws(merge({ sha256: "b" }), /changed the source/);
  assert.throws(merge({ id: "other" }), /unknown image/);
  assert.throws(merge({ status: "failed" }), /did not resolve/);
});
test("checks need an in-scope match, and an empty scope never passes", () => {
  const doc = { images: [{ id: "1", captureId: "C", status: "resolved", fields: { description: "일반 짜장", tags: [], ocr: [], uncertainties: [] } }] } as unknown as EvidenceDocument;
  const pass = (item: object) => runEvidenceChecks(doc, [{ name: "n", ...item }])[0].pass;
  assert.equal(pass({ includes: ["짜장".normalize("NFD")] }), true);
  assert.equal(pass({ excludes: ["간짜장"] }), true);
  assert.equal(pass({ excludes: ["일반"] }), false);
  assert.equal(pass({ captureIds: ["MISSING"], excludes: ["간짜장"] }), false);
});
test("connect links only a verified result through the project's pointer file", async (t) => {
  const f = await fixture(t);
  const data = path.join(f.root, "data");await mkdir(data);
  await mkdir(path.join(f.root, "article"));
  const config = await markupFixture(path.join(f.root, "article"));
  await writeBlogCards(data, [{ id: "p", title: "P", config }]);
  await mkdir(path.join(f.out, "effective"), { recursive: true });
  await writeFile(path.join(f.out, "effective/verification.json"), '{"pass":false}');
  await assert.rejects(connectEvidence(f.out, data, "p"), /did not pass/);
  await writeFile(path.join(f.out, "effective/verification.json"), '{"pass":true}');
  const connected = await connectEvidence(f.out, data, "p");
  assert.equal(connected.changed, true);
  assert.equal(connected.mediaEvidence, path.join(path.resolve(f.out), "effective/results.json"));
  assert.equal((await readBlogProjects(data))[0].config.mediaEvidence, connected.mediaEvidence);
  assert.equal((await connectEvidence(f.out, data, "p")).changed, false);
  assert.deepEqual(await readdir(config.layers), ["media-evidence.json"]);
  await assert.rejects(connectEvidence(f.out, data, "nope"), /Unknown blog project/);
  // A manuscript that names its own evidence is changed there, not behind its back.
  await writeBlogCards(data, [{ id: "p", title: "P", config: { ...config, mediaEvidence: path.join(f.root, "other.json") } }]);
  await assert.rejects(connectEvidence(f.out, data, "p"), /editor\.mediaEvidence/);
});
test("frames are extracted with times, once, into the archive", async (t) => {
  const f = await fixture(t);
  const video = path.join(f.root, "clip.mp4");
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=10:duration=3", video]);
  const spec = { ...f.spec, captures: [{ id: "V", sourcePath: video, frames: { fps: 1, maxFrames: 2 } }], images: [] };
  const first = await assembleEvidence(spec, f.out);
  assert.deepEqual(first.manifest.images.map((image) => [image.kind, image.time]), [["video-frame", 0], ["video-frame", 1]]);
  const second = await assembleEvidence(spec, f.out);
  assert.deepEqual(second.manifest.images.map((image) => image.id), first.manifest.images.map((image) => image.id));
});
test("a HEIC capture is analyzed through a labelled JPEG derivative, and notes reach every row", async (t) => {
  const f = await fixture(t);
  const heic = path.join(f.root, "photo.heic"), png = path.join(f.root, "seed.png");
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=128x128:duration=1", "-frames:v", "1", png]);
  execFileSync("sips", ["-s", "format", "heic", png, "--out", heic], { stdio: "ignore" });
  const before = await readFile(heic);
  const { manifest } = await assembleEvidence({ ...f.spec, images: [], captures: [{ id: "H", sourcePath: heic, note: "17:48 KST" }, { id: "B", sourcePath: f.b, note: "16:00 KST" }] }, f.out);
  assert.match(manifest.images[0].sourceLabel!, /JPEG derivative of the HEIC original; 17:48 KST/);
  assert.match(manifest.images[1].sourceLabel!, /16:00 KST/);
  assert.ok(manifest.images[0].path.endsWith(".jpg"));
  assert.deepEqual(await readFile(heic), before, "original stays untouched");
});

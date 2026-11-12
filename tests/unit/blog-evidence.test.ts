import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { markupFixture } from "../fixtures/markup-editor";
import { EvidenceStore } from "../../src/app/blog-editor/evidence-store";
import { MarkupStore } from "../../src/app/blog-editor/markup-store";
import { defaultAlt, insertPhotos, searchEvidence, type EvidenceImage } from "../../src/shared/blog-evidence";
import { parse, serialize } from "../../src/shared/blog-markup";
import { readBlogProjects } from "../../src/desktop/blog-projects";
import { writeBlogCards } from "../fixtures/blog-cards";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
async function fixture(t: import("node:test").TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await markupFixture(root);
  const bytes = Buffer.from("synthetic-frame"), image = path.join(root, "archived.JPG");
  await writeFile(image, bytes);
  const placed = await readFile(path.join(config.media, "photo.png"));
  const placedSource = path.join(root, "placed.png");
  await writeFile(placedSource, placed);
  const fields = { description: "A red noodle bowl. Steam rises.", tags: ["noodles"], ocr: ["SINCE 1978"], contextNotes: ["Ordered by the writer"], uncertainties: ["Sauce is unclear"], faceRegions: [{ x: 0, y: 0, width: 1, height: 1 }] };
  const results = path.join(root, "results.json");
  await writeFile(results, JSON.stringify({ images: [
    { id: "im-1", captureId: "CLIP.MOV", path: image, kind: "video-frame", time: "1.5", sha256: sha(bytes), status: "resolved", fields },
    { id: "im-2", captureId: "CLIP.MOV", path: placedSource, kind: "photo", time: null, sha256: sha(placed), status: "resolved", fields: { ...fields, faceRegions: [] } },
    { id: "im-3", captureId: "CLIP.MOV", path: image, kind: "video-frame", time: "2", status: "failed" },
  ] }));
  return { root, config: { ...config, mediaEvidence: results }, image, bytes, results };
}
const photoIn = (text: string) => parse(text).bundles.flatMap(b => b.nodes).filter(n => n.kind === "component" && n.tag === "Photo");

test("library lists resolved rows only and detects placed bytes under another name", async t => {
  const { config } = await fixture(t);
  const store = new MarkupStore(config);await store.load();
  const library = await store.evidenceLibrary();
  assert.deepEqual(library.items.map(i => i.id), ["im-1", "im-2"]);
  assert.equal(library.unresolved, 1);
  assert.deepEqual(library.usedIds, ["im-2"]);
  assert.equal(library.items[0].faceCount, 1);
  assert.equal(JSON.stringify(library).includes(config.layers), false, "absolute paths stay on the server");
});
test("an unconnected project reports that instead of failing", async t => {
  const { config } = await fixture(t);
  const { mediaEvidence: _, ...plain } = config;
  assert.deepEqual(await new MarkupStore(plain).evidenceLibrary(), { connected: false, items: [], usedIds: [], unresolved: 0 });
});
test("saving copies verified bytes and writes a traceable Photo at the chosen gap", async t => {
  const { config, bytes } = await fixture(t);
  const store = new MarkupStore(config), doc = await store.load();
  const result = await store.save({ revision: doc.revision, edits: [], photos: [{ id: "p1", imageId: "im-1", bundleId: "B1", before: 1, alt: 'A "red" <bowl>' }] });
  assert.deepEqual(await readFile(path.join(config.media, "im-1.jpg")), bytes);
  const text = await readFile(config.canon, "utf8"), nodes = parse(text).bundles[0].nodes;
  const node = nodes[1] as { attrs: Record<string, unknown> };
  assert.deepEqual(node.attrs, { file: "im-1.jpg", alt: 'A "red" <bowl>' });
  assert.equal(serialize(parse(text)), text);
  assert.ok((await store.asset("photo", "im-1.jpg")).endsWith("im-1.jpg"));
  assert.ok((await readFile(config.layout, "utf8")).includes("im-1.jpg"));
  assert.ok(result.document.revision !== doc.revision);
  // Re-placing the same image reuses the identical copy.
  await store.save({ revision: result.document.revision, edits: [], photos: [{ id: "p2", imageId: "im-1", bundleId: "B1", before: 0, alt: "again" }] });
  assert.equal(photoIn(await readFile(config.canon, "utf8")).length, 3);
});
test("an unknown image or changed file is reported and leaves manuscript and media untouched", async t => {
  const { config, image } = await fixture(t);
  const store = new MarkupStore(config), doc = await store.load(), before = await readFile(config.canon, "utf8");
  const attempt = (imageId: string, at: number) => store.save({ revision: doc.revision, edits: [], photos: [{ id: "p1", imageId, bundleId: "B1", before: at, alt: "x" }] });
  const reason = async (imageId: string) => (await attempt(imageId, 0)).skipped[0]?.reason;
  assert.match(await reason("im-404"), /분석 결과에 없는/);
  assert.match(await reason("im-3"), /분석 결과에 없는/);
  await writeFile(image, "changed");
  assert.match(await reason("im-1"), /파일이 바뀌었어요/);
  assert.equal(await readFile(config.canon, "utf8"), before);
  assert.deepEqual(await readdir(config.media), ["photo.png"]);
});
test("a different file under the target name is never replaced", async t => {
  const { config } = await fixture(t);
  await writeFile(path.join(config.media, "im-1.jpg"), "someone else's");
  const store = new MarkupStore(config), doc = await store.load();
  const result = await store.save({ revision: doc.revision, edits: [], photos: [{ id: "p1", imageId: "im-1", bundleId: "B1", before: 0, alt: "x" }] });
  assert.match(result.skipped[0].reason, /다른 파일/);
  assert.equal(await readFile(path.join(config.media, "im-1.jpg"), "utf8"), "someone else's");
});
test("a project without evidence refuses placements", async t => {
  const { config } = await fixture(t);
  const { mediaEvidence: _, ...plain } = config;
  const store = new MarkupStore(plain), doc = await store.load();
  const result = await store.save({ revision: doc.revision, edits: [], photos: [{ id: "p1", imageId: "im-1", bundleId: "B1", before: 0, alt: "x" }] });
  assert.match(result.skipped[0].reason, /연결된 분석 결과가 없어요/);
});
test("a photo whose gap moved lands at the end of its bundle instead of failing", async t => {
  const { config } = await fixture(t);
  const store = new MarkupStore(config), doc = await store.load();
  const result = await store.save({ revision: doc.revision, edits: [], photos: [{ id: "p1", imageId: "im-1", bundleId: "B1", before: 999, alt: "x" }] });
  assert.deepEqual(result.skipped, []);
  assert.ok((await readFile(config.canon, "utf8")).includes("im-1.jpg"));
});
test("evidence store serves only listed rows and rereads a replaced results file", async t => {
  const { results, image } = await fixture(t);
  const store = new EvidenceStore(results);
  assert.equal(await store.imagePath("im-1"), image);
  await assert.rejects(store.imagePath("../etc/passwd"), /분석 결과에 없는/);
  await writeFile(results, JSON.stringify({ images: [] }));
  await assert.rejects(store.imagePath("im-1"), /분석 결과에 없는/);
});
test("insertPhotos keeps gap order: existing sticker, then photos in the order chosen", () => {
  const doc = parse('---\ntitle: "T"\nmarkup: 1\nmedia: ./m/\n---\n\n<Bundle id="B1" name="N" question="q">\n<Sticker id="s1" preset="yum"/>\n<Divider/>\n</Bundle>\n');
  const p = (id: string, before: number) => ({ id, imageId: id, file: id + ".jpg", bundleId: "B1", before, alt: "a" });
  insertPhotos(doc, [p("x", 0), p("y", 0), p("z", 1)]);
  assert.deepEqual(doc.bundles[0].nodes.map(n => n.kind === "component" ? String(n.attrs.file ?? n.tag) : ""), ["Sticker", "x.jpg", "y.jpg", "Divider", "z.jpg"]);
});
test("search needs every term across fields and matches decomposed Korean", () => {
  const row = (id: string, description: string, ocr: string[] = []): EvidenceImage => ({ id, captureId: "C", kind: "photo", time: null, description, tags: [], ocr, contextNotes: [], uncertainties: [], faceCount: 0 });
  const items = [row("a", "짜장면 전경", ["태백관"]), row("b", "볶음밥")];
  assert.deepEqual(searchEvidence(items, "짜장면 태백관").map(i => i.id), ["a"]);
  assert.deepEqual(searchEvidence(items, "짜장면".normalize("NFD")).map(i => i.id), ["a"]);
  assert.deepEqual(searchEvidence(items, "").length, 2);
  assert.deepEqual(searchEvidence(items, "", "other"), []);
});
test("default alt is the first sentence on one line", () => {
  assert.equal(defaultAlt("붉은 벽돌 외관. 큰 간판이 있다."), "붉은 벽돌 외관.");
  assert.equal(defaultAlt("마침표 없는\n설명"), "마침표 없는 설명");
  assert.equal(defaultAlt("가".repeat(500)).length, 200);
});
test("the layers folder's pointer is the evidence connection", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evidence-pointer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await markupFixture(root);
  await writeBlogCards(root, [{ id: "p", title: "P", config }]);
  assert.equal((await readBlogProjects(root))[0].config.mediaEvidence, undefined);
  await mkdir(config.layers, { recursive: true });
  await writeFile(path.join(config.layers, "media-evidence.json"), JSON.stringify({ version: 1, results: "run/effective/results.json" }));
  assert.equal((await readBlogProjects(root))[0].config.mediaEvidence, path.join(config.layers, "run/effective/results.json"));
});
test("thumbnails are small cached copies, and an unreadable image falls back to the original", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evidence-thumb-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const big = path.join(root, "big.jpg"), broken = path.join(root, "broken.jpg"), results = path.join(root, "results.json");
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=1600x1200:duration=1", "-frames:v", "1", big]);
  await writeFile(broken, "not an image");
  const row = (id: string, file: string) => ({ id, captureId: "C", path: file, kind: "photo", time: null, sha256: "a".repeat(64), status: "resolved", fields: { description: "d", tags: [], ocr: [], contextNotes: [], uncertainties: [], faceRegions: [] } });
  await writeFile(results, JSON.stringify({ images: [row("big", big), row("broken", broken)] }));
  const store = new EvidenceStore(results);
  const [first, second] = await Promise.all([store.thumbnailPath("big"), store.thumbnailPath("big")]);
  assert.equal(first, second);assert.notEqual(first, big);
  assert.ok((await stat(first)).size < (await stat(big)).size);
  const cached = (await stat(first)).mtimeMs;
  await store.thumbnailPath("big");
  assert.equal((await stat(first)).mtimeMs, cached);
  assert.equal(await store.thumbnailPath("broken"), broken);
  await assert.rejects(store.thumbnailPath("../x"), /분석 결과에 없는/);
});


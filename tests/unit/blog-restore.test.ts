import test from "node:test";
import assert from "node:assert/strict";
import {
  blogExtractInput,
  checkCapture,
  compareKinds,
  countKinds,
  fidelity,
  fontFaces,
  isAllowedImageUrl,
  mobileComponentClasses,
  parsePostUrl,
  sourceValues,
  summarizeBlock,
  toMarkdown,
  upsertBy,
  type TemplateBlock,
  type TemplateNode,
  type StructureBlock,
} from "../../src/shared/blog-restore";
import { parseReferences } from "../../src/shared/blog-references";
import { extractPost, loadImages, measureRestore, pageScript } from "../../src/desktop/blog-extract-page";

const slot = (id: string, sample: string, blank = false, text?: string): TemplateNode => ({ type: "text-slot", id, characters: sample.length, blank, sample, ...(text ? { text } : {}) });
const tree: TemplateNode = {
  type: "element", tag: "div", className: "se-component se-text", id: "n0", css: {},
  children: [
    slot("ws", "\n  ", true),
    { type: "element", tag: "p", className: "se-text-paragraph se-text-paragraph-align-center", id: "n1", css: {}, children: [
      { type: "element", tag: "span", className: "se-fs-fs19 se-ff-nanumbareunhipi", id: "n2", css: {}, children: [{ type: "element", tag: "b", className: "", id: "n3", css: {}, children: [slot("t0", "가가 가가!", false, "판교 야장!")] }] },
      { type: "element", tag: "span", className: "se-fs-", id: "n4", css: {}, children: [slot("t1", " 가가", false, " 후기")] },
    ] },
    { type: "image-slot", id: "i0", css: {}, naturalWidth: 966, naturalHeight: 725, loaded: true, src: "https://postfiles.pstatic.net/a/b.jpg?type=w966" },
  ],
};
const rect = { x: 0, y: 0, width: 600, height: 100 };
const tBlock: TemplateBlock = { id: "block-0", order: 0, sourceAnchor: "SE-1", sourceClass: "se-component se-text se-l-default", rect, tree };
const sBlock: StructureBlock = { order: 0, id: "SE-1", anchorId: "SE-1", className: tBlock.sourceClass, rect, css: {}, paragraphs: [{ id: "p", characters: 9, rect, css: {}, runs: [] }], images: [{ rect, naturalWidth: 966, naturalHeight: 725, loaded: true, css: {} }] };
const capture = { template: { blocks: [tBlock] }, structure: { blocks: [sBlock] } } as never;

test("post URL normalisation and extract input validation", () => {
  assert.equal(parsePostUrl("https://blog.naver.com/eehdune/224442171288").slug, "eehdune-224442171288");
  assert.equal(parsePostUrl("https://m.blog.naver.com/eehdune/224442171288").url, "https://blog.naver.com/eehdune/224442171288");
  assert.equal(parsePostUrl("https://blog.naver.com/PostView.naver?blogId=eehdune&logNo=224442171288").blogId, "eehdune");
  for (const bad of ["http://blog.naver.com/a/1234567", "https://blog.naver.com.evil.test/a/1234567", "https://u:p@blog.naver.com/a/1234567", "https://blog.naver.com/a"]) assert.throws(() => parsePostUrl(bad));
  assert.throws(() => blogExtractInput.parse({ url: "https://blog.naver.com/a/1234567", outputDirectory: "relative/dir" }));
  assert.throws(() => blogExtractInput.parse({ url: "https://blog.naver.com/a/1234567", extra: 1 }));
});

test("summary counts nested paragraph characters once; capture check passes", () => {
  const s = summarizeBlock(tBlock);
  assert.equal(s.paragraphCharacters, 9);
  assert.equal(s.textSlots, 2);
  assert.deepEqual(checkCapture(capture).errors, []);
});

test("capture check catches double counting, anchor drift, missing photo URLs and empty captures", () => {
  const dup = structuredClone(capture) as any;
  dup.structure.blocks[0].paragraphs[0].characters = 18;
  assert.match(checkCapture(dup).errors.join(), /글자수 불일치/);
  const drift = structuredClone(capture) as any;
  drift.template.blocks[0].sourceAnchor = "other";
  assert.match(checkCapture(drift).errors.join(), /anchor/);
  const noSrc = structuredClone(capture) as any;
  delete noSrc.template.blocks[0].tree.children[2].src;
  assert.match(checkCapture(noSrc).warnings.join(), /원본 URL 없는 사진/);
  assert.ok(checkCapture(null).errors.length);
});

test("source values render original text and only https pstatic photo URLs", () => {
  assert.deepEqual(sourceValues(tBlock), { t0: "판교 야장!", t1: " 후기", i0: "https://postfiles.pstatic.net/a/b.jpg?type=w966" });
  assert.deepEqual(sourceValues(tBlock, { text: false, images: false }), {});
  for (const bad of ["javascript:alert(1)", "http://postfiles.pstatic.net/a.jpg", "https://pstatic.net.evil.test/a.jpg", "data:image/png;base64,AA=="]) assert.equal(isAllowedImageUrl(bad), false);
});

test("mobile cross-check ignores PC ad slots and the mobile title component", () => {
  const html = '<div class="se-component se-documentTitle"></div><div class="se-component se-text se-l-default"></div>';
  assert.ok(compareKinds(countKinds(["ssp-adcontent align_center", "se-component se-text"]), countKinds(mobileComponentClasses(html))).every((r) => r.match));
});

test("fidelity excludes ads and TemplateEngine placeholders, flags outliers", () => {
  const ad = { ...sBlock, className: "ssp-adcontent align_center", rect: { ...rect, height: 177 } };
  const map = { ...sBlock, className: "se-component se-placesMap", rect: { ...rect, height: 468 } };
  const tall = { ...sBlock, rect: { ...rect, height: 200 } };
  const f = fidelity([sBlock, ad, map, tall], [{ height: 103, characters: 20 }, { height: 0, characters: 0 }, { height: 107, characters: 0 }, { height: 100, characters: 20 }], [tBlock, tBlock, tBlock, tBlock]);
  assert.equal(f.summary.measured, 2);
  assert.equal(f.summary.within5pct, 1);
  assert.deepEqual(f.summary.excluded.map((x) => x.reason), ["non-author", "TemplateEngine placeholder"]);
  assert.equal(f.summary.outliers[0].order, 3);
});

test("upsert drops null entries; markdown round-trips through the Dashboard parser", () => {
  const ref = { name: "애둔", url: "https://blog.naver.com/eehdune/224442171288", pageUrl: "https://blog.naver.com/PostView.naver?blogId=eehdune&logNo=224442171288", width: 966, blocks: [sBlock] };
  const list = upsertBy([null, { ...ref, width: 1 }], ref, "url");
  assert.equal(list.length, 1);
  assert.equal(parseReferences(toMarkdown("t", { 관찰일: "x" }, list))[0].blocks[0].anchorId, "SE-1");
});

test("font faces: only loaded se-* families from Naver CDN woff2", () => {
  const css = `@font-face{font-family:se-nanumgothic;font-weight:700;src:url(../fonts/ng-b.woff2) format("woff2"),url(x.woff) format("woff")}
@font-face{font-family:"se-nanumbareunhipi";src:url("https://ssl.pstatic.net/static/hipi.woff2") format('woff2')}
@font-face{font-family:other;src:url(o.woff2) format("woff2")}
@font-face{font-family:se-nanumsquare;src:url(https://evil.test/s.woff2) format("woff2")}`;
  const faces = fontFaces(css, "https://ssl.pstatic.net/static/css/se.css", new Set(["se-nanumgothic", "se-nanumbareunhipi", "se-nanumsquare"]));
  assert.deepEqual(faces.map((f) => [f.file, f.url]), [
    ["se-nanumgothic-bold.woff2", "https://ssl.pstatic.net/static/fonts/ng-b.woff2"],
    ["se-nanumbareunhipi-regular.woff2", "https://ssl.pstatic.net/static/hipi.woff2"],
  ]);
});

test("page scripts are self-contained and compile as standalone scripts", () => {
  for (const script of [pageScript(extractPost, ".se-main-container", { id: "x" }), pageScript(loadImages, 0), pageScript(measureRestore)]) {
    assert.doesNotThrow(() => new Function(script));
    assert.doesNotMatch(script, /\brequire\(|\bimport\(/);
  }
});

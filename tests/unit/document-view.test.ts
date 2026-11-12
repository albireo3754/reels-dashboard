import test from "node:test";
import assert from "node:assert/strict";
import {
  blogAssetPath,
  defaultDocumentView,
  documentViewModes,
  isBlogMarkup,
  splitFrontmatter,
} from "../../src/features/content-board/model/document-view";

test("Markdown gets blog, Markdown and text views; other text formats stay plain text", () => {
  assert.deepEqual(documentViewModes("/a/대본.md"), ["blog", "markdown", "text"]);
  assert.deepEqual(documentViewModes("/a/README.MD"), ["blog", "markdown", "text"]);
  for (const file of ["/a/c.txt", "/a/m.json", "/a/s.srt", "/a/p.html"])
    assert.deepEqual(documentViewModes(file), ["text"]);
});

test("blog markup opens in the blog view and other Markdown in the Markdown view", () => {
  const markup = "---\nmarkup: 1\ntitle: t\n---\n<Bundle id=\"B01\" name=\"도입\">\n</Bundle>\n";
  assert.equal(isBlogMarkup(markup), true);
  assert.equal(isBlogMarkup('<Bundle id="B01" name="x">\n¶ P1\n문장\n</Bundle>'), true);
  assert.equal(isBlogMarkup("---\ntitle: 대본\n---\n# 대본"), false);
  assert.equal(isBlogMarkup("본문에 <Bundle> 이라고 적은 문장"), false);
  assert.equal(defaultDocumentView("/a/원고.md", markup), "blog");
  assert.equal(defaultDocumentView("/a/대본.md", "# 대본"), "markdown");
  assert.equal(defaultDocumentView("/a/원고.txt", markup), "text");
});

test("frontmatter is split from the Markdown body", () => {
  assert.deepEqual(splitFrontmatter("---\ntitle: a\n---\n# 본문"), {
    frontmatter: "title: a",
    body: "# 본문",
  });
  assert.deepEqual(splitFrontmatter("# 본문\n---\n"), { frontmatter: "", body: "# 본문\n---\n" });
});

test("blog assets resolve beside the document or under its media folder, never via URLs", () => {
  const doc = "/r/글/원고.md";
  assert.equal(blogAssetPath(doc, "", "a.jpg"), "/r/글/a.jpg");
  assert.equal(blogAssetPath(doc, "photos", "a.jpg"), "/r/글/photos/a.jpg");
  assert.equal(blogAssetPath(doc, "../사진/", "a.jpg"), "/r/사진/a.jpg");
  assert.equal(blogAssetPath(doc, "/abs/media", "a.jpg"), "/abs/media/a.jpg");
  assert.equal(blogAssetPath(doc, "", "/x/a.jpg"), "/x/a.jpg");
  assert.equal(blogAssetPath(doc, "", "https://example.com/a.jpg"), undefined);
  assert.equal(blogAssetPath(doc, "", "//cdn/a.jpg"), undefined);
  assert.equal(blogAssetPath(doc, "", "../../../../a.jpg"), undefined);
  assert.equal(blogAssetPath(doc, "", ""), undefined);
});

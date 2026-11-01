import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CanonicalStore } from "../../src/app/blog-editor/store";
import {
  readInline,
  inlineSource,
  inlineHtml,
  restyle,
} from "../../src/shared/canonical-blog";

import { makeCanonicalFixture } from "../fixtures/canonical-content";
test("inline styles preserve nested colors, bold, highlights and links without executing markup", () => {
  const source =
    '저는 <span style="color:rgb(166,65,50)">**차를**</span> ==마셨어요==\n[안내](https://example.org)';
  assert.equal(
    readInline(source)
      .map((r) => r.text)
      .join(""),
    "저는 차를 마셨어요\n[안내](https://example.org)",
  );
  assert.equal(inlineSource(readInline(source)), source);
  assert.match(inlineHtml(source), /href="https:\/\/example.org"/);
  assert.throws(() => readInline("**안 닫힘"));
  assert.match(
    restyle("사진 속 벤치", 5, 7, { color: "#a64132" }),
    /color:#a64132/,
  );
});
test("canonical save preserves private records, images, other prose; updates emphasis and rejects external edits", async () => {
  const f = await makeCanonicalFixture();
  try {
    const s = new CanonicalStore(f.config),
      doc = await s.load();
    assert.equal(doc.bundles.length, 2);
    assert.match(await s.frame(), /contenteditable="true"/);
    const result = await s.save({
      revision: doc.revision,
      edits: [
        { id: "T1", source: "벤치에서 ==느긋하게== 쉬었어요\n바람이 좋았어요" },
      ],
    });
    const raw = await readFile(f.config.canon, "utf8");
    assert.equal(raw, f.raw.replace("==잠시==", "==느긋하게=="));
    const emphasis = JSON.parse(
      await readFile(path.join(f.config.layers, "emphasis-layer.json"), "utf8"),
    );
    assert.equal(
      emphasis.emphasis.find((e: any) => e.id === "T1").phrase,
      "느긋하게",
    );
    assert.match(await readFile(f.config.layout, "utf8"), /느긋하게/);
    assert.equal(
      await readFile(path.join(result.backup, "canonical.md"), "utf8"),
      f.raw,
    );
    await assert.rejects(
      () => s.save({ revision: doc.revision, edits: [] }),
      /다른 세션/,
    );
    await writeFile(f.config.canon, raw + "외부 수정\n");
    await assert.rejects(
      () => s.save({ revision: result.document.revision, edits: [] }),
      /다른 세션/,
    );
    assert.match(await readFile(f.config.canon, "utf8"), /외부 수정/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("review only queues on request and arbitrary images/unknown paragraphs cannot be written", async () => {
  const f = await makeCanonicalFixture();
  try {
    const s = new CanonicalStore(f.config),
      d = await s.load();
    await assert.rejects(() => s.asset("photo", "../secret"));
    await assert.rejects(() =>
      s.save({
        revision: d.revision,
        edits: [{ id: "T9", source: "missing" }],
      }),
    );
    await assert.rejects(() =>
      s.save({
        revision: d.revision,
        edits: [{ id: "T1", source: '<span onclick="bad">oops</span>' }],
      }),
    );
    assert.equal(await readFile(f.config.canon, "utf8"), f.raw);
    const request = await s.request({
      revision: d.revision,
      bundleIds: ["G1"],
    });
    assert.equal(request.status, "pending");
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(f.config.layers, "editor-requests", request.id + ".json"),
          "utf8",
        ),
      ).basedOn,
      d.revision,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("only explicitly registered original photo targets may be served through existing symlinks", async () => {
  const f = await makeCanonicalFixture();
  const { rename, symlink, unlink } = await import("node:fs/promises");
  try {
    const photo = path.join(f.config.media, "photo.svg"),
      original = path.join(f.root, "original.svg");
    await rename(photo, original);
    await symlink(original, photo);
    await assert.rejects(() =>
      new CanonicalStore(f.config).asset("photo", "photo.svg"),
    );
    const store = new CanonicalStore({ ...f.config, assetFiles: [original] });
    assert.equal(await store.asset("photo", "photo.svg"), original);
    await unlink(photo);
    await symlink(f.config.canon, photo);
    await assert.rejects(() => store.asset("photo", "photo.svg"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  mkdir,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BlogResults } from "../../src/desktop/blog-results";
import { LocalStore } from "../../src/shared/lib/storage";
const rect = { x: 0, y: 0, width: 600, height: 100 };
const refs = [
  {
    name: "저장된 분석",
    url: "https://blog.naver.com/fixture/1",
    pageUrl: "https://blog.naver.com/fixture/1",
    width: 600,
    blocks: [
      {
        order: 0,
        id: "b",
        className: "se-text",
        rect,
        css: {},
        paragraphs: [],
        images: [],
      },
    ],
  },
];
test("registered results survive service restart, deduplicate, and report missing files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "blog-results-"));
  const store = new LocalStore(root);
  await store.initialize();
  const dir = path.join(root, "result");
  await mkdir(dir);
  const file = path.join(dir, "reference-structures.json");
  await writeFile(file, JSON.stringify(refs));
  try {
    const service = new BlogResults(store);
    const result = await service.register(dir);
    await service.register(dir);
    const restarted = new BlogResults(store);
    assert.equal((await restarted.list()).length, 1);
    assert.equal((await restarted.list())[0].names[0], "저장된 분석");
    assert.deepEqual(JSON.parse(await restarted.read(result.id)), refs);
    await unlink(file);
    assert.ok((await restarted.list())[0].error);
    await assert.rejects(restarted.read("unknown"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("preview serves only registered output assets and rejects secrets, symlinks and wrong token", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "blog-preview-"));
  const store = new LocalStore(root);
  await store.initialize();
  const dir = path.join(root, "result");
  await mkdir(dir);
  await writeFile(
    path.join(dir, "reference-structures.json"),
    JSON.stringify(refs),
  );
  await writeFile(path.join(dir, "index.html"), "<h1>Preview</h1>");
  await writeFile(path.join(dir, "private.json"), "private");
  await symlink(
    path.join(dir, "private.json"),
    path.join(dir, "blog-preview.js"),
  );
  const service = new BlogResults(store);
  try {
    const result = await service.register(dir);
    const url = await service.preview(result.id);
    assert.equal(await (await fetch(url)).text(), "<h1>Preview</h1>");
    for (const suffix of [
      "private.json",
      "blog-preview.js",
      "%2e%2e%2fprivate.json",
    ])
      assert.equal((await fetch(url + suffix)).status, 404);
    assert.equal((await fetch(new URL("/wrong/", url))).status, 404);
    assert.equal((await fetch(url, { method: "POST" })).status, 404);
  } finally {
    service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("remove unlinks without deleting files and notifies listeners", async () => {
  const { mkdtemp, writeFile, readdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { LocalStore } = await import("../../src/shared/lib/storage");
  const { BlogResults } = await import("../../src/desktop/blog-results");
  const root = await mkdtemp(join(tmpdir(), "blog-results-remove-"));
  const folder = await mkdtemp(join(tmpdir(), "blog-results-folder-"));
  try {
    await writeFile(join(folder, "reference-structures.json"), JSON.stringify([{ name: "r", url: "https://blog.naver.com/a/1234567", pageUrl: "https://blog.naver.com/a/1234567", width: 600, blocks: [{ order: 0, id: "x", anchorId: "x", className: "se-text", rect: { x: 0, y: 0, width: 1, height: 1 }, css: {}, paragraphs: [], images: [] }] }]));
    const store = new LocalStore(root);
    await store.initialize();
    let changes = 0;
    const service = new BlogResults(store, () => changes++);
    const result = await service.register(folder);
    assert.equal(changes, 1);
    assert.deepEqual(await service.remove(result.id), { removed: result.id });
    assert.equal(changes, 2);
    assert.equal((await service.list()).length, 0);
    assert.ok((await readdir(folder)).includes("reference-structures.json"));
    await assert.rejects(() => service.remove(result.id));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  }
});

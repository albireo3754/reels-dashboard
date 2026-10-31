import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalStore } from "../../src/shared/lib/storage";
import { ContentLibrary } from "../../src/features/content-library";
import { toSnapshot, fromSnapshot } from "../../src/shared/data";
import type { ContentInput } from "../../src/shared/local-resources";

test("local content links survive restart, replace by stable ID, stay private, and report missing sources", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reels-content-"));
  try {
    const store = new LocalStore(root);
    await store.initialize();
    const file = path.join(root, "완성본.mp4");
    await writeFile(file, "unchanged source");
    let events = 0;
    const lib = new ContentLibrary(store, () => events++);
    const content: ContentInput = {
      id: "content-example",
      title: "예시",
      date: "2026-10-27",
      dateBasis: "publication",
      stage: "published",
      nextAction: "",
      publicURL: "https://example.com/reel",
      localNotes: "private note",
      resources: [{ role: "final", path: file, label: "완성본" }],
    };
    const first = await lib.upsert(content, (await store.load()).updatedAt);
    assert.equal(first.project.shared, false);
    assert.equal(first.resources[0].available, true);
    const second = await lib.upsert(
      { ...content, title: "updated" },
      first.updatedAt,
    );
    assert.equal((await store.load()).projects.length, 1);
    assert.equal(events, 2);
    await assert.rejects(
      lib.upsert(content, first.updatedAt),
      /STALE_DASHBOARD/,
    );
    const restarted = new ContentLibrary(new LocalStore(root));
    assert.equal((await restarted.get(content.id)).project.title, "updated");
    const local = await store.load();
    local.projects[0].shared = true;
    const snapshot = toSnapshot(local);
    assert.ok(!JSON.stringify(snapshot).includes("private"));
    assert.ok(!JSON.stringify(snapshot).includes(root));
    assert.equal(
      fromSnapshot({
        ...snapshot,
        projects: [
          {
            ...snapshot.projects[0],
            resources: content.resources,
            localNotes: "secret",
          },
        ],
      }).projects[0].resources,
      undefined,
    );
    await rm(file);
    assert.equal((await lib.get(content.id)).resources[0].available, false);
    await assert.rejects(lib.upsert(content, second.updatedAt));
    assert.equal((await store.load()).updatedAt, second.updatedAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("concurrent revision-checked registrations cannot overwrite each other or UI saves", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reels-content-race-"));
  try {
    const store = new LocalStore(root);
    await store.initialize();
    const lib = new ContentLibrary(store);
    const initial = await store.load();
    const content: ContentInput = {
      id: "first",
      title: "test",
      date: "2026-10-27",
      dateBasis: "record",
      stage: "captured",
      nextAction: "",
      publicURL: "",
      localNotes: "",
      resources: [],
    };
    const result = await Promise.allSettled([
      lib.upsert(content, initial.updatedAt),
      lib.upsert({ ...content, id: "second" }, initial.updatedAt),
    ]);
    assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
    await assert.rejects(
      store.save(initial, initial.updatedAt),
      /STALE_DASHBOARD/,
    );
    assert.equal((await store.load()).projects.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("folder discovery is paginated, metadata-only and excludes secrets and symlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reels-content-scan-"));
  try {
    await writeFile(path.join(root, "a.mov"), "a");
    await writeFile(path.join(root, "b.jpg"), "b");
    await writeFile(path.join(root, "private.env"), "secret");
    await mkdir(path.join(root, "folder"));
    await symlink(path.join(root, "a.mov"), path.join(root, "alias.mov"));
    const lib = new ContentLibrary(new LocalStore(root));
    const first = await lib.listFolder(root, 0, 2);
    assert.equal(first.total, 3);
    assert.equal(first.nextOffset, 2);
    assert.equal((await lib.listFolder(root, 2, 2)).nextOffset, null);
    assert.ok(!JSON.stringify(first).includes("secret"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalStore } from "../../src/shared/lib/storage";
import { ContentLibrary, BoardMedia } from "../../src/features/content-library";

test("board media is paginated, scoped to current links, and rejects symlink escapes and removed grants", async () => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "board-media-")),
  );
  const store = new LocalStore(root);
  await store.initialize();
  const library = new ContentLibrary(store);
  const directory = path.join(root, "footage");
  await mkdir(directory);
  for (let i = 0; i < 26; i++)
    await writeFile(path.join(directory, `image-${i}.png`), "image");
  const audio = path.join(directory, "voice.wav");
  await writeFile(audio, "0123456789");
  const outside = path.join(root, "private.wav");
  await writeFile(outside, "secret");
  await writeFile(path.join(directory, ".hidden.png"), "hidden");
  await symlink(outside, path.join(directory, "escape.wav"));
  const content = {
    id: "board-fixture",
    title: "example",
    date: "2026-10-28",
    dateBasis: "capture" as const,
    stage: "captured" as const,
    nextAction: "choose",
    publicURL: "",
    localNotes: "",
    resources: [{ role: "folder" as const, path: directory, label: "촬영본" }],
  };
  const service = new BoardMedia(
    library,
    path.join(root, "cache"),
    "/unused",
    async () => "data:image/png;base64,fixture",
  );
  try {
    await library.upsert(content, (await store.load()).updatedAt);
    const first = await library.mediaPage(content.id, directory);
    assert.equal(first.items.length, 24);
    assert.equal(first.total, 27);
    assert.equal(first.nextOffset, 24);
    const second = await library.mediaPage(content.id, directory, 24);
    assert.equal(second.items.length, 3);
    assert.equal(second.nextOffset, null);
    await assert.rejects(library.resolveMedia(content.id, outside));
    await assert.rejects(
      library.resolveMedia(content.id, path.join(directory, "escape.wav")),
    );
    await assert.rejects(
      library.resolveMedia(content.id, path.join(directory, ".hidden.png")),
    );
    await assert.rejects(library.mediaPage(content.id, directory, -1));
    const { url } = await service.open(content.id, audio);
    const range = await service.media(
      new Request(url, { headers: { Range: "bytes=2-5" } }),
    );
    assert.equal(range.status, 206);
    assert.equal(await range.text(), "2345");
    assert.equal(
      (await service.media(new Request(url, { method: "HEAD" }))).headers.get(
        "content-length",
      ),
      "10",
    );
    assert.equal(
      (
        await service.media(
          new Request(url, { headers: { Range: "bytes=20-" } }),
        )
      ).status,
      416,
    );
    assert.equal(
      (
        await service.media(
          new Request(url, { headers: { Origin: "https://evil.example" } }),
        )
      ).status,
      403,
    );
    assert.equal(
      (await service.media(new Request("reels-media://content/unregistered")))
        .status,
      404,
    );
    await library.upsert(
      { ...content, resources: [] },
      (await store.load()).updatedAt,
    );
    assert.equal((await service.media(new Request(url))).status, 404);
    await assert.rejects(
      service.thumbnail(content.id, path.join(directory, "image-1.png")),
    );
  } finally {
    service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

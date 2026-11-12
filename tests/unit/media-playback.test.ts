import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutionLogs } from "../../src/shared/lib/execution-logs";
import { LocalStore } from "../../src/shared/lib/storage";
import {
  SF_DATALESS,
  hasDatalessFlag,
  isDatalessFile,
  videoContentType,
} from "../../src/shared/lib/media-playback";
import { ContentLibrary, BoardMedia } from "../../src/features/content-library";
import { EditorService } from "../../src/features/reel-editing";

// A stand-in for the bundled `reels-editor`: probe reports fixed metadata and proxy
// writes a marker file, counting calls so tests can prove when a copy is made.
async function fakeRuntime(root: string) {
  const runtime = path.join(root, "runtime");
  await mkdir(runtime, { recursive: true });
  const script = path.join(runtime, "reels-editor");
  await writeFile(
    script,
    `#!/bin/sh
case "$1" in
probe) echo '{"duration":2,"width":1080,"height":1920,"hdr":true,"hasAudio":false}';;
proxy) echo x >> "${runtime}/proxy-calls"; printf 'PLAYBACK-COPY' > "$3"; echo '{"outputPath":"'"$3"'","hdrToSDR":true}';;
*) exit 2;;
esac
`,
  );
  await chmod(script, 0o755);
  const calls = async () =>
    (await readFile(path.join(runtime, "proxy-calls"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean).length;
  return { runtime, calls };
}

test("dataless detection trusts st_flags, falls back to blocks and defaults to local", async () => {
  const local = { size: 10, blocks: 8 };
  const evicted = { size: 10, blocks: 0 };
  assert.equal(hasDatalessFlag(SF_DATALESS | 0x40), true);
  assert.equal(hasDatalessFlag(0x40), false);
  assert.equal(hasDatalessFlag(Number.NaN), false);
  const darwin = { platform: "darwin" as const };
  assert.equal(
    await isDatalessFile("/x", { ...darwin, readFlags: async () => SF_DATALESS, info: local }),
    true,
  );
  // The flag wins over the heuristic in both directions.
  assert.equal(
    await isDatalessFile("/x", { ...darwin, readFlags: async () => 0x40, info: evicted }),
    false,
  );
  assert.equal(
    await isDatalessFile("/x", { ...darwin, readFlags: async () => null, info: evicted }),
    true,
  );
  assert.equal(
    await isDatalessFile("/x", {
      ...darwin,
      readFlags: async () => {
        throw new Error("no stat");
      },
      info: local,
    }),
    false,
  );
  // Undeterminable (missing file, no flags) means "play the original".
  assert.equal(
    await isDatalessFile("/definitely/missing.mov", { ...darwin, readFlags: async () => null }),
    false,
  );
  assert.equal(
    await isDatalessFile("/x", { platform: "linux", readFlags: async () => SF_DATALESS }),
    false,
  );
  assert.equal(videoContentType("/a/B.MOV"), "video/quicktime");
  assert.equal(videoContentType("/a/b.m4v"), "video/mp4");
  if (process.platform === "darwin") {
    const root = await mkdtemp(path.join(os.tmpdir(), "playback-flags-"));
    try {
      const file = path.join(root, "local.mp4");
      await writeFile(file, "local bytes");
      assert.equal(await isDatalessFile(file), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("board videos stream the original and make a copy only on request or for dataless files", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "board-playback-")));
  const { runtime, calls } = await fakeRuntime(root);
  const store = new LocalStore(root);
  await store.initialize();
  const library = new ContentLibrary(store);
  const footage = path.join(root, "footage");
  await mkdir(footage);
  const local = path.join(footage, "local.mov");
  const evicted = path.join(footage, "evicted.mp4");
  await writeFile(local, "ORIGINAL-HDR-BYTES");
  await writeFile(evicted, "CLOUD-PLACEHOLDER");
  const checked: string[] = [];
  const service = new BoardMedia(
    library,
    path.join(root, "cache"),
    runtime,
    new ExecutionLogs(root),
    async () => "data:image/png;base64,fixture",
    async (file) => {
      checked.push(file);
      return file === evicted;
    },
  );
  try {
    await library.upsert(
      {
        id: "playback",
        title: "playback",
        date: "2026-11-12",
        dateBasis: "capture" as const,
        stage: "captured" as const,
        nextAction: "watch",
        publicURL: "",
        localNotes: "",
        resources: [{ role: "folder" as const, path: footage, label: "촬영본" }],
      },
      (await store.load()).updatedAt,
    );
    const original = await service.open("playback", local);
    assert.equal(original.playback, "original");
    assert.deepEqual(checked, [local]);
    const head = await service.media(new Request(original.url, { method: "HEAD" }));
    assert.equal(head.headers.get("content-type"), "video/quicktime");
    assert.equal(head.headers.get("content-length"), "18");
    const range = await service.media(
      new Request(original.url, { headers: { Range: "bytes=0-7" } }),
    );
    assert.equal(range.status, 206);
    assert.equal(await range.text(), "ORIGINAL");
    assert.equal(await calls(), 0, "playing an original must not make a copy");
    assert.equal(
      (await service.media(new Request(original.url, { headers: { Origin: "https://evil.example" } }))).status,
      403,
    );

    const fallback = await service.open("playback", local, { copy: true });
    assert.equal(fallback.playback, "copy");
    const copied = await service.media(new Request(fallback.url));
    assert.equal(copied.headers.get("content-type"), "video/mp4");
    assert.equal(await copied.text(), "PLAYBACK-COPY");
    assert.equal(await calls(), 1);
    // The cached copy is reused for the same original.
    await service.open("playback", local, { copy: true });
    assert.equal(await calls(), 1);

    const cloud = await service.open("playback", evicted);
    assert.equal(cloud.playback, "copy");
    assert.equal(await (await service.media(new Request(cloud.url))).text(), "PLAYBACK-COPY");
    assert.equal(await calls(), 2);
    assert.equal(await readFile(local, "utf8"), "ORIGINAL-HDR-BYTES");
  } finally {
    service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("editor imports without a copy, streams the original and makes a copy only after a playback failure", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "editor-playback-")));
  const { runtime, calls } = await fakeRuntime(root);
  const store = new LocalStore(root);
  await store.initialize();
  let dataless = false;
  const service = new EditorService({
    logs: new ExecutionLogs(root),
    root,
    runtime,
    store,
    chooseVideo: async () => null,
    chooseOutput: async () => null,
    materialize: async () => {
      throw new Error("unused");
    },
    reveal: () => {},
    dataless: async () => dataless,
  });
  const source = path.join(root, "원본 HDR.mov");
  await writeFile(source, "SOURCE-HLG-10BIT");
  try {
    const project = await service.importVideo(source);
    const dir = path.join(root, "editor", project.id);
    assert.equal(project.source.videoURL, `reels-media://video/${project.id}`);
    assert.equal(project.source.hdr, true);
    assert.equal(await calls(), 0, "import must not prepare a playback copy");
    assert.equal(await stat(path.join(dir, "playback.mp4")).catch(() => null), null);
    const record = JSON.parse(await readFile(path.join(dir, "project.json"), "utf8"));
    assert.equal("proxyPath" in record, false);

    const original = await service.media(new Request(project.source.videoURL));
    assert.equal(original.status, 200);
    assert.equal(original.headers.get("content-type"), "video/quicktime");
    assert.equal(await original.text(), "SOURCE-HLG-10BIT");
    const tail = await service.media(
      new Request(project.source.videoURL, { headers: { Range: "bytes=7-" } }),
    );
    assert.equal(tail.status, 206);
    assert.equal(await tail.text(), "HLG-10BIT");
    assert.equal(
      (await service.media(new Request(project.source.videoURL, { headers: { Origin: "https://evil.example" } }))).status,
      403,
    );
    // No copy yet, unknown variants and nested paths are refused.
    assert.equal((await service.media(new Request(`${project.source.videoURL}/copy`))).status, 404);
    assert.equal((await service.media(new Request(`${project.source.videoURL}/source`))).status, 404);
    assert.equal((await service.media(new Request(`${project.source.videoURL}/copy/x`))).status, 404);

    // An evicted iCloud original is refused at the start so the renderer falls back.
    dataless = true;
    assert.equal((await service.media(new Request(project.source.videoURL))).status, 503);
    assert.equal(
      (
        await service.media(
          new Request(project.source.videoURL, { headers: { Range: "bytes=0-3" } }),
        )
      ).status,
      503,
    );
    dataless = false;

    const [first, second] = await Promise.all([
      service.playbackCopy(project.id),
      service.playbackCopy(project.id),
    ]);
    assert.equal(first, `reels-media://video/${project.id}/copy`);
    assert.equal(second, first);
    assert.equal(await calls(), 1, "concurrent requests share one copy");
    const copy = await service.media(new Request(first));
    assert.equal(copy.headers.get("content-type"), "video/mp4");
    assert.equal(await copy.text(), "PLAYBACK-COPY");
    await service.playbackCopy(project.id);
    assert.equal(await calls(), 1, "an existing copy is reused");
    await assert.rejects(service.playbackCopy("../../etc/passwd"));
    assert.equal(await readFile(source, "utf8"), "SOURCE-HLG-10BIT");

    // Records saved before original-first playback still load and keep their copy.
    const legacy = { ...record, proxyPath: path.join(dir, "playback.mp4") };
    await writeFile(path.join(dir, "project.json"), JSON.stringify(legacy));
    const reloaded = new EditorService({
      logs: new ExecutionLogs(root),
      root,
      runtime,
      store,
      chooseVideo: async () => null,
      chooseOutput: async () => null,
      materialize: async () => ({ sourcePath: source }),
      reveal: () => {},
      dataless: async () => false,
    });
    assert.equal((await reloaded.load(project.id)).source.videoURL, project.source.videoURL);
    assert.equal(await (await reloaded.media(new Request(project.source.videoURL))).text(), "SOURCE-HLG-10BIT");
    assert.equal(await reloaded.playbackCopy(project.id), first);
    assert.equal(await calls(), 1);
    await reloaded.dispose();
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

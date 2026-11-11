import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
  readdir,
  symlink,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { ClipUpload, ContentLibrary } from "../../src/features/content-library";
import { LocalStore } from "../../src/shared/lib/storage";
import { CoverPreferencesStore } from "../../src/shared/lib/cover-preferences";
import { toSnapshot } from "../../src/shared/data";
import {
  createAgentDispatch,
  type AgentPorts,
  toolDefinitions,
} from "../../src/features/agent-tools";
import { AgentSession } from "../../src/entities/agent-session";
const digest = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const jpeg = Buffer.from([255, 216, 1, 2, 255, 217]); // Service-port fixture; real decoding is checked in Electron.
async function fixture(t: any) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "clip-unit-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputs = path.join(root, "한글 자료"),
    outputs = path.join(root, "outputs");
  await mkdir(inputs);
  await mkdir(outputs);
  const video = path.join(inputs, "영상.mp4"),
    cover = path.join(inputs, "표지.png");
  await writeFile(video, "synthetic video");
  await writeFile(cover, "synthetic PNG");
  const store = new LocalStore(path.join(root, "data"));
  await store.initialize();
  const library = new ContentLibrary(store);
  const content = await library.upsert(
    {
      id: "clip",
      title: "Clip QA",
      date: "2026-11-12",
      dateBasis: "record",
      stage: "review",
      nextAction: "",
      publicURL: "",
      localNotes: "",
      resources: [
        { role: "final", path: video, label: "video" },
        { role: "cover", path: cover, label: "cover" },
      ],
    },
    (await store.load()).updatedAt,
  );
  const service = new ClipUpload(library, async () => jpeg, outputs);
  const input = {
    projectId: "clip",
    expectedUpdatedAt: content.updatedAt,
    description: "은행나무 산책 🌳\n\n#가을",
  };
  return {
    root,
    inputs,
    outputs,
    video,
    cover,
    store,
    library,
    service,
    input,
  };
}

test("bundle preserves sources/dashboard and exact UTF-8 prose, returns verified private ASCII copies", async (t) => {
  const f = await fixture(t);
  const before = await f.store.load();
  const result = await f.service.create(f.input);
  for (const file of [...Object.values(result.files), result.receipt]) {
    const data = await readFile(file.path);
    assert.equal(data.length, file.bytes);
    assert.equal(digest(data), file.sha256);
    assert.match(path.basename(file.path), /^[A-Za-z0-9.-]+$/);
    assert.equal((await stat(file.path)).mode & 0o777, 0o600);
  }
  assert.equal((await stat(result.directory)).mode & 0o777, 0o700);
  assert.deepEqual(
    await readFile(result.files.video.path),
    await readFile(f.video),
  );
  assert.deepEqual(await readFile(result.files.cover.path), jpeg);
  assert.equal(
    await readFile(result.files.description.path, "utf8"),
    f.input.description,
  );
  assert.equal(await readFile(f.cover, "utf8"), "synthetic PNG");
  assert.deepEqual(await f.store.load(), before);
  assert.equal((await readdir(result.directory)).length, 4);
  const again = await f.service.create(f.input);
  assert.notEqual(again.directory, result.directory);
});

test("selection refuses stale, ambiguous, unregistered, wrong-role and symlink inputs", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.service.create({
      ...f.input,
      expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
    }),
    /STALE/,
  );
  await assert.rejects(
    f.service.create({ ...f.input, videoPath: f.cover }),
    /UPLOAD_SOURCE/,
  );
  const extra = path.join(f.inputs, "second.mp4");
  await writeFile(extra, "second");
  await assert.rejects(
    f.service.create({ ...f.input, videoPath: extra }),
    /UPLOAD_SOURCE/,
  );
  const dashboard = await f.store.update((d) => {
    d.projects[0].resources!.push({
      role: "final",
      path: extra,
      label: "second",
    });
    return d;
  });
  f.input.expectedUpdatedAt = dashboard.updatedAt;
  await assert.rejects(f.service.create(f.input), /UPLOAD_SELECTION/);
  await f.service.create({ ...f.input, videoPath: extra });
  await rm(extra);
  await symlink(f.video, extra);
  await assert.rejects(
    f.service.create({ ...f.input, videoPath: extra }),
    /연결 경로/,
  );
});

test("current outbound overrides old resources and detects external edits without touching outbound", async (t) => {
  const f = await fixture(t);
  await f.store.update((d) => {
    d.projects[0].outbound = {
      directory: f.inputs,
      generation: 1,
      updatedAt: d.updatedAt,
      files: [
        {
          name: path.basename(f.video),
          role: "final",
          bytes: 15,
          sha256: digest(Buffer.from("synthetic video")),
        },
        {
          name: path.basename(f.cover),
          role: "cover",
          bytes: 13,
          sha256: digest(Buffer.from("synthetic PNG")),
        },
      ],
    };
    return d;
  });
  // Use the actual byte counts in the persisted receipt.
  const dashboard = await f.store.update(async (d) => {
    for (const file of d.projects[0].outbound!.files)
      file.bytes = (await stat(path.join(f.inputs, file.name))).size;
    return d;
  });
  f.input.expectedUpdatedAt = dashboard.updatedAt;
  const before = await f.store.load();
  await f.service.create(f.input);
  await writeFile(f.video, "external edit");
  await assert.rejects(f.service.create(f.input), /OUTBOUND_CHANGED/);
  assert.equal(await readFile(f.video, "utf8"), "external edit");
  assert.deepEqual(await f.store.load(), before);
  assert.equal((await readdir(f.outputs)).length, 1);
});

test("failed JPEG conversion and revision races remove only the incomplete bundle", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    new ClipUpload(
      f.library,
      async () => Buffer.from("not jpeg"),
      f.outputs,
    ).create(f.input),
    /JPEG/,
  );
  assert.deepEqual(await readdir(f.outputs), []);
  const racing = new ClipUpload(
    f.library,
    async () => {
      await f.store.update((d) => {
        d.projects[0].title = "changed";
        return d;
      });
      return jpeg;
    },
    f.outputs,
  );
  await assert.rejects(racing.create(f.input), /STALE/);
  assert.deepEqual(await readdir(f.outputs), []);
  assert.equal(await readFile(f.cover, "utf8"), "synthetic PNG");
});

test("local signature defaults, validates, persists privately, and is absent from shared state", async (t) => {
  const f = await fixture(t),
    preferences = new CoverPreferencesStore(f.store.root);
  assert.equal((await preferences.get()).signature, "@your_account 🌹");
  await preferences.set({ signature: "@example 🌹" });
  assert.equal(
    (await new CoverPreferencesStore(f.store.root).get()).signature,
    "@example 🌹",
  );
  assert.equal(
    (await stat(path.join(f.store.root, "cover-preferences.json"))).mode &
      0o777,
    0o600,
  );
  await assert.rejects(preferences.set({ signature: "bad\nvalue" }));
  assert.ok(
    !JSON.stringify(toSnapshot(await f.store.load())).includes("@example"),
  );
  await writeFile(path.join(f.store.root, "cover-preferences.json"), "invalid");
  await assert.rejects(preferences.get());
});

test("MCP dispatch uses shared bundle/preferences services and validates input", async (t) => {
  const f = await fixture(t);
  const ports = {
    session: new AgentSession(),
    editor: {},
    clipUpload: f.service,
    coverPreferences: new CoverPreferencesStore(f.store.root),
  } as unknown as AgentPorts;
  const dispatch = createAgentDispatch(ports);
  await dispatch("reels_set_cover_preferences", { signature: "@example" });
  assert.deepEqual(await dispatch("reels_get_cover_preferences", {}), {
    signature: "@example",
  });
  const result = (await dispatch(
    "reels_create_clip_upload_bundle",
    f.input,
  )) as any;
  assert.equal(
    await readFile(result.files.description.path, "utf8"),
    f.input.description,
  );
  assert.equal(
    toolDefinitions.reels_create_clip_upload_bundle.input.safeParse({
      ...f.input,
      description: " ",
    }).success,
    false,
  );
});

test("latest export timestamp wins independently of resource order; equal latest versions require a choice", async (t) => {
  const f = await fixture(t);
  const latest = path.join(f.inputs, "latest.mp4");
  await writeFile(latest, "latest bytes");
  const edit = {
    kind: "video" as const,
    id: "11111111-1111-4111-8111-111111111111",
  };
  const update = await f.store.update((d) => {
    const project = d.projects[0];
    project.resources!.unshift({
      role: "draft",
      path: latest,
      label: "latest",
    });
    project.production = {
      schemaVersion: 1,
      edits: [edit],
      mergedIds: [],
      exports: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          edit,
          path: latest,
          role: "draft",
          recordedAt: "2026-11-12T01:00:00.000Z",
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          edit,
          path: f.video,
          role: "final",
          recordedAt: "2026-11-11T01:00:00.000Z",
        },
      ],
    };
    return d;
  });
  f.input.expectedUpdatedAt = update.updatedAt;
  assert.equal((await f.service.create(f.input)).sources.video, latest);
  const tied = await f.store.update((d) => {
    d.projects[0].production!.exports[1].recordedAt =
      "2026-11-12T01:00:00.000Z";
    return d;
  });
  f.input.expectedUpdatedAt = tied.updatedAt;
  await assert.rejects(f.service.create(f.input), /UPLOAD_SELECTION/);
  const bound = await f.store.update(async (d) => {
    d.projects[0].outbound = {
      directory: f.inputs,
      generation: 1,
      updatedAt: d.updatedAt,
      files: [
        {
          name: path.basename(f.video),
          role: "final",
          bytes: (await stat(f.video)).size,
          sha256: digest(await readFile(f.video)),
        },
      ],
    };
    return d;
  });
  f.input.expectedUpdatedAt = bound.updatedAt;
  assert.equal((await f.service.create(f.input)).sources.video, f.video);
});

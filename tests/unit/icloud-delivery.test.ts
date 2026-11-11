import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  realpath,
  writeFile,
  readFile,
  rm,
  symlink,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ContentLibrary,
  ICloudDelivery,
} from "../../src/features/content-library";
import { LocalStore } from "../../src/shared/lib/storage";
import { toSnapshot } from "../../src/shared/data";
import {
  createAgentDispatch,
  type AgentPorts,
} from "../../src/features/agent-tools";
import { AgentSession } from "../../src/entities/agent-session";

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "outbound-")));
  const cloud = path.join(root, "cloud"),
    history = path.join(root, "history");
  await mkdir(cloud);
  await mkdir(path.join(root, "inputs"));
  const store = new LocalStore(path.join(root, "data"));
  await store.initialize();
  const library = new ContentLibrary(store);
  const source = path.join(root, "inputs", "caption.txt");
  await writeFile(source, "version 1");
  const base = {
    id: "test",
    title: "test",
    date: "2026-11-11",
    dateBasis: "record" as const,
    stage: "review" as const,
    nextAction: "",
    publicURL: "",
    localNotes: "",
    resources: [{ role: "document" as const, path: source, label: "caption" }],
  };
  await library.upsert(base, (await store.load()).updatedAt);
  let uploaded = false;
  const native = async (paths: string[]) => ({
    checkedAt: new Date().toISOString(),
    state: uploaded ? ("completed" as const) : ("pending" as const),
    files: paths.map((path) => ({
      path,
      isUbiquitous: true,
      isUploaded: uploaded,
      isUploading: !uploaded,
      isCurrent: true,
    })),
  });
  const make = () => new ICloudDelivery(library, cloud, native, history);
  const service = make(),
    directory = path.join(cloud, "project-outbound");
  const configure = async () =>
    service.configure({
      projectId: "test",
      directory,
      expectedUpdatedAt: (await library.get("test")).updatedAt,
    });
  const input = async () => ({
    projectId: "test",
    expectedUpdatedAt: (await library.get("test")).updatedAt,
    files: [
      { sourcePath: source, name: "post.txt", role: "document" as const },
    ],
  });
  return {
    root,
    cloud,
    history,
    store,
    library,
    source,
    base,
    service,
    directory,
    native,
    make,
    configure,
    input,
    setUploaded: (v = true) => {
      uploaded = v;
    },
  };
}
async function copied(service: ICloudDelivery, id: string) {
  for (let i = 0; i < 200; i++) {
    const j = await service.get(id);
    if (j.state !== "copying") return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("copy timeout");
}
test("one outbound binding persists across restart and is private, unique and immutable", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.start(await f.input()), /NOT_CONFIGURED/);
    await f.configure();
    assert.equal(
      (await f.library.get("test")).project.outbound?.directory,
      f.directory,
    );
    await f.configure();
    await assert.rejects(
      f.service.configure({
        projectId: "test",
        directory: path.join(f.cloud, "version2"),
        expectedUpdatedAt: (await f.library.get("test")).updatedAt,
      }),
      /ALREADY_SET/,
    );
    await f.library.upsert(
      { ...f.base, id: "second" },
      (await f.store.load()).updatedAt,
    );
    await assert.rejects(
      f.service.configure({
        projectId: "second",
        directory: f.directory,
        expectedUpdatedAt: (await f.store.load()).updatedAt,
      }),
      /OUTBOUND_CONFLICT/,
    );
    const restarted = new ContentLibrary(
      new LocalStore(path.join(f.root, "data")),
    );
    assert.equal(
      (await restarted.get("test")).project.outbound?.directory,
      f.directory,
    );
    const dashboard = await f.store.load();
    dashboard.projects[0].shared = true;
    assert.ok(!JSON.stringify(toSnapshot(dashboard)).includes(f.directory));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("repeat delivery replaces stable files, keeps history locally and removes stale managed names", async () => {
  const f = await fixture();
  try {
    await f.configure();
    await assert.rejects(f.library.resolveMedia("test", f.source), /미리보기/);
    const first = await f.service.start(await f.input());
    const pending = await copied(f.service, first.id);
    assert.equal(pending.state, "uploading");
    assert.ok(pending.receiptPath!.startsWith(f.history));
    assert.deepEqual(await readdir(f.directory), ["post.txt"]);
    f.setUploaded();
    assert.equal((await f.service.get(first.id)).state, "completed");
    await writeFile(path.join(f.directory, "unmanaged.txt"), "keep");
    await writeFile(f.source, "version 2");
    const secondService = f.make();
    const second = await secondService.start(await f.input());
    assert.equal((await copied(secondService, second.id)).state, "completed");
    const service = f.make();
    const latest = (await f.library.get("test")).project.outbound!;
    assert.equal(latest.generation, 2);
    assert.equal(
      await readFile(path.join(f.directory, "post.txt"), "utf8"),
      "version 2",
    );
    const receipt = JSON.parse(await readFile(latest.receiptPath!, "utf8"));
    assert.equal(
      await readFile(receipt.archives[0].backup, "utf8"),
      "version 1",
    );
    assert.equal(await readFile(f.source, "utf8"), "version 2");
    const input = await f.input();
    input.files[0].name = "caption.txt";
    const third = await service.start(input);
    assert.equal((await copied(service, third.id)).state, "completed");
    assert.deepEqual((await readdir(f.directory)).sort(), [
      "caption.txt",
      "unmanaged.txt",
    ]);
    assert.equal(
      await readFile(path.join(f.directory, "unmanaged.txt"), "utf8"),
      "keep",
    );
    assert.equal(third.destination, first.destination);
    assert.equal(second.destination, first.destination);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("rejects stale revisions, unregistered sources, path escapes, old destination parameter and symlinks", async () => {
  const f = await fixture();
  try {
    await f.configure();
    const input = await f.input();
    await assert.rejects(
      f.service.start({ ...input, expectedUpdatedAt: "2026-01-01T00:00:00Z" }),
      /STALE/,
    );
    const outside = path.join(f.root, "outside.txt");
    await writeFile(outside, "private");
    await assert.rejects(
      f.service.start({
        ...input,
        files: [{ ...input.files[0], sourcePath: outside }],
      }),
      /등록/,
    );
    await assert.rejects(
      f.service.start({ ...input, destination: path.join(f.cloud, "v2") }),
    );
    await assert.rejects(
      f.service.start({
        ...input,
        files: [{ ...input.files[0], name: "../escape.txt" }],
      }),
    );
    await assert.rejects(
      f.service.start({ ...input, files: [input.files[0], input.files[0]] }),
    );
    await assert.rejects(f.service.status([outside]), /ICLOUD_DESTINATION/);
    const link = path.join(f.cloud, "link.txt");
    await symlink(outside, link);
    await assert.rejects(f.service.status([link]), /심볼릭/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("unmanaged collisions and externally changed managed outputs are never overwritten", async () => {
  const f = await fixture();
  try {
    await mkdir(f.directory);
    await writeFile(path.join(f.directory, "post.txt"), "unmanaged");
    await f.configure();
    const first = await f.service.start(await f.input());
    assert.match((await copied(f.service, first.id)).error!, /COLLISION/);
    assert.equal(
      await readFile(path.join(f.directory, "post.txt"), "utf8"),
      "unmanaged",
    );
    // Explicitly register and adopt in another fixture for the managed-change case.
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
  const g = await fixture();
  try {
    await g.configure();
    g.setUploaded();
    const first = await g.service.start(await g.input());
    await copied(g.service, first.id);
    await writeFile(path.join(g.directory, "post.txt"), "external edit");
    const second = await g.service.start(await g.input());
    assert.match(
      (await copied(g.service, second.id)).error!,
      /OUTBOUND_CHANGED/,
    );
    assert.equal(
      await readFile(path.join(g.directory, "post.txt"), "utf8"),
      "external edit",
    );
    assert.equal((await g.library.get("test")).project.outbound?.generation, 1);
  } finally {
    await rm(g.root, { recursive: true, force: true });
  }
});
test("same-project deliveries serialize and metadata failure rolls back replaced files", async () => {
  const f = await fixture();
  try {
    await f.configure();
    const first = await f.service.start(await f.input());
    await copied(f.service, first.id);
    await assert.rejects(f.service.start(await f.input()), /DELIVERY_BUSY/);
    f.setUploaded();
    await f.service.get(first.id);
    await writeFile(f.source, "version 2");
    const failing = new ICloudDelivery(
      {
        get: f.library.get.bind(f.library),
        resolveDeliverySource: f.library.resolveDeliverySource.bind(f.library),
        configureOutbound: f.library.configureOutbound.bind(f.library),
        completeOutbound: async () => {
          throw new Error("metadata unavailable");
        },
      },
      f.cloud,
      f.native,
      f.history,
    );
    const replacement = await f.input();
    replacement.files[0].name = "renamed.txt";
    const next = await failing.start(replacement);
    assert.match(
      (await copied(failing, next.id)).error!,
      /metadata unavailable/,
    );
    assert.equal(
      await readFile(path.join(f.directory, "post.txt"), "utf8"),
      "version 1",
    );
    assert.equal((await f.library.get("test")).project.outbound?.generation, 1);
    assert.deepEqual(await readdir(f.directory), ["post.txt"]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("MCP configure/start/get use the shared service and protect dirty UI writes", async () => {
  const f = await fixture();
  try {
    const session = new AgentSession(),
      dispatch = createAgentDispatch({
        icloud: f.service,
        session,
      } as unknown as AgentPorts);
    session.update({
      projectId: null,
      dirty: true,
      time: 0,
      active: true,
      busy: false,
    });
    const config = {
      projectId: "test",
      directory: f.directory,
      expectedUpdatedAt: (await f.library.get("test")).updatedAt,
    };
    await assert.rejects(
      dispatch("reels_set_project_outbound", config),
      /EDITOR_BUSY/,
    );
    session.update({
      projectId: null,
      dirty: false,
      time: 0,
      active: false,
      busy: false,
    });
    await dispatch("reels_set_project_outbound", config);
    f.setUploaded();
    const job = (await dispatch(
      "reels_start_icloud_delivery",
      await f.input(),
    )) as { id: string };
    await copied(f.service, job.id);
    assert.equal(
      (
        (await dispatch("reels_get_icloud_delivery", { jobId: job.id })) as {
          state: string;
        }
      ).state,
      "completed",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("adopts only linked outputs and preserves direct-render export history when replacing them", async () => {
  const f = await fixture();
  try {
    await mkdir(f.directory);
    const previous = path.join(f.directory, "video.mp4"),
      source = path.join(f.root, "inputs", "new.mp4");
    await writeFile(previous, "old video");
    await writeFile(source, "new video");
    await f.library.upsert(
      {
        ...f.base,
        resources: [
          { role: "final", path: previous, label: "old output" },
          { role: "draft", path: source, label: "new input" },
        ],
      },
      (await f.library.get("test")).updatedAt,
    );
    const edit = { kind: "video" as const, id: randomUUID() };
    await f.store.update((d) => {
      d.projects[0].production = {
        schemaVersion: 1,
        edits: [edit],
        mergedIds: [],
        exports: [
          {
            id: randomUUID(),
            edit,
            path: previous,
            role: "final",
            recordedAt: new Date().toISOString(),
          },
        ],
      };
      return d;
    });
    await f.configure();
    assert.equal(
      (await f.library.get("test")).project.outbound?.files.length,
      1,
    );
    f.setUploaded();
    const job = await f.service.start({
      projectId: "test",
      expectedUpdatedAt: (await f.library.get("test")).updatedAt,
      files: [{ sourcePath: source, name: "video.mp4", role: "final" }],
    });
    assert.equal((await copied(f.service, job.id)).state, "completed");
    const current = await f.library.get("test");
    assert.equal(await readFile(previous, "utf8"), "new video");
    const oldExport = current.project.production!.exports[0];
    assert.ok(oldExport.path.startsWith(f.history));
    assert.equal(await readFile(oldExport.path, "utf8"), "old video");
    assert.ok(current.resources.every((r) => r.available));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

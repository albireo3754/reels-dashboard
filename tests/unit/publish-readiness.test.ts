import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ContentLibrary,
  ICloudDelivery,
} from "../../src/features/content-library";
import { LocalStore } from "../../src/shared/lib/storage";
import {
  createAgentDispatch,
  toolDefinitions,
  type AgentPorts,
} from "../../src/features/agent-tools";
import { AgentSession } from "../../src/entities/agent-session";
import { evaluatePublishReadiness } from "../../src/shared/publish-readiness";
import type { ICloudUploadStatus } from "../../src/shared/icloud-delivery";

const sha = "a".repeat(64);
const outbound = (roles: Array<"final" | "cover" | "document">) => ({
  directory: "/cloud/out",
  generation: 1,
  files: roles.map((role) => ({ name: `${role}.bin`, role, bytes: 1, sha256: sha })),
});
const disk = (names: string[], ok = true) =>
  names.map((name) => ({ name, present: ok, sizeMatches: ok }));
const upload = (
  paths: string[],
  state: ICloudUploadStatus["state"],
  uploaded: boolean,
): ICloudUploadStatus => ({
  checkedAt: "2026-11-12T00:00:00Z",
  state,
  files: paths.map((p) => ({
    path: p,
    isUbiquitous: true,
    isUploaded: uploaded,
    isUploading: !uploaded,
    isCurrent: true,
  })),
});
const all = ["final.bin", "cover.bin", "document.bin"];
const allPaths = all.map((n) => `/cloud/out/${n}`);

test("readiness is decided in order: published, delivery, roles, files, upload", () => {
  const full = outbound(["final", "cover", "document"]);
  const planned = [{ channel: "instagram" as const, status: "planned" as const, url: "" }];
  assert.equal(
    evaluatePublishReadiness({
      project: {
        id: "p",
        outbound: full,
        publications: [
          { channel: "instagram", status: "published", url: "https://example.com", publishedAt: "2026-11-12" },
        ],
      },
    }).state,
    "published",
  );
  assert.equal(
    evaluatePublishReadiness({ project: { id: "p", publications: planned } }).state,
    "not-delivered",
  );
  assert.equal(
    evaluatePublishReadiness({
      project: { id: "p", outbound: { ...full, generation: 0 } },
    }).state,
    "not-delivered",
  );
  const incomplete = evaluatePublishReadiness({
    project: { id: "p", outbound: outbound(["final", "cover"]) },
    files: disk(["final.bin", "cover.bin"]),
  });
  assert.equal(incomplete.state, "incomplete");
  assert.deepEqual(incomplete.missingRoles, ["document"]);
  assert.match(incomplete.message, /게시글/);
  const changed = evaluatePublishReadiness({
    project: { id: "p", outbound: full },
    files: [...disk(["final.bin", "cover.bin"]), { name: "document.bin", present: true, sizeMatches: false }],
  });
  assert.equal(changed.state, "changed");
  assert.match(changed.message, /document\.bin/);
  const uploading = evaluatePublishReadiness({
    project: { id: "p", outbound: full },
    files: disk(all),
    upload: upload(allPaths, "pending", false),
  });
  assert.equal(uploading.state, "uploading");
  assert.equal(uploading.ready, false);
  assert.equal(
    evaluatePublishReadiness({
      project: { id: "p", outbound: full },
      files: disk(all),
      upload: upload(allPaths, "failed", false),
    }).state,
    "upload-failed",
  );
  const pendingWithError = upload(allPaths, "pending", false);
  pendingWithError.files[0].uploadErrorDescription = "iCloud storage is full";
  const failed = evaluatePublishReadiness({
    project: { id: "p", outbound: full },
    files: disk(all),
    upload: pendingWithError,
  });
  assert.equal(failed.state, "upload-failed");
  assert.match(failed.message, /storage is full/);
  const ready = evaluatePublishReadiness({
    project: { id: "p", outbound: full },
    files: disk(all),
    upload: upload(allPaths, "completed", true),
  });
  assert.equal(ready.state, "ready");
  assert.equal(ready.ready, true);
  assert.ok(ready.files.every((f) => f.isUploaded));
});

test("upload states match outbound paths across NFC/NFD spellings", () => {
  const dir = "/cloud/종합운동장".normalize("NFC");
  const full = { ...outbound(["final", "cover", "document"]), directory: dir };
  const nfd = all.map((n) => `${dir}/${n}`.normalize("NFD"));
  assert.equal(
    evaluatePublishReadiness({
      project: { id: "p", outbound: full },
      files: disk(all),
      upload: upload(nfd, "completed", true),
    }).state,
    "ready",
  );
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "readiness-")));
  const cloud = path.join(root, "cloud"),
    inputs = path.join(root, "inputs");
  await mkdir(cloud);
  await mkdir(inputs);
  const store = new LocalStore(path.join(root, "data"));
  await store.initialize();
  const library = new ContentLibrary(store);
  const sources = {
    final: path.join(inputs, "reel.mp4"),
    cover: path.join(inputs, "cover.png"),
    document: path.join(inputs, "post.txt"),
  };
  await writeFile(sources.final, "video");
  await writeFile(sources.cover, "cover");
  await writeFile(sources.document, "caption");
  await library.upsert(
    {
      id: "reel",
      title: "reel",
      date: "2026-11-12",
      dateBasis: "record",
      stage: "review",
      nextAction: "",
      publicURL: "",
      localNotes: "",
      publications: [{ channel: "instagram", status: "planned", url: "" }],
      resources: [
        { role: "draft", path: sources.final, label: "reel" },
        { role: "cover", path: sources.cover, label: "cover" },
        { role: "document", path: sources.document, label: "post" },
      ],
    },
    (await store.load()).updatedAt,
  );
  let uploaded = false;
  const native = async (paths: string[]) => ({
    checkedAt: new Date().toISOString(),
    state: uploaded ? ("completed" as const) : ("pending" as const),
    files: paths.map((p) => ({
      path: p,
      isUbiquitous: true,
      isUploaded: uploaded,
      isUploading: !uploaded,
      isCurrent: true,
    })),
  });
  const service = new ICloudDelivery(library, cloud, native, path.join(root, "history"));
  const directory = path.join(cloud, "2026-11-12_reel");
  const revision = async () => (await library.get("reel")).updatedAt;
  return {
    root,
    library,
    service,
    directory,
    sources,
    revision,
    setUploaded: (value = true) => {
      uploaded = value;
    },
  };
}
async function delivered(service: ICloudDelivery, id: string) {
  for (let i = 0; i < 200; i++) {
    const j = await service.get(id);
    if (j.state !== "copying") return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("copy timeout");
}

test("service reads the outbound folder, then iCloud, and the MCP tool returns the same", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.service.readiness({ projectId: "reel" })).state, "not-delivered");
    await f.service.configure({ projectId: "reel", directory: f.directory, expectedUpdatedAt: await f.revision() });
    const deliver = async (roles: Array<"final" | "cover" | "document">) => {
      const job = await f.service.start({
        projectId: "reel",
        expectedUpdatedAt: await f.revision(),
        files: roles.map((role) => ({
          sourcePath: f.sources[role],
          name: path.basename(f.sources[role]),
          role,
        })),
      });
      return delivered(f.service, job.id);
    };
    const first = await deliver(["final", "cover"]);
    f.setUploaded();
    assert.equal((await f.service.get(first.id)).state, "completed");
    const partial = await f.service.readiness({ projectId: "reel" });
    assert.equal(partial.state, "incomplete");
    assert.deepEqual(partial.missingRoles, ["document"]);

    f.setUploaded(false);
    await deliver(["final", "cover", "document"]);
    assert.equal((await f.service.readiness({ projectId: "reel" })).state, "uploading");
    f.setUploaded();
    const ready = await f.service.readiness({ projectId: "reel" });
    assert.equal(ready.state, "ready");
    assert.equal(ready.directory, f.directory);
    assert.equal(ready.files.length, 3);

    const ports = {
      icloud: f.service,
      session: new AgentSession(),
    } as unknown as AgentPorts;
    const dispatch = createAgentDispatch(ports);
    assert.equal(toolDefinitions.reels_get_publish_readiness.readOnly, true);
    const viaTool = (await dispatch("reels_get_publish_readiness", { projectId: "reel" })) as { state: string };
    assert.equal(viaTool.state, "ready");
    await assert.rejects(dispatch("reels_get_publish_readiness", { projectId: "reel", channel: "blog" }));

    await writeFile(path.join(f.directory, "post.txt"), "edited on the phone");
    assert.equal((await f.service.readiness({ projectId: "reel" })).state, "changed");
    await rm(path.join(f.directory, "post.txt"));
    assert.equal((await f.service.readiness({ projectId: "reel" })).state, "changed");

    await f.library.setPublication({
      projectId: "reel",
      expectedUpdatedAt: await f.revision(),
      channel: "instagram",
      status: "published",
      url: "https://example.com/reel",
      publishedAt: "2026-11-12",
    });
    assert.equal((await f.service.readiness({ projectId: "reel" })).state, "published");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

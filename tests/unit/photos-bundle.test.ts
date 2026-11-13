import test from "node:test";
import assert from "node:assert/strict";
import { emptyDashboard } from "../../src/shared/contracts";
import type { Dashboard, Project } from "../../src/shared/contracts";
import {
  attachPhotosBundle,
  emptyPhotosImportLedger,
  importPhotosBundle,
  type BundleAsset,
  type PhotosBundleDeps,
  type PhotosImportLedger,
} from "../../src/features/reel-editing/model/photos-bundle";

const card = (id: string, extra: Partial<Project> = {}): Project => ({
  id,
  title: id,
  date: "2026-08-13",
  stage: "captured",
  nextAction: "블로그 초안을 써요.",
  publicURL: "",
  shared: false,
  resources: [],
  ...extra,
});

const group: BundleAsset[] = [
  { id: "v1", mediaKind: "video", publicFilename: "IMG_0001.MOV" },
  { id: "p1", mediaKind: "photo", publicFilename: "IMG_0002.HEIC" },
  { id: "p2", mediaKind: "photo", publicFilename: "IMG_0003.HEIC" },
  { id: "v2", mediaKind: "video", publicFilename: "IMG_0004.MOV" },
];

/** In-memory fakes: files are a Set, the dashboard and ledger plain objects. */
function harness(projects: Project[] = [card("content:sukseongdo")]) {
  let dashboard: Dashboard = {
    ...emptyDashboard(),
    updatedAt: "2026-11-13T00:00:00.000Z",
    projects,
  };
  let ledger: PhotosImportLedger = emptyPhotosImportLedger();
  const files = new Set<string>();
  const edits = new Set<string>();
  const materialized: string[] = [];
  let failOn: string | undefined;
  let editCounter = 0;
  const deps: PhotosBundleDeps = {
    groupAssets: async () => group,
    projectExists: async (id) => dashboard.projects.some((p) => p.id === id),
    loadLedger: async () => structuredClone(ledger),
    saveLedger: async (next) => {
      ledger = structuredClone(next);
    },
    isFile: async (file) => files.has(file),
    editExists: async (id) => edits.has(id),
    materialize: async (assetId) => {
      if (assetId === failOn) throw new Error("iCloud 원본을 받지 못했어요.");
      materialized.push(assetId);
      const asset = group.find((a) => a.id === assetId)!;
      const dir = `/app/native/editor-sources/${materialized.length}`;
      const sourcePath = `${dir}/${asset.publicFilename}`;
      files.add(sourcePath);
      const pairedVideoPath = assetId === "p1" ? `${dir}/IMG_0002-live.mov` : null;
      if (pairedVideoPath) files.add(pairedVideoPath);
      return { assetID: assetId, mediaKind: asset.mediaKind, sourcePath, pairedVideoPath, originalFilename: asset.publicFilename };
    },
    createEdit: async () => {
      const id = `00000000-0000-4000-8000-${String(++editCounter).padStart(12, "0")}`;
      edits.add(id);
      return { id };
    },
    attach: async (mutate) => {
      const next = mutate(structuredClone(dashboard));
      dashboard = { ...next.dashboard, updatedAt: new Date(Date.parse(dashboard.updatedAt) + 1000).toISOString() };
      return { dashboard, owners: next.owners };
    },
    now: () => new Date("2026-11-13T12:00:00.000Z"),
  };
  return {
    deps,
    files,
    edits,
    materialized,
    failOn: (id?: string) => (failOn = id),
    get dashboard() {
      return dashboard;
    },
    set dashboard(value: Dashboard) {
      dashboard = value;
    },
    get ledger() {
      return ledger;
    },
  };
}

const input = { projectId: "content:sukseongdo", groupId: "g", indexRunId: "r" };

test("bundle import copies every photo and video of the group onto one card", async () => {
  const h = harness();
  const result = await importPhotosBundle(input, h.deps);
  assert.deepEqual(h.materialized, ["v1", "p1", "p2", "v2"]);
  assert.equal(result.counts.imported, 4);
  assert.equal(result.counts.photos, 2);
  assert.equal(result.counts.videos, 2);
  assert.equal(result.counts.livePhotos, 1);
  // Every asset lands on the one target card; videos do not get their own card.
  assert.equal(h.dashboard.projects.length, 1);
  const target = h.dashboard.projects[0];
  assert.deepEqual(
    target.resources!.map((r) => [r.role, r.label]),
    [
      ["footage", "IMG_0001.MOV"],
      ["footage", "IMG_0002.HEIC"],
      ["footage", "IMG_0002.HEIC (Live Photo 영상)"],
      ["footage", "IMG_0003.HEIC"],
      ["footage", "IMG_0004.MOV"],
    ],
  );
  const videoEdits = result.items.filter((i) => i.mediaKind === "video").map((i) => i.editId);
  assert.deepEqual(target.production!.edits.map((e) => e.id), videoEdits);
  assert.ok(target.production!.edits.every((e) => e.kind === "video"));
  // Card stage and next action are the card's own; the import does not rewrite them.
  assert.equal(target.stage, "captured");
  assert.equal(target.nextAction, "블로그 초안을 써요.");
  assert.equal(result.dashboardUpdatedAt, h.dashboard.updatedAt);
  assert.equal(Object.keys(h.ledger.assets).length, 4);
});

test("bundle import is idempotent: a second run copies nothing and adds nothing", async () => {
  const h = harness();
  await importPhotosBundle(input, h.deps);
  const before = structuredClone(h.dashboard.projects[0]);
  const again = await importPhotosBundle(input, h.deps);
  assert.equal(h.materialized.length, 4);
  assert.equal(again.counts["already-imported"], 4);
  assert.equal(again.counts.imported, 0);
  assert.deepEqual(h.dashboard.projects[0].resources, before.resources);
  assert.deepEqual(h.dashboard.projects[0].production, before.production);
});

test("a missing copy or edit is copied again instead of reused", async () => {
  const h = harness();
  await importPhotosBundle(input, h.deps);
  h.files.delete(h.ledger.assets.p2.sourcePath);
  h.edits.delete(h.ledger.assets.v2.editId!);
  const again = await importPhotosBundle(input, h.deps);
  assert.deepEqual(h.materialized.slice(4), ["p2", "v2"]);
  assert.equal(again.counts.imported, 2);
  assert.equal(again.counts["already-imported"], 2);
});

test("an asset failure is reported per item and the rest still attach; rerun finishes it", async () => {
  const h = harness();
  h.failOn("p2");
  const first = await importPhotosBundle(input, h.deps);
  assert.equal(first.counts.failed, 1);
  assert.match(first.items.find((i) => i.assetId === "p2")!.error!, /iCloud/);
  assert.equal(h.dashboard.projects[0].resources!.length, 4);
  h.failOn(undefined);
  const second = await importPhotosBundle(input, h.deps);
  assert.equal(second.counts.imported, 1);
  assert.equal(second.counts["already-imported"], 3);
  assert.deepEqual(h.materialized, ["v1", "p1", "v2", "p2"]);
});

test("assetIds limits the import and rejects assets outside the group before copying", async () => {
  const h = harness();
  const subset = await importPhotosBundle({ ...input, assetIds: ["p1"] }, h.deps);
  assert.deepEqual(h.materialized, ["p1"]);
  assert.equal(subset.items.length, 1);
  await assert.rejects(
    importPhotosBundle({ ...input, assetIds: ["p1", "other"] }, h.deps),
    /PHOTOS_ASSET_NOT_IN_GROUP/,
  );
  assert.deepEqual(h.materialized, ["p1"]);
});

test("a missing target card fails before anything is copied", async () => {
  const h = harness();
  await assert.rejects(
    importPhotosBundle({ ...input, projectId: "content:none" }, h.deps),
    /CONTENT_NOT_FOUND/,
  );
  assert.deepEqual(h.materialized, []);
});

test("a video already linked to another card stays there and is reported", async () => {
  const h = harness([card("content:sukseongdo"), card("content:other")]);
  await importPhotosBundle({ ...input, projectId: "content:other", assetIds: ["v1"] }, h.deps);
  const result = await importPhotosBundle(input, h.deps);
  const v1 = result.items.find((i) => i.assetId === "v1")!;
  assert.equal(v1.status, "linked-elsewhere");
  assert.equal(v1.ownerId, "content:other");
  const target = h.dashboard.projects.find((p) => p.id === "content:sukseongdo")!;
  assert.ok(!target.production!.edits.some((e) => e.id === v1.editId));
  assert.ok(!target.resources!.some((r) => r.path === v1.path));
  assert.equal(h.materialized.filter((id) => id === "v1").length, 1);
});

test("attachPhotosBundle keeps existing resources and rejects more than 500", () => {
  const existing = { role: "document" as const, path: "/notes/a.md", label: "메모" };
  const dashboard: Dashboard = { ...emptyDashboard(), projects: [card("c", { resources: [existing] })] };
  const entry = { assetId: "p", mediaKind: "photo" as const, sourcePath: "/x/p.jpg", name: "p.jpg", importedAt: "2026-11-13T00:00:00.000Z" };
  const { dashboard: next } = attachPhotosBundle(dashboard, "c", [entry, entry]);
  assert.deepEqual(next.projects[0].resources, [existing, { role: "footage", path: "/x/p.jpg", label: "p.jpg" }]);
  const many = Array.from({ length: 500 }, (_, i) => ({ ...entry, assetId: `a${i}`, sourcePath: `/x/${i}.jpg` }));
  assert.throws(() => attachPhotosBundle(dashboard, "c", many), /TOO_MANY_RESOURCES/);
});

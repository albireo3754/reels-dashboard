import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseRouteMap, routeBounds } from "../../src/shared/route-map";
import { demoRouteMap } from "../../src/shared/route-map-demo";
import { RouteLibrary } from "../../src/desktop/route-library";
import { LocalStore } from "../../src/shared/lib/storage";
import { ContentLibrary } from "../../src/features/content-library";

test("route DTO strips private fields, rejects invalid coordinates, duplicate names and unordered times", () => {
  const raw = structuredClone(demoRouteMap.data) as any;
  raw.secret = "never transmit"; raw.assets[0].source = "/private/source.mov"; raw.assets[0].thumbnail = "private image";
  const clean = parseRouteMap(raw);
  assert(!JSON.stringify(clean).includes("private"));
  assert(!JSON.stringify(clean).includes("transmit"));
  assert.throws(() => parseRouteMap({ ...raw, assets: [{ ...raw.assets[0], point: [181, 0] }] }));
  assert.throws(() => parseRouteMap({ ...raw, assets: [raw.assets[0], raw.assets[0]] }));
  assert.throws(() => parseRouteMap({ ...raw, assets: [...raw.assets].reverse() }));
  assert.throws(() => parseRouteMap({ ...raw, assets: [{ ...raw.assets[0], name: "../walk.mp4" }] }));
});

test("route bounds ignore uncertain outliers and handle dense geometry without argument overflow", () => {
  const data = structuredClone(demoRouteMap.data);
  data.assets[2].point = [179, 89];
  const b = routeBounds(data); assert(b[2] < 11 && b[3] < 21);
  const all = routeBounds(data, true); assert(all[2] > 179 && all[3] > 89);
  data.legs = Array.from({ length: 20 }, () => ({ points: Array.from({ length: 10000 }, () => [10, 20] as [number, number]), status: "inferred" }));
  assert(routeBounds(data).every(Number.isFinite));
});

test("registered route document resolves only independently authorized media, changes refresh, broken data stays explicit", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "reels-route-test-")));
  try {
    const store = new LocalStore(root); await store.initialize(); const library = new ContentLibrary(store);
    const doc = path.join(root, "route-map-data.json"), media = path.join(root, "walk.mp4"), unrelated = path.join(root, "unlinked.mp4");
    const raw = structuredClone(demoRouteMap.data) as any;
    raw.assets[0].source = media; raw.assets[2].source = unrelated;
    await writeFile(doc, JSON.stringify(raw)); await writeFile(media, "synthetic"); await writeFile(unrelated, "not registered");
    const input = { id: "route-test", title: "Synthetic", date: "2026-10-27", dateBasis: "capture" as const, stage: "selected" as const, nextAction: "", publicURL: "", localNotes: "", resources: [{ role: "document" as const, path: doc, label: "route" }, { role: "footage" as const, path: media, label: "source" }] };
    await library.upsert(input, (await store.load()).updatedAt);
    const service = new RouteLibrary(library); const loaded = await service.load(input.id);
    assert.equal(loaded?.mediaByName["walk.mp4"], media); assert.equal(loaded?.mediaByName["unlinked.mp4"], undefined);
    assert(!JSON.stringify(loaded?.data).includes(root));
    raw.assets[0].section = "updated"; await writeFile(doc, JSON.stringify(raw));
    assert.equal((await service.load(input.id))?.data.assets[0].section, "updated");
    await rm(media); assert.equal((await service.load(input.id))?.mediaByName["walk.mp4"], undefined);
    await writeFile(doc, '{"invalid":true}'); await assert.rejects(service.load(input.id));
    await rm(doc); const replacement = path.join(root, "elsewhere.json"); await writeFile(replacement, JSON.stringify(raw)); await symlink(replacement, doc); await assert.rejects(service.load(input.id), /경로가 변경/);
    await assert.rejects(service.load("unknown"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing route returns null; oversized documents are rejected before parsing", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "reels-route-limit-")));
  try {
    const p = path.join(root, "route-map-data.json"); await writeFile(p, " ".repeat(8 * 1024 * 1024 + 1));
    const project = { id: "test", title: "", date: "", stage: "idea" as const, shared: false, nextAction: "", publicURL: "", resources: [{ role: "document" as const, path: p, label: "" }] };
    const service = new RouteLibrary({ get: async () => ({ project }), resolveMedia: async () => {} });
    await assert.rejects(service.load("test"), /8MB/);
    project.resources = []; assert.equal(await service.load("test"), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

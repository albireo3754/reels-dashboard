// Photos 원본은 기본적으로 손대지 않는다. 대시보드로 영상을 정리하는 기본 경로(MCP·CLI 도구,
// 가져오기)는 읽기·복사만 하고, 원본을 지우는 move는 데스크톱 UI에서 사용자가 직접 고를 때만 실행된다.
// 이 테스트는 move를 막지 않는다. 기본 경로가 복사라는 것만 고정한다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  agentGuidance,
  createAgentDispatch,
  toolDefinitions,
  type AgentPorts,
} from "../../src/features/agent-tools";
import { validateRequest } from "../../src/desktop/native";
import { AgentSession } from "../../src/entities/agent-session";

const readOnlyPhotosMethods = new Set([
  "status",
  "photos.search",
  "photos.search.page",
  "sync",
  "groups.list",
  "groups.show",
  "groups.inspect",
]);

const photosToolArgs: Record<string, unknown> = {
  reels_photos_status: {},
  reels_photos_search: { text: "카페" },
  reels_photos_search_page: { searchId: "search_test", offset: 0, pageSize: 5 },
  reels_photos_index: { date: "2026-08-13" },
  reels_photos_groups: { level: "fine" },
  reels_photos_group: { groupId: "group", indexRunId: "run" },
  reels_photos_inspect: { groupId: "group", indexRunId: "run", page: 1, pageSize: 10 },
  reels_import_photos_video: { groupId: "group", indexRunId: "run", assetId: "asset" },
  reels_import_photos_bundle: { projectId: "content:example", groupId: "group", indexRunId: "run" },
};

test("every agent Photos tool only reads Photos, and the video and bundle imports are copies", async () => {
  const photoTools = Object.keys(toolDefinitions).filter(
    (name) => name.startsWith("reels_photos_") || name.startsWith("reels_import_photos_"),
  );
  // A new Photos tool must be classified here before it ships.
  assert.deepEqual(photoTools.sort(), Object.keys(photosToolArgs).sort());

  const nativeCalls: string[] = [];
  const imports: unknown[] = [];
  const dispatch = createAgentDispatch({
    session: new AgentSession(),
    editor: {
      fromPhotos: async (selection: unknown) => {
        imports.push(selection);
        return { id: "copied-project" };
      },
      importPhotosBundle: async (selection: unknown) => {
        imports.push(selection);
        return { items: [] };
      },
    },
    photos: async (method: string, args: Record<string, string>) => {
      validateRequest(method, args);
      nativeCalls.push(method);
      return { searchId: "search_test", nextOffset: null };
    },
  } as unknown as AgentPorts);

  for (const [name, args] of Object.entries(photosToolArgs))
    await dispatch(name, args);

  assert.ok(nativeCalls.length > 0);
  for (const method of nativeCalls)
    assert.ok(readOnlyPhotosMethods.has(method), `${method} is not a read-only Photos call`);
  assert.deepEqual(imports, [
    { groupID: "group", indexRunID: "run", assetID: "asset" },
    { projectId: "content:example", groupId: "group", indexRunId: "run" },
  ]);
});

test("agent tools expose no Photos move/export execution and say originals stay untouched", () => {
  for (const name of Object.keys(toolDefinitions))
    assert.doesNotMatch(name, /(^|_)(move|delete)(_|$)|photos_export|export_apply/);
  assert.match(agentGuidance, /Photos originals stay untouched by default/);
  assert.match(
    toolDefinitions.reels_import_photos_video.description,
    /Copies the original.*Photos original stays untouched/,
  );
  assert.match(
    toolDefinitions.reels_import_photos_bundle.description,
    /copy every photo and video.*Photos originals stay untouched: read and copy only/,
  );
});

test("desktop copy is the primary plan action and move needs an explicit, cancel-default choice", async () => {
  const library = await readFile("src/renderer/photo-export/LibraryScreen.tsx", "utf8");
  const copy = library.indexOf('onClick={() => createPlan("export")}');
  const move = library.indexOf('onClick={() => createPlan("move")}');
  assert.ok(copy > 0 && move > copy, "copy plan button comes first");
  assert.match(library.slice(library.lastIndexOf("<button", copy), copy), /className="primary"/);
  assert.match(library.slice(library.lastIndexOf("<button", move), move), /className="secondary"/);

  const main = await readFile("src/desktop/main.ts", "utf8");
  const gate = main.slice(main.indexOf('if (method === "move.apply")'));
  assert.match(gate.slice(0, 600), /defaultId: 0,\s*cancelId: 0/);
});

test("PhotoKit writes exist only behind the verified move path, never in copy or import", async () => {
  const root = "native/photosindex/Sources";
  const writeAPI =
    /performChanges|PHAssetChangeRequest|PHAssetCollectionChangeRequest|PHAssetCreationRequest|PHCollectionListChangeRequest|PHContentEditingOutput/;
  const offenders: string[] = [];
  const deleterConstructions: string[] = [];
  const deleteCalls: string[] = [];
  for (const target of await readdir(root)) {
    for (const file of await readdir(path.join(root, target))) {
      if (!file.endsWith(".swift")) continue;
      const rel = `${target}/${file}`;
      const source = await readFile(path.join(root, target, file), "utf8");
      if (writeAPI.test(source) && rel !== "PhotosIndexPhotos/PhotoKitAssetDeleter.swift")
        offenders.push(rel);
      if (/PhotoKitAssetDeleter\(\)/.test(source) && !/^public struct PhotoKitAssetDeleter/m.test(source))
        deleterConstructions.push(rel);
      if (/\.delete\(targets:/.test(source)) deleteCalls.push(rel);
    }
  }
  assert.deepEqual(offenders, []);
  assert.deepEqual(deleterConstructions, ["PhotosIndexApp/ExportCommandService.swift"]);
  assert.deepEqual(deleteCalls, ["PhotosIndexExport/MoveApplier.swift"]);
});

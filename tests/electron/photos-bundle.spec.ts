import { test, expect, type ElectronApplication } from "@playwright/test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { access, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { launchApp, closeApp, makeProfile, cleanProfile } from "./helpers";

// REELS_PHOTOS_DEMO_QA stands in for Photos: the demo group mixes photos and videos and
// the demo materializer writes synthetic copies, so no Photos library is read
// or written. Videos still go through the real editor import (probe).
test.describe("Photos bundle import over MCP", () => {
  test.skip(
    process.env.REELS_EDITOR_QA !== "1",
    "Requires bundled editor runtime and synthetic media only.",
  );
  test.setTimeout(180_000);
  let app: ElectronApplication | undefined,
    client: Client,
    transport: StdioClientTransport,
    profile: string;
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool(
      { name, arguments: args },
      { timeout: 170_000 },
    );
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result.structuredContent as any;
  }
  test.beforeEach(async () => {
    profile = await makeProfile();
    app = await launchApp(profile, false, { REELS_PHOTOS_DEMO_QA: "1" });
    await app.firstWindow();
    await expect
      .poll(() =>
        access(path.join(profile, "agent/connection.json")).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    client = new Client({ name: "reels-photos-bundle-qa", version: "1" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("dist-mcp/server.mjs")],
      env: { ...(process.env as Record<string, string>), REELS_USER_DATA: profile },
      maxBufferSize: 64 * 1024 * 1024,
    });
    await client.connect(transport);
  });
  test.afterEach(async () => {
    await client?.close();
    await transport?.close();
    await closeApp(app);
    app = undefined;
    await cleanProfile(profile);
  });

  test("copies a whole group onto one card, links videos without new cards, and reruns without copying", async () => {
    await call("reels_upsert_content", {
      expectedUpdatedAt: (await call("reels_list_projects")).dashboard.updatedAt,
      content: {
        id: "content:bundle-qa",
        title: "묶음 가져오기 QA",
        date: "2026-08-13",
        dateBasis: "capture",
        stage: "captured",
        nextAction: "블로그 초안을 써요.",
        publicURL: "",
        localNotes: "",
        resources: [],
      },
    });
    const run = await call("reels_photos_index", { date: "2026-08-13" });
    const groups = await call("reels_photos_groups", { level: "fine" });
    const group = groups.groups[0];
    const detail = await call("reels_photos_group", { groupId: group.id, indexRunId: run.indexRunID });
    const photos = detail.assets.filter((a: any) => a.mediaKind === "photo").length;
    const videos = detail.assets.filter((a: any) => a.mediaKind === "video").length;
    expect(photos).toBeGreaterThan(0);
    expect(videos).toBeGreaterThan(0);

    const input = { projectId: "content:bundle-qa", groupId: group.id, indexRunId: run.indexRunID };
    const first = await call("reels_import_photos_bundle", input);
    expect(first.counts).toMatchObject({ imported: photos + videos, failed: 0, photos, videos, livePhotos: 1 });

    const sources = await realpath(path.join(profile, "native/editor-sources"));
    const copies = (await readdir(sources)).length;
    expect(copies).toBe(photos + videos);

    const listed = await call("reels_list_projects");
    // No card per video: the target card is the only one.
    expect(listed.dashboard.projects.map((p: any) => p.id)).toEqual(["content:bundle-qa"]);
    const card = listed.dashboard.projects[0];
    expect(card.stage).toBe("captured");
    expect(card.resources).toHaveLength(photos + videos + 1);
    for (const resource of card.resources) {
      expect(resource.role).toBe("footage");
      expect(resource.path.startsWith(sources + path.sep)).toBe(true);
    }
    expect(card.resources.filter((r: any) => r.label.endsWith("(Live Photo 영상)"))).toHaveLength(1);
    const edits = await call("reels_list_project_edits");
    const owned = (edits.result ?? edits.edits ?? edits).filter((e: any) => e.ownerId === "content:bundle-qa");
    expect(owned).toHaveLength(videos);

    // Editing a bundled video updates the same card instead of creating one.
    const editId = first.items.find((i: any) => i.mediaKind === "video").editId;
    const project = await call("reels_get_project", { projectId: editId });
    await call("reels_update_project", {
      projectId: editId,
      expectedUpdatedAt: project.updatedAt,
      patch: { place: { name: "예시 장소", description: "묶음 QA" } },
    });
    const edited = (await call("reels_list_projects")).dashboard.projects;
    expect(edited.map((p: any) => p.id)).toEqual(["content:bundle-qa"]);
    expect(edited[0].resources).toHaveLength(card.resources.length);

    const second = await call("reels_import_photos_bundle", input);
    expect(second.counts).toMatchObject({ imported: 0, "already-imported": photos + videos, failed: 0 });
    expect((await readdir(sources)).length).toBe(copies);
    const after = (await call("reels_list_projects")).dashboard.projects;
    expect(after).toHaveLength(1);
    expect(after[0].resources).toEqual(edited[0].resources);
  });

  test("rejects a missing card and assets outside the group before copying", async () => {
    await call("reels_upsert_content", {
      expectedUpdatedAt: (await call("reels_list_projects")).dashboard.updatedAt,
      content: {
        id: "content:bundle-qa", title: "QA", date: "2026-08-13", dateBasis: "capture",
        stage: "captured", nextAction: "", publicURL: "", localNotes: "", resources: [],
      },
    });
    const run = await call("reels_photos_index", { date: "2026-08-13" });
    const group = (await call("reels_photos_groups", { level: "fine" })).groups[0];
    for (const args of [
      { projectId: "content:none", groupId: group.id, indexRunId: run.indexRunID },
      { projectId: "content:bundle-qa", groupId: group.id, indexRunId: run.indexRunID, assetIds: ["not-in-group"] },
    ]) {
      const result = await client.callTool({ name: "reels_import_photos_bundle", arguments: args });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/CONTENT_NOT_FOUND|PHOTOS_ASSET_NOT_IN_GROUP/);
    }
    await expect(readdir(path.join(profile, "native/editor-sources"))).rejects.toThrow();
  });
});

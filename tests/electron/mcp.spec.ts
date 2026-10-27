import { test, expect, type ElectronApplication } from "@playwright/test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { launchApp, closeApp, makeProfile, cleanProfile } from "./helpers";

const execute = promisify(execFile);
const runtime = process.env.REELS_ELECTRON_EXECUTABLE
  ? path.resolve(
      path.dirname(process.env.REELS_ELECTRON_EXECUTABLE),
      "../Resources/editor-runtime",
    )
  : path.resolve("native/editor-engine/.build/runtime");
const digest = async (file: string) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
const exists = async (file: string) => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

test.describe("real MCP to Electron editor", () => {
  test.skip(
    process.env.REELS_EDITOR_QA !== "1",
    "Requires bundled editor runtime and synthetic media only.",
  );
  test.setTimeout(180_000);
  let app: ElectronApplication | undefined,
    client: Client,
    transport: StdioClientTransport,
    profile: string;
  async function connect() {
    client = new Client({ name: "reels-electron-qa", version: "1" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("dist-mcp/server.mjs")],
      env: {
        ...(process.env as Record<string, string>),
        REELS_USER_DATA: profile,
      },
      maxBufferSize: 64 * 1024 * 1024,
    });
    await client.connect(transport);
  }
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool(
      { name, arguments: args },
      { timeout: 120_000 },
    );
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result.structuredContent as any;
  }
  async function video(name: string, seconds: number) {
    const file = path.join(profile, name);
    await execute(path.join(runtime, "bin/ffmpeg"), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=720x1280:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440",
      "-t",
      String(seconds),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      file,
    ]);
    return file;
  }
  test.beforeEach(async () => {
    profile = await makeProfile();
    app = await launchApp(profile, false);
    await app.firstWindow();
    await expect
      .poll(() => exists(path.join(profile, "agent/connection.json")))
      .toBe(true);
    await connect();
  });
  test.afterEach(async () => {
    if (client) {
      const state = await client
        .callTool({ name: "reels_get_app_state", arguments: {} })
        .catch(() => null);
      for (const job of ((state?.structuredContent as any)?.jobs as any[]) ??
        []) {
        if (job.state === "running")
          await client
            .callTool({
              name: "reels_cancel_render",
              arguments: { jobId: job.id },
            })
            .catch(() => {});
      }
      await client.close();
      await transport.close();
    }
    await closeApp(app);
    app = undefined;
    await cleanProfile(profile);
  });
  test("imports, patches, previews, renders and reconnects with UI consistency and source preservation", async ({}, info) => {
    const input = await video("합성 원본.mp4", 3),
      original = await digest(input);
    let project = await call("reels_import_video", { sourcePath: input });
    const initial = structuredClone(project);
    project = await call("reels_update_project", {
      projectId: project.id,
      expectedUpdatedAt: project.updatedAt,
      patch: {
        place: {
          name: "예시 공원",
          description: "산책하는 장면",
          x: 0.5,
          y: 0.22,
        },
        cover: { hook: "예시 영상\n미리보기", time: 0.75 },
        captions: {
          items: [
            {
              id: "first",
              start: 0.2,
              end: 2,
              text: "합성 영상으로 확인해요.",
            },
          ],
        },
      },
    });
    const stale = await client.callTool({
      name: "reels_update_project",
      arguments: {
        projectId: project.id,
        expectedUpdatedAt: initial.updatedAt,
        patch: { cover: { hook: "old" } },
      },
    });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.content)).toContain("STALE_PROJECT");
    await call("reels_open_project", { projectId: project.id });
    const page = await app!.firstWindow();
    await expect(page.getByLabel("장소명", { exact: true })).toHaveValue(
      "예시 공원",
    );
    await expect
      .poll(async () => (await call("reels_get_app_state")).context.projectId)
      .toBe(project.id);
    project = await call("reels_update_project", {
      projectId: project.id,
      expectedUpdatedAt: project.updatedAt,
      patch: { place: { description: "변경한 설명" } },
    });
    await expect(page.getByLabel("장소 설명", { exact: true })).toHaveValue(
      "변경한 설명",
    );
    expect(project.settings.cover.time).toBe(0.75);
    await page.getByLabel("장소 설명", { exact: true }).fill("사용자 편집 중");
    await expect
      .poll(async () => (await call("reels_get_app_state")).context.dirty)
      .toBe(true);
    const dirty = await client.callTool({
      name: "reels_update_project",
      arguments: {
        projectId: project.id,
        expectedUpdatedAt: project.updatedAt,
        patch: { place: { description: "덮어쓰기" } },
      },
    });
    expect(dirty.isError).toBe(true);
    expect(JSON.stringify(dirty.content)).toContain("EDITOR_BUSY");
    await expect(page.getByLabel("장소 설명", { exact: true })).toHaveValue(
      "사용자 편집 중",
    );
    await page
      .getByRole("button", { name: "편집 설정 저장", exact: true })
      .click();
    await expect
      .poll(async () => (await call("reels_get_app_state")).context.dirty)
      .toBe(false);
    project = await call("reels_get_project", { projectId: project.id });
    expect(project.settings.place.description).toBe("사용자 편집 중");
    for (const kind of ["video", "cover"] as const) {
      const preview = await client.callTool({
        name: "reels_preview_frame",
        arguments: {
          projectId: project.id,
          expectedUpdatedAt: project.updatedAt,
          kind,
          time: 1,
        },
      });
      expect(preview.isError, JSON.stringify(preview.content)).not.toBe(true);
      const image = preview.content.find((c) => c.type === "image") as {
        data: string;
      };
      expect(image).toBeTruthy();
      const bytes = Buffer.from(image.data, "base64");
      expect(bytes.subarray(1, 4).toString()).toBe("PNG");
      expect((preview.structuredContent as any)?.manifest).toBeTruthy();
      await info.attach(`mcp-${kind}.png`, {
        body: bytes,
        contentType: "image/png",
      });
      const dimensions = await page.evaluate(async (data) => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        return [image.naturalWidth, image.naturalHeight];
      }, image.data);
      expect(dimensions).toEqual([720, 1280]);
    }
    const output = path.join(profile, "합성 출력.mp4");
    const job = await call("reels_start_render", {
      projectId: project.id,
      expectedUpdatedAt: project.updatedAt,
      target: "both",
      outputPath: output,
    });
    // Disconnecting the MCP process must not stop an app-owned job.
    await client.close();
    await transport.close();
    await connect();
    let final: any;
    await expect
      .poll(
        async () => {
          final = await call("reels_get_render_job", { jobId: job.id });
          return final.state;
        },
        { timeout: 90_000 },
      )
      .toBe("completed");
    expect(await exists(final.coverPath)).toBe(true);
    expect(final.manifestPaths).toHaveLength(2);
    const probe = JSON.parse(
      (
        await execute(path.join(runtime, "bin/ffprobe"), [
          "-v",
          "error",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          output,
        ])
      ).stdout,
    );
    expect(probe.streams.some((s: any) => s.codec_type === "audio")).toBe(true);
    expect(Number(probe.format.duration)).toBeCloseTo(3, 1);
    expect(await digest(input)).toBe(original);
    project = await call("reels_get_project", { projectId: project.id });
    const overwrite = await client.callTool({
      name: "reels_start_render",
      arguments: {
        projectId: project.id,
        expectedUpdatedAt: project.updatedAt,
        target: "video",
        outputPath: output,
      },
    });
    expect(overwrite.isError).toBe(true);
    await closeApp(app);
    app = undefined;
    const offline = await client.callTool({
      name: "reels_get_app_state",
      arguments: {},
    });
    expect(offline.isError).toBe(true);
    app = await launchApp(profile, false);
    await app.firstWindow();
    await expect
      .poll(() => exists(path.join(profile, "agent/connection.json")))
      .toBe(true);
    const restored = await call("reels_get_project", { projectId: project.id });
    expect(restored.settings).toEqual(project.settings);
    const reused = await call("reels_import_video", {
      sourcePath: input,
      reuse: { projectId: project.id, expectedUpdatedAt: restored.updatedAt },
    });
    expect(reused.id).not.toBe(project.id);
    expect(reused.settings).toEqual(restored.settings);
    const cover = await call("reels_start_render", {
      projectId: reused.id,
      expectedUpdatedAt: reused.updatedAt,
      target: "cover",
      outputPath: path.join(profile, "표지만.png"),
    });
    await expect
      .poll(
        async () =>
          (await call("reels_get_render_job", { jobId: cover.id })).state,
        { timeout: 30_000 },
      )
      .toBe("completed");
    expect(await exists(path.join(profile, "표지만.png"))).toBe(true);
  });
  test("cancels a real render process and retains source media", async () => {
    const input = await video("취소 원본.mp4", 30),
      before = await digest(input);
    let project = await call("reels_import_video", { sourcePath: input });
    project = await call("reels_update_project", {
      projectId: project.id,
      expectedUpdatedAt: project.updatedAt,
      patch: { place: { name: "예시", material: "none" } },
    });
    const output = path.join(profile, "취소 출력.mp4");
    const job = await call("reels_start_render", {
      projectId: project.id,
      expectedUpdatedAt: project.updatedAt,
      target: "video",
      outputPath: output,
    });
    await expect
      .poll(
        async () =>
          (await call("reels_get_render_job", { jobId: job.id })).progress,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    const cancelled = await call("reels_cancel_render", { jobId: job.id });
    expect(cancelled.state).toBe("cancelled");
    expect(await exists(output)).toBe(false);
    expect(await digest(input)).toBe(before);
    expect((await call("reels_get_app_state")).busy).toBe(false);
  });
});

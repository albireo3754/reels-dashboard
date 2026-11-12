import { test, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { editorRuntime, launchApp, closeApp, makeProfile, cleanProfile } from "./helpers";

const execute = promisify(execFile);
const runtime = editorRuntime();

test("board video converts to a silent looping GIF through the UI and the real MCP tool", async ({}, info) => {
  test.setTimeout(180_000);
  const profile = await realpath(await makeProfile());
  const footage = path.join(profile, "촬영본");
  await mkdir(footage);
  const video = path.join(footage, "건배.mov");
  // Synthetic 10-bit HLG HEVC with audio and a 90° display matrix; no personal media.
  const plain = path.join(profile, "plain.mov");
  await execute(path.join(runtime, "bin/ffmpeg"), ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx265",
    "-x265-params", "log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc",
    "-pix_fmt", "yuv420p10le", "-color_trc", "arib-std-b67", "-color_primaries", "bt2020", "-colorspace", "bt2020nc",
    "-tag:v", "hvc1", "-c:a", "aac", "-shortest", plain]);
  await execute(path.join(runtime, "bin/ffmpeg"), ["-y", "-v", "error", "-display_rotation:v:0", "90", "-i", plain, "-map", "0", "-c", "copy", video]);
  const original = await readFile(video);
  await writeFile(
    path.join(profile, "dashboard.json"),
    JSON.stringify({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      projects: [
        {
          id: "gif-local",
          title: "합성 블로그 동작 영상",
          date: "2026-11-12",
          dateBasis: "capture",
          stage: "review",
          nextAction: "동작 영상을 GIF로 만들어요.",
          publicURL: "",
          shared: false,
          resources: [{ role: "draft", path: video, label: "건배 영상" }],
        },
      ],
    }),
  );
  const app = await launchApp(profile, false);
  const client = new Client({ name: "gif-convert-qa", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist-mcp/server.mjs")],
    env: { ...(process.env as Record<string, string>), REELS_USER_DATA: profile },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("heading", { name: "합성 블로그 동작 영상", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "건배 영상 미리보기", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("건배 영상 재생")).toBeVisible({ timeout: 30_000 });

    const uiOutput = path.join(footage, "건배.gif");
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, uiOutput);
    await dialog.getByRole("button", { name: "무음 GIF 만들기", exact: true }).click();
    const status = dialog.getByRole("status").filter({ hasText: "GIF 저장:" });
    await expect(status).toBeVisible({ timeout: 60_000 });
    await expect(status).toContainText("건배.gif · 2초 · 180×320 · 15fps");
    await dialog.screenshot({ path: info.outputPath("board-gif.png") });
    expect((await readFile(uiOutput)).subarray(0, 6).toString()).toBe("GIF89a");

    await expect
      .poll(() => access(path.join(profile, "agent/connection.json")).then(() => true, () => false))
      .toBe(true);
    await client.connect(transport);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("reels_convert_gif");
    const mcpOutput = path.join(profile, "mcp.gif");
    const result = await client.callTool(
      { name: "reels_convert_gif", arguments: { sourcePath: video, outputPath: mcpOutput, start: 0.5, width: 120, fps: 10 } },
      { timeout: 120_000 },
    );
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    const data = result.structuredContent as any;
    expect(data).toMatchObject({
      outputPath: mcpOutput,
      width: 120,
      height: 214,
      fps: 10,
      durationSeconds: 1.5,
      accel: "videotoolbox",
      hdrToSDR: true,
      loop: "infinite",
      audio: "removed",
    });
    expect(data.bytes).toBe((await stat(mcpOutput)).size);
    const crop = { x: 0, y: 0.15, width: 1, height: 0.85 };
    const cropped = await client.callTool(
      { name: "reels_convert_gif", arguments: { sourcePath: video, outputPath: path.join(profile, "crop.gif"), crop } },
      { timeout: 120_000 },
    );
    expect(cropped.isError, JSON.stringify(cropped.content)).not.toBe(true);
    expect(cropped.structuredContent).toMatchObject({
      width: 180,
      height: 272,
      accel: "videotoolbox",
      crop: { ...crop, pixels: { x: 0, y: 48, width: 180, height: 272 } },
    });
    const badCrop = await client.callTool({ name: "reels_convert_gif", arguments: { sourcePath: video, outputPath: path.join(profile, "bad.gif"), crop: { ...crop, height: 0.9 } } });
    expect(badCrop.isError).toBe(true);
    const again = await client.callTool({ name: "reels_convert_gif", arguments: { sourcePath: video, outputPath: mcpOutput } });
    expect(again.isError).toBe(true);
    expect(JSON.stringify(again.content)).toContain("GIF_OUTPUT_EXISTS");
    expect(await readFile(video)).toEqual(original);
  } finally {
    await client.close().catch(() => undefined);
    await closeApp(app);
    await cleanProfile(profile);
  }
});

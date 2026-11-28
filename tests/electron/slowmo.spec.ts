import { test, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/client";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { editorRuntime, launchApp, closeApp, makeProfile, cleanProfile, mcpTransport } from "./helpers";

const execute = promisify(execFile);
const runtime = editorRuntime();

// Frame counts on disk, source immutability and refusing an existing output are checked in
// tests/unit/slowmo.test.ts; this spec covers the board button and the real MCP job tools.
test("board video becomes a GPU slow-motion copy through the UI and the real MCP job tools", async ({}, info) => {
  // Hosted macOS runners are VMs without the GPU/Neural Engine Vision optical flow needs.
  test.skip(process.env.GITHUB_ACTIONS === "true", "hosted CI VM has no Vision optical flow");
  test.setTimeout(180_000);
  const profile = await realpath(await makeProfile());
  const footage = path.join(profile, "촬영본");
  await mkdir(footage);
  const video = path.join(footage, "거리.mov");
  // Synthetic SDR clip with a 90° display matrix; no personal media.
  const plain = path.join(profile, "plain.mov");
  await execute(path.join(runtime, "bin/ffmpeg"), ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "h264_videotoolbox", "-b:v", "2M", "-c:a", "aac", "-shortest", plain]);
  await execute(path.join(runtime, "bin/ffmpeg"), ["-y", "-v", "error", "-display_rotation:v:0", "90", "-i", plain, "-map", "0", "-c", "copy", video]);
  await writeFile(
    path.join(profile, "dashboard.json"),
    JSON.stringify({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      projects: [
        {
          id: "slowmo-local",
          title: "합성 슬로우 영상",
          date: "2026-11-27",
          dateBasis: "capture",
          stage: "review",
          nextAction: "거리 영상을 슬로우로 만들어요.",
          publicURL: "",
          shared: false,
          resources: [{ role: "footage", path: video, label: "거리 영상" }],
        },
      ],
    }),
  );
  const app = await launchApp(profile, false);
  const client = new Client({ name: "slowmo-qa", version: "1" });
  const transport = mcpTransport(profile);
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("region", { name: "진행 중인 작업" }).getByRole("heading", { name: "합성 슬로우 영상", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "거리 영상 미리보기", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("거리 영상 재생")).toBeVisible({ timeout: 30_000 });

    const uiOutput = path.join(footage, "거리-slow50.mov");
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, uiOutput);
    await dialog.getByLabel("시작(초)").fill("0.5");
    await dialog.getByLabel("끝(초)").fill("1.5");
    await dialog.getByRole("button", { name: "부드러운 슬로우 만들기", exact: true }).click();
    const status = dialog.getByRole("status").filter({ hasText: "슬로우 저장:" });
    await expect(status).toBeVisible({ timeout: 90_000 });
    await expect(status).toContainText("거리-slow50.mov · 0.5배 · 2초 · 180×320 · 30fps");
    await dialog.screenshot({ path: info.outputPath("board-slowmo.png") });

    await expect
      .poll(() => access(path.join(profile, "agent/connection.json")).then(() => true, () => false))
      .toBe(true);
    await client.connect(transport);
    const mcpOutput = path.join(profile, "mcp-slow.mp4");
    const started = await client.callTool({ name: "reels_start_slowmo", arguments: { sourcePath: video, outputPath: mcpOutput, speed: 0.25, end: 1 } });
    expect(started.isError, JSON.stringify(started.content)).not.toBe(true);
    const jobId = (started.structuredContent as any).id as string;
    let job: any;
    await expect
      .poll(async () => {
        job = (await client.callTool({ name: "reels_get_slowmo_job", arguments: { jobId } })).structuredContent;
        return job.state;
      }, { timeout: 90_000 })
      .toBe("succeeded");
    expect(job.result).toMatchObject({ outputPath: mcpOutput, speed: 0.25, fps: 30, frames: 120, width: 180, height: 320, codec: "h264", audio: "removed" });
  } finally {
    await client.close().catch(() => undefined);
    await closeApp(app);
    await cleanProfile(profile);
  }
});

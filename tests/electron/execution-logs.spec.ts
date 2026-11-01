import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { ExecutionLogs } from "../../src/shared/lib/execution-logs";
import { launchApp, makeProfile, closeApp, cleanProfile } from "./helpers";

test("app media logs are visible, scoped, persistent and distinguish failed/interrupted work", async ({}, info) => {
  const profile = await makeProfile();
  let app;
  try {
    // A previously interrupted SDK observation, not an arbitrary OS process.
    const ledger = new ExecutionLogs(profile);
    const interrupted = ledger.start({
      source: "editor",
      label: "이전 영상 처리",
      executable: "reels-editor",
    });
    const video = path.join(profile, "synthetic.mp4");
    await promisify(execFile)(
      path.resolve("native/editor-engine/.build/runtime/bin/ffmpeg"),
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x240:rate=10:duration=0.3",
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-pix_fmt",
        "yuv420p",
        video,
      ],
    );
    app = await launchApp(profile, false);
    let page = await app.firstWindow();
    expect(
      await page.evaluate(() => window.reels!.executionLogs!.list()),
    ).toHaveLength(1);
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    }, video);
    const project = await page.evaluate(() =>
      window.reels!.editor.chooseVideo(),
    );
    expect(project).toBeTruthy();
    const rows = await page.evaluate(() => window.reels!.executionLogs!.list());
    expect(
      rows.some(
        (r) =>
          r.label === "편집용 재생 영상 준비" &&
          r.status === "completed" &&
          r.exitCode === 0,
      ),
    ).toBeTruthy();
    expect(rows.find((r) => r.id === interrupted)?.status).toBe("interrupted");
    // The external test-fixture ffmpeg did not enter the app ledger.
    expect(rows.every((r) => r.executable === "reels-editor")).toBeTruthy();
    const invalid = path.join(profile, "invalid.mp4");
    await writeFile(invalid, "not a video");
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    }, invalid);
    await page.evaluate(() =>
      window.reels!.editor.chooseVideo().catch(() => null),
    );
    await page.getByRole("button", { name: "실행 로그", exact: true }).click();
    const panel = page.getByRole("region", { name: "실행 로그", exact: true });
    await expect(panel.getByText("실패", { exact: true })).toBeVisible();
    await expect(panel.getByText("관측 중단", { exact: true })).toBeVisible();
    await panel.getByText("실행 상세와 로그", { exact: true }).first().click();
    await expect(
      panel.getByText("종료 코드", { exact: true }).first(),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath("execution-logs.png"),
      fullPage: true,
    });
    await panel
      .getByLabel("로그 표시", { exact: true })
      .selectOption("running");
    await expect(panel.getByText("표시할 실행 기록이 없어요.")).toBeVisible();
    const count = (
      await page.evaluate(() => window.reels!.executionLogs!.list())
    ).length;
    await closeApp(app);
    app = undefined;
    app = await launchApp(profile, false);
    page = await app.firstWindow();
    const after = await page.evaluate(() =>
      window.reels!.executionLogs!.list(),
    );
    expect(after).toHaveLength(count);
    expect(after.some((r) => r.status === "completed")).toBeTruthy();
    expect(after.some((r) => r.status === "failed")).toBeTruthy();
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

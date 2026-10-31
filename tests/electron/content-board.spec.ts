import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, realpath, mkdir, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { launchApp, makeProfile, closeApp, cleanProfile } from "./helpers";
const execute = promisify(execFile);
test("packaged board previews actual images, plays/seek videos, browses folders and reports missing media", async ({}, info) => {
  test.setTimeout(90_000);
  const profile = await realpath(await makeProfile());
  const runtime = process.env.REELS_ELECTRON_EXECUTABLE
    ? path.resolve(
        path.dirname(process.env.REELS_ELECTRON_EXECUTABLE),
        "../Resources/editor-runtime",
      )
    : path.resolve("native/editor-engine/.build/runtime");
  const footage = path.join(profile, "촬영본");
  await mkdir(footage);
  const video = path.join(footage, "산책 영상.mov");
  const cover = path.join(profile, "표지.png");
  await execute(path.join(runtime, "bin/ffmpeg"), [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=720x1280:rate=24:duration=1.5",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    video,
  ]);
  await execute(path.join(runtime, "bin/ffmpeg"), [
    "-v",
    "error",
    "-i",
    video,
    "-frames:v",
    "1",
    cover,
  ]);
  const original = createHash("sha256")
    .update(await readFile(video))
    .digest("hex");
  await writeFile(
    path.join(profile, "dashboard.json"),
    JSON.stringify({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      projects: [
        {
          id: "board-local",
          title: "합성 촬영 콘텐츠",
          date: "2026-10-28",
          dateBasis: "capture",
          stage: "review",
          nextAction: "시안과 표지를 확인해요.",
          publicURL: "",
          shared: false,
          resources: [
            { role: "draft", path: video, label: "편집 시안" },
            { role: "cover", path: cover, label: "표지 이미지" },
            { role: "folder", path: footage, label: "촬영 폴더" },
          ],
        },
      ],
    }),
  );
  const app = await launchApp(profile, false);
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "합성 촬영 콘텐츠", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("img", { name: "표지 이미지 썸네일" }).first(),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath("content-board.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "편집 시안 미리보기", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    const player = dialog.getByLabel("편집 시안 재생");
    await expect(player).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => player.evaluate((n) => (n as HTMLVideoElement).readyState))
      .toBeGreaterThan(0);
    await player.evaluate((n) => {
      (n as HTMLVideoElement).currentTime = 0.6;
    });
    await expect
      .poll(() => player.evaluate((n) => (n as HTMLVideoElement).currentTime))
      .toBeCloseTo(0.6, 1);
    const url = await player.getAttribute("src");
    const stream = await page.evaluate(async (url) => {
      const r = await fetch(url!, { headers: { Range: "bytes=0-63" } });
      return { status: r.status, bytes: (await r.arrayBuffer()).byteLength };
    }, url);
    expect(stream).toEqual({ status: 206, bytes: 64 });
    await dialog
      .getByRole("button", { name: "표지 이미지 보기", exact: true })
      .click();
    await expect(
      dialog.getByRole("img", { name: "표지 이미지", exact: true }),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "촬영 폴더 폴더 열기", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "산책 영상.mov 보기", exact: true })
      .click();
    await expect(dialog.getByLabel("산책 영상.mov 재생")).toBeVisible();
    await dialog.screenshot({ path: info.outputPath("content-viewer.png") });
    await page
      .getByRole("button", { name: "미디어 닫기", exact: true })
      .click();
    expect(
      createHash("sha256")
        .update(await readFile(video))
        .digest("hex"),
    ).toBe(original);
    const blocked = await page.evaluate(
      async (file) => {
        try {
          await window.reels!.contentMedia!.open("board-local", file);
          return false;
        } catch {
          return true;
        }
      },
      path.join(profile, "dashboard.json"),
    );
    expect(blocked).toBe(true);
    await unlink(cover);
    await page
      .getByRole("button", {
        name: "합성 촬영 콘텐츠 미디어 보기",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("button", { name: "표지 이미지 보기", exact: true }),
    ).toBeDisabled();
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

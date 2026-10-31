import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { launchApp, makeProfile, closeApp, cleanProfile } from "./helpers";
const execute = promisify(execFile);

test("video background trims, previews motion, saves, mixes with still and exports", async ({}, info) => {
  test.setTimeout(180000);
  const profile = await makeProfile();
  const runtime = process.env.REELS_ELECTRON_EXECUTABLE
    ? path.resolve(
        path.dirname(process.env.REELS_ELECTRON_EXECUTABLE),
        "../Resources/editor-runtime",
      )
    : path.resolve("native/editor-engine/.build/runtime");
  const ffmpeg = path.join(runtime, "bin/ffmpeg"),
    ffprobe = path.join(runtime, "bin/ffprobe");
  const video = path.join(profile, "moving.mp4"),
    still = path.join(profile, "still.png"),
    output = path.join(profile, "mixed.mp4");
  let app;
  try {
    await execute(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=270x480:r=30:d=3",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      video,
    ]);
    await execute(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=blue:s=1080x1920",
      "-frames:v",
      "1",
      still,
    ]);
    app = await launchApp(profile, false);
    await app.evaluate(
      ({ dialog }, files) => {
        dialog.showOpenDialog = async (...args: any[]) => ({
          canceled: false,
          filePaths: [
            args.at(-1).filters[0].extensions.includes("mov")
              ? files.video
              : files.still,
          ],
        });
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath: files.output,
        });
      },
      { video, still, output },
    );
    const page = await app.firstWindow();
    await page
      .getByRole("button", { name: "카드뉴스 릴스", exact: true })
      .click();
    for (let i = 6; i >= 3; i--)
      await page
        .getByRole("button", { name: `${i}번 카드 삭제`, exact: true })
        .click();
    await page.getByLabel("1번 노출 시간", { exact: true }).fill("1");
    await page.getByLabel("2번 노출 시간", { exact: true }).fill("0.5");
    await page
      .getByRole("button", { name: "1번 영상 선택", exact: true })
      .click();
    await expect(
      page.getByLabel("1번 영상 시작 (초)", { exact: true }),
    ).toBeVisible();
    await page.getByLabel("1번 영상 시작 (초)", { exact: true }).fill("1");
    await page
      .getByLabel("1번 문구", { exact: true })
      .fill("Moving background");
    await page
      .getByRole("button", { name: "2번 사진 선택", exact: true })
      .click();
    await page.getByLabel("2번 문구", { exact: true }).fill("Still background");
    await page
      .getByRole("button", { name: "카드 미리보기 만들기", exact: true })
      .click();
    await expect(page.getByLabel("영상 배경", { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator('video[aria-label="영상 배경"]')
          .evaluate((v: HTMLVideoElement) => v.currentTime),
      )
      .toBeCloseTo(1, 1);
    await page.screenshot({ path: info.outputPath("video-preview.png") });
    await page
      .getByRole("button", { name: "처음부터 재생", exact: true })
      .click();
    await expect
      .poll(() =>
        page
          .locator('video[aria-label="영상 배경"]')
          .evaluate((v: HTMLVideoElement) => v.currentTime),
      )
      .toBeGreaterThan(1.1);
    await page
      .getByRole("button", { name: "MP4 내보내기", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "MP4 내보내기 완료", exact: true }),
    ).toBeVisible({ timeout: 90000 });
    const plans = await page.evaluate(() => window.reels!.cardNews!.list());
    const loaded = await page.evaluate(
      (id) => window.reels!.cardNews!.load(id),
      plans[0].id,
    );
    expect(loaded.assets.some((a) => a.kind === "video")).toBeTruthy();
    expect(loaded.plan.cards[0].videoStart).toBe(1);
    const rejected = await page.evaluate(async (p) => {
      p.cards[0].videoStart = 2.5;
      try {
        await window.reels!.cardNews!.save(p);
        return false;
      } catch {
        return true;
      }
    }, loaded.plan);
    expect(rejected).toBeTruthy();
    const probe = JSON.parse(
      (
        await execute(ffprobe, [
          "-v",
          "error",
          "-show_entries",
          "format=duration:stream=codec_type,nb_frames",
          "-of",
          "json",
          output,
        ])
      ).stdout,
    );
    expect(Number(probe.format.duration)).toBe(1.5);
    expect(
      probe.streams.find((s: any) => s.codec_type === "video").nb_frames,
    ).toBe("45");
    const pixels = async (t: string) =>
      (
        await execute(
          ffmpeg,
          [
            "-v",
            "error",
            "-ss",
            t,
            "-i",
            output,
            "-frames:v",
            "1",
            "-vf",
            "scale=16:16",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
          ],
          { encoding: "buffer" },
        )
      ).stdout;
    expect((await pixels("0.1")).equals(await pixels("0.7"))).toBeFalsy();
    const blue = await pixels("1.2");
    expect(blue[2]).toBeGreaterThan(70);
    expect(blue[0]).toBeLessThan(20);
  } finally {
    if (app) await closeApp(app);
    await cleanProfile(profile);
  }
});

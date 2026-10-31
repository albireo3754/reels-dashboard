import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { launchApp, makeProfile, closeApp, cleanProfile } from "./helpers";
const execute = promisify(execFile);

test("desktop cards persist and export exact timed pictures with selected music, then cancel safely", async ({}, info) => {
  test.setTimeout(120000);
  const profile = await makeProfile();
  const runtime = process.env.REELS_ELECTRON_EXECUTABLE
    ? path.resolve(
        path.dirname(process.env.REELS_ELECTRON_EXECUTABLE),
        "../Resources/editor-runtime",
      )
    : path.resolve("native/editor-engine/.build/runtime");
  const ffmpeg = path.join(runtime, "bin/ffmpeg"),
    ffprobe = path.join(runtime, "bin/ffprobe");
  const green = path.join(profile, "초록 사진.png"),
    blue = path.join(profile, "파랑 사진.png"),
    music = path.join(profile, "음악.wav"),
    output = path.join(profile, "카드뉴스.mp4");
  let app;
  try {
    for (const [file, color] of [
      [green, "green"],
      [blue, "blue"],
    ])
      await execute(ffmpeg, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=${color}:s=1080x1920`,
        "-frames:v",
        "1",
        file,
      ]);
    await execute(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=4",
      music,
    ]);
    const originalHash = createHash("sha256")
      .update(await readFile(green))
      .digest("hex");
    app = await launchApp(profile, false);
    await app.evaluate(
      ({ dialog }, files) => {
        let picture = 0;
        dialog.showOpenDialog = async (...args: any[]) => ({
          canceled: false,
          filePaths: [
            args.at(-1).filters[0].extensions.includes("mp3")
              ? files.music
              : picture++ === 0
                ? files.green
                : files.blue,
          ],
        });
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath: files.output,
        });
      },
      { green, blue, music, output },
    );
    let page = await app.firstWindow();
    await page
      .getByRole("button", { name: "카드뉴스 릴스", exact: true })
      .click();
    await page
      .getByLabel("구성 제목", { exact: true })
      .fill("합성 카드뉴스 검증");
    for (let i = 6; i >= 3; i--)
      await page
        .getByRole("button", { name: `${i}번 카드 삭제`, exact: true })
        .click();
    for (let i = 1; i <= 2; i++) {
      await page
        .getByLabel(`${i}번 문구`, { exact: true })
        .fill(i === 1 ? "첫 번째 여행 정보" : "두 번째 확인할 정보");
      await page
        .getByLabel(`${i}번 노출 시간`, { exact: true })
        .fill(i === 1 ? "0.5" : "1");
      await page
        .getByRole("button", { name: `${i}번 사진 선택`, exact: true })
        .click();
    }
    await page
      .getByRole("button", { name: "음악 파일 선택", exact: true })
      .click();
    await page.getByLabel("음악 시작 (초)", { exact: true }).fill("0.25");
    await page.getByLabel("음악 볼륨 (%)", { exact: true }).fill("35");
    await page
      .getByRole("button", { name: "구성 저장 *", exact: true })
      .click();
    await expect(
      page.getByText("구성을 저장했어요.", { exact: true }),
    ).toBeVisible();
    const plans = await page.evaluate(() => window.reels!.cardNews!.list());
    await closeApp(app);
    app = await launchApp(profile, false);
    page = await app.firstWindow();
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, output);
    await page
      .getByRole("button", { name: "카드뉴스 릴스", exact: true })
      .click();
    await page
      .getByLabel("저장된 구성", { exact: true })
      .selectOption(plans[0].id);
    await expect(page.getByLabel("음악 볼륨 (%)", { exact: true })).toHaveValue(
      "35",
    );
    await page
      .getByRole("button", { name: "카드 미리보기 만들기", exact: true })
      .click();
    await expect(
      page.getByRole("img", { name: "1번 카드 미리보기", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath("card-news-ready.png") });
    // Hidden QA must not depend on a physical audio device or play through speakers.
    // Exported audio is verified independently below; this still checks decoded playback.
    await page.locator(".card-news audio").evaluate((a: HTMLAudioElement) => { a.muted = true; });
    await page
      .getByRole("button", { name: "처음부터 재생", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "재생 멈춤", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator(".card-news audio")
          .evaluate((a: HTMLAudioElement) => a.currentTime),
      )
      .toBeGreaterThan(0.25);
    await page
      .getByRole("button", { name: "MP4 내보내기", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "MP4 내보내기 완료", exact: true }),
    ).toBeVisible({ timeout: 30000 });
    const probe = JSON.parse(
      (
        await execute(ffprobe, [
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
    const video = probe.streams.find((s: any) => s.codec_type === "video");
    expect([
      video.width,
      video.height,
      video.codec_name,
      video.nb_frames,
    ]).toEqual([1080, 1920, "h264", "45"]);
    expect(probe.streams.some((s: any) => s.codec_name === "aac")).toBe(true);
    expect(Math.abs(Number(probe.format.duration) - 1.5)).toBeLessThan(0.06);
    for (const [time, channel] of [
      [0.1, 1],
      [0.6, 2],
    ]) {
      const pixel = await execute(
        ffmpeg,
        [
          "-v",
          "error",
          "-ss",
          String(time),
          "-i",
          output,
          "-vf",
          "crop=2:2:0:0,scale=1:1",
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ],
        { encoding: "buffer" },
      );
      expect(pixel.stdout[channel]).toBeGreaterThan(
        pixel.stdout[channel === 1 ? 2 : 1] + 20,
      );
    }
    const board = await page.evaluate(() => window.reels!.loadDashboard());
    expect(
      board.projects
        .find((p) => p.id === plans[0].id)
        ?.resources?.some((r) => r.path === output),
    ).toBe(true);
    expect(
      createHash("sha256")
        .update(await readFile(green))
        .digest("hex"),
    ).toBe(originalHash);
    // Merge the exported edit into a production project, then render another version.
    const merged = await page.evaluate(async (editId) => {
      const api = window.reels!;
      const current = await api.loadDashboard();
      await api.saveDashboard({ ...current, projects: [...current.projects, {
        id: "production-parent", title: "대표 제작 프로젝트", date: "2026-10-31",
        stage: "review", nextAction: "", publicURL: "", shared: false,
      }] }, current.updatedAt);
      return api.projects!.merge({ targetId: "production-parent", sourceIds: [editId], expectedUpdatedAt: (await api.loadDashboard()).updatedAt });
    }, plans[0].id);
    expect(merged.dashboard.projects).toHaveLength(1);
    expect(merged.dashboard.projects[0].production!.edits[0].id).toBe(plans[0].id);
    const secondOutput = path.join(profile, "version-two.mp4");
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, secondOutput);
    await page.getByRole("button", { name: "MP4 내보내기", exact: true }).click();
    await expect.poll(async () => {
      const current = await page.evaluate(() => window.reels!.loadDashboard());
      return current.projects[0].production?.exports.length;
    }, { timeout: 30000 }).toBe(2);
    const grouped = await page.evaluate(() => window.reels!.loadDashboard());
    expect(grouped.projects).toHaveLength(1);
    expect(grouped.projects[0].id).toBe("production-parent");
    expect(grouped.projects[0].title).toBe("대표 제작 프로젝트");
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, output);
    // Existing destination is rejected; completed media remains byte-identical.
    const outputHash = createHash("sha256")
      .update(await readFile(output))
      .digest("hex");
    await page
      .getByRole("button", { name: "MP4 내보내기", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText("덮어쓰지 않아요");
    expect(
      createHash("sha256")
        .update(await readFile(output))
        .digest("hex"),
    ).toBe(outputHash);
    const cancelled = path.join(profile, "cancelled.mp4");
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, cancelled);
    await page.getByLabel("1번 노출 시간", { exact: true }).fill("30");
    await page.getByLabel("2번 노출 시간", { exact: true }).fill("30");
    await page.getByLabel("짧은 음악 반복", { exact: true }).check();
    await page
      .getByRole("button", { name: "MP4 내보내기", exact: true })
      .click();
    await page
      .getByRole("button", { name: "내보내기 취소", exact: true })
      .click();
    await expect(
      page.getByText("내보내기를 취소했어요.", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () => {
        try {
          await stat(cancelled);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

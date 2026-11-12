import { expect, test } from "@playwright/test";
import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { cleanProfile, closeApp, launchApp, makeProfile } from "./helpers";

// Opt-in check with one real local video (for example an HEVC 10-bit HLG phone
// clip). The source is only read; nothing is copied into the repository, and the
// test profile is removed afterwards.
const source = process.env.REELS_PLAYBACK_SOURCE;

type Measured = {
  readyState: number;
  currentTime: number;
  duration: number;
  videoWidth: number;
  videoHeight: number;
  decodedFrames: number | null;
  droppedFrames: number | null;
  error: string | null;
  firstFrameMs: number;
};

async function measure(
  page: import("@playwright/test").Page,
  selector: string | null,
  url?: string,
): Promise<Measured> {
  return page.evaluate(
    async ({ selector, url }) => {
      const started = performance.now();
      let video: HTMLVideoElement;
      if (selector) video = document.querySelector(selector) as HTMLVideoElement;
      else {
        video = document.createElement("video");
        video.preload = "auto";
        video.style.width = "180px";
        document.body.append(video);
        video.src = url!;
      }
      video.muted = true;
      await new Promise<void>((resolve, reject) => {
        if (video.readyState >= 2) return resolve();
        video.addEventListener("loadeddata", () => resolve(), { once: true });
        video.addEventListener(
          "error",
          () => reject(new Error(video.error?.message || "video error")),
          { once: true },
        );
      });
      const firstFrameMs = performance.now() - started;
      await video.play();
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error(`currentTime stalled at ${video.currentTime}`)),
          15_000,
        );
        const tick = () =>
          video.currentTime > 1.5
            ? (clearTimeout(deadline), resolve())
            : setTimeout(tick, 100);
        tick();
      });
      video.pause();
      const quality = video.getVideoPlaybackQuality?.();
      const result = {
        readyState: video.readyState,
        currentTime: video.currentTime,
        duration: video.duration,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        decodedFrames: quality?.totalVideoFrames ?? null,
        droppedFrames: quality?.droppedVideoFrames ?? null,
        error: video.error?.message ?? null,
        firstFrameMs: Math.round(firstFrameMs),
      };
      if (!selector) video.remove();
      return result;
    },
    { selector, url },
  );
}

test("a real local original plays directly in the editor and the board viewer", async ({}, info) => {
  test.skip(!source, "Set REELS_PLAYBACK_SOURCE to one local video file.");
  test.setTimeout(120_000);
  const original = await realpath(source!);
  const before = await stat(original);
  const profile = await makeProfile();
  await writeFile(
    path.join(profile, "dashboard.json"),
    JSON.stringify({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      projects: [
        {
          id: "direct-playback",
          title: "원본 재생 확인",
          date: "2026-11-12",
          dateBasis: "capture",
          stage: "selected",
          nextAction: "재생 확인",
          publicURL: "",
          shared: false,
          resources: [{ role: "footage", path: original, label: "원본" }],
        },
      ],
    }),
  );
  const app = await launchApp(profile, false);
  try {
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => window.reels?.mode)).toBe("desktop");

    // Board viewer: the main process grants the original, not a copy.
    const opened = await page.evaluate(
      (file) => window.reels!.contentMedia!.open("direct-playback", file),
      original,
    );
    expect(opened.playback).toBe("original");
    const board = await measure(page, null, opened.url);

    // Editor: import through the real UI and play the element it renders.
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, original);
    await page.getByRole("button", { name: "영상 편집", exact: true }).click();
    await page.getByRole("button", { name: "로컬 영상 열기", exact: true }).click();
    const player = page.getByLabel("편집 원본 재생", { exact: true });
    await expect(player).toBeVisible({ timeout: 60_000 });
    const src = await player.evaluate((v) => (v as HTMLVideoElement).src);
    expect(src).toMatch(/^reels-media:\/\/video\/[a-f0-9-]{36}$/);
    const editor = await measure(page, 'video[aria-label="편집 원본 재생"]');
    await expect(page.getByText(/재생용 사본을 준비하고 있어요/)).toHaveCount(0);
    const meta = await page.locator(".editor-meta").innerText();

    for (const result of [board, editor]) {
      expect(result.error).toBeNull();
      expect(result.readyState).toBeGreaterThanOrEqual(2);
      expect(result.currentTime).toBeGreaterThan(1.5);
      expect(result.videoWidth).toBeGreaterThan(0);
    }
    const id = src.split("/").at(-1)!;
    expect(await readdir(path.join(profile, "editor", id))).not.toContain("playback.mp4");
    expect(await readdir(path.join(profile, "board-media")).catch(() => [])).toEqual([]);
    const after = await stat(original);
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
    const summary = { board, editor, editorMeta: meta, copiesCreated: 0 };
    await writeFile(info.outputPath("direct-playback.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

// Opt-in fallback check. REELS_FALLBACK_SOURCE must be a local video Chromium
// cannot decode but the engine can (for example a short ProRes .mov). The board
// viewer and the editor must start on the original, hit the <video> error, and
// switch to a playback copy made by `reels-editor proxy` without user action.
const fallbackSource = process.env.REELS_FALLBACK_SOURCE;

test("an original the renderer cannot decode falls back to a playback copy in the board and the editor", async ({}, info) => {
  test.skip(!fallbackSource, "Set REELS_FALLBACK_SOURCE to a local video Chromium cannot decode.");
  test.setTimeout(600_000);
  const original = await realpath(fallbackSource!);
  const before = await stat(original);
  const profile = await makeProfile();
  await writeFile(
    path.join(profile, "dashboard.json"),
    JSON.stringify({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      projects: [
        {
          id: "fallback-playback",
          title: "사본 폴백 확인",
          date: "2026-11-12",
          dateBasis: "capture",
          stage: "selected",
          nextAction: "재생 확인",
          publicURL: "",
          shared: false,
          resources: [{ role: "draft", path: original, label: "편집 시안" }],
        },
      ],
    }),
  );
  const app = await launchApp(profile, false);
  try {
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => window.reels?.mode)).toBe("desktop");

    // The grant itself is the original; only the renderer's error asks for a copy.
    const opened = await page.evaluate(
      (file) => window.reels!.contentMedia!.open("fallback-playback", file),
      original,
    );
    expect(opened.playback).toBe("original");

    // Board viewer through the real UI.
    const boardStarted = Date.now();
    await page.getByRole("button", { name: "편집 시안 미리보기", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/원본을 바로 재생하지 못해 재생용 사본을 준비하고 있어요/)).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText("재생용 사본으로 재생해요. 원본은 그대로 유지돼요.")).toBeVisible({ timeout: 300_000 });
    const boardCopyMs = Date.now() - boardStarted;
    const board = await measure(page, 'video[aria-label="편집 시안 재생"]');
    const boardCache = (await readdir(path.join(profile, "board-media"))).filter((f) => f.endsWith(".mp4"));
    expect(boardCache).toHaveLength(1);
    await page.getByRole("button", { name: "미디어 닫기" }).click();

    // Editor through the real UI.
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, original);
    const editorStarted = Date.now();
    await page.getByRole("button", { name: "영상 편집", exact: true }).click();
    await page.getByRole("button", { name: "로컬 영상 열기", exact: true }).click();
    const player = page.getByLabel("편집 원본 재생", { exact: true });
    await expect(page.getByText(/원본을 바로 재생하지 못해 재생용 사본을 준비하고 있어요/)).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(() => player.evaluate((v) => (v as HTMLVideoElement).src).catch(() => ""), { timeout: 300_000 })
      .toMatch(/^reels-media:\/\/video\/[a-f0-9-]{36}\/copy$/);
    const editorCopyMs = Date.now() - editorStarted;
    const editor = await measure(page, 'video[aria-label="편집 원본 재생"]');
    const meta = await page.locator(".editor-meta").innerText();
    const id = (await player.evaluate((v) => (v as HTMLVideoElement).src)).split("/").at(-2)!;
    expect(await readdir(path.join(profile, "editor", id))).toContain("playback.mp4");

    for (const result of [board, editor]) {
      expect(result.error).toBeNull();
      expect(result.readyState).toBeGreaterThanOrEqual(2);
      expect(result.currentTime).toBeGreaterThan(1.5);
      expect(Math.max(result.videoWidth, result.videoHeight)).toBeLessThanOrEqual(1080);
    }
    const after = await stat(original);
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
    // Each copy ran `reels-editor proxy` once. Its stderr is kept in the execution
    // log, so a missing "GPU proxy unavailable" notice means the VideoToolbox route.
    const logDir = path.join(profile, "execution-logs");
    const copyLogs = await Promise.all(
      (await readdir(logDir)).map(async (name) =>
        JSON.parse(await readFile(path.join(logDir, name), "utf8")),
      ),
    ).then((records) =>
      records.filter((r) => String(r.label).includes("재생용 사본 준비")),
    );
    expect(copyLogs.map((r) => r.status)).toEqual(["completed", "completed"]);
    const gpuFallbacks = copyLogs.filter((r) =>
      String(r.output).includes("GPU proxy unavailable"),
    ).length;
    if (process.env.REELS_FALLBACK_EXPECT_GPU === "1") expect(gpuFallbacks).toBe(0);
    const summary = { board, boardCopyMs, editor, editorCopyMs, editorMeta: meta, gpuFallbacks };
    await writeFile(info.outputPath("fallback-playback.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

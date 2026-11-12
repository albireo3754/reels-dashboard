import { expect, test } from "@playwright/test";
import { readdir, realpath, stat, writeFile } from "node:fs/promises";
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

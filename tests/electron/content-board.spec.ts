import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, writeFile, readFile, realpath, mkdir, unlink, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { editorRuntime, launchApp, makeProfile, closeApp, cleanProfile } from "./helpers";
import { newCardPlan } from "../../src/shared/card-news-model";
const execute = promisify(execFile);
test("packaged board previews actual images, plays/seek videos, browses folders and reports missing media", async ({}, info) => {
  test.setTimeout(90_000);
  const profile = await realpath(await makeProfile());
  const runtime = editorRuntime();
  const footage = path.join(profile, "촬영본");
  await mkdir(footage);
  const video = path.join(footage, "산책 영상.mov");
  const final = path.join(profile, "이전 완성본.mov");
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
  await copyFile(video, final);
  await execute(path.join(runtime, "bin/ffmpeg"), [
    "-v",
    "error",
    "-i",
    video,
    "-frames:v",
    "1",
    cover,
  ]);
  const otherPhotos = [
    { label: "가로 사진", width: 1280, height: 720 },
    { label: "정사각형 사진", width: 720, height: 720 },
  ];
  for (const { label, width, height } of otherPhotos) {
    await execute(path.join(runtime, "bin/ffmpeg"), [
      "-v", "error", "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}`,
      "-frames:v", "1", path.join(profile, `${label}.png`),
    ]);
  }
  // Blog markup inside the linked folder; its photo is the linked cover one level up.
  await writeFile(
    path.join(footage, "블로그 원고.md"),
    '---\nmarkup: 1\ntitle: 합성 블로그\n---\n<Bundle id="B01" name="도입">\n<Photo file="../표지.png" alt="표지 사진"/>\n\n¶ P1\n첫 문단이에요\n</Bundle>\n',
  );
  await writeFile(path.join(footage, "메모.txt"), "# 제목 아님\n그냥 텍스트");
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
          stage: "editing",
          nextAction: "시안과 표지를 확인해요.",
          publicURL: "",
          shared: false,
          publications: [
            { channel: "instagram", status: "planned", url: "" },
            { channel: "naver-clip", status: "planned", url: "" },
          ],
          resources: [
            { role: "final", path: final, label: "이전 완성본" },
            { role: "draft", path: video, label: "편집 시안" },
            { role: "cover", path: cover, label: "표지 이미지" },
            { role: "folder", path: footage, label: "촬영 폴더" },
            ...otherPhotos.map(({ label }) => ({
              role: "footage", path: path.join(profile, `${label}.png`), label,
            })),
          ],
        },
      ],
    }),
  );
  const app = await launchApp(profile, false);
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "합성 촬영 콘텐츠", exact: true, level: 3 }),
    ).toBeVisible();
    const poster = page.getByRole("button", { name: "합성 촬영 콘텐츠 미디어 보기" })
      .getByRole("img", { name: "표지 이미지 썸네일" });
    await expect(poster).toBeVisible();
    const imageRatio = (node: HTMLElement) => {
      const { naturalWidth, naturalHeight } = node as HTMLImageElement;
      return naturalHeight ? naturalWidth / naturalHeight : 0;
    };
    await expect.poll(() => poster.evaluate(imageRatio)).toBeCloseTo(9 / 16, 2);
    await expect(poster).toHaveCSS("object-fit", "contain");
    await page.screenshot({
      path: info.outputPath("content-board.png"),
      fullPage: true,
    });
    const reelTitle = page.getByRole("article", { name: "릴스 이번 주" })
      .getByRole("button", { name: "합성 촬영 콘텐츠", exact: true });
    await reelTitle.click();
    const reelWork = page.getByRole("dialog", { name: "합성 촬영 콘텐츠 릴스 작업" });
    await expect(reelWork.getByLabel("편집 시안 재생")).toBeVisible();
    await expect(reelWork.getByLabel("이전 완성본 재생")).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "콘텐츠 기록" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(reelTitle).toBeFocused();
    await page.getByRole("article", { name: "클립 이번 주" })
      .getByRole("button", { name: "합성 촬영 콘텐츠", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "콘텐츠 기록" })).toBeVisible();
    await page.getByRole("button", { name: "콘텐츠 기록 닫기" }).click();
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
    // Original-first playback: the grant streams the source file itself and no
    // playback copy is cached.
    await expect(dialog.getByText("원본 파일을 그대로 재생해요.")).toBeVisible();
    const length = await page.evaluate(
      async (url) =>
        Number((await fetch(url!, { method: "HEAD" })).headers.get("content-length")),
      url,
    );
    expect(length).toBe((await stat(video)).size);
    expect(
      await readdir(path.join(profile, "board-media")).catch(() => []),
    ).toEqual([]);
    const videoThumbnail = dialog.getByRole("img", { name: "편집 시안 썸네일" });
    await expect.poll(() => videoThumbnail.evaluate(imageRatio)).toBeCloseTo(9 / 16, 2);
    await expect(videoThumbnail).toHaveCSS("object-fit", "contain");
    for (const { label, width, height } of [
      ...otherPhotos,
      { label: "표지 이미지", width: 720, height: 1280 },
    ]) {
      const button = dialog.getByRole("button", { name: `${label} 보기`, exact: true });
      const thumb = button.getByRole("img", { name: `${label} 썸네일` });
      await expect.poll(() => thumb.evaluate(imageRatio)).toBeCloseTo(width / height, 2);
      await expect(thumb).toHaveCSS("object-fit", "contain");
      await button.click();
      const preview = dialog.getByRole("img", { name: label, exact: true });
      await expect.poll(() => preview.evaluate(imageRatio)).toBeCloseTo(width / height, 2);
      await expect(preview).toHaveCSS("object-fit", "contain");
    }
    await dialog.screenshot({ path: info.outputPath("content-photo-preview.png") });
    await dialog
      .getByRole("button", { name: "촬영 폴더 폴더 열기", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "산책 영상.mov 보기", exact: true })
      .click();
    await expect(dialog.getByLabel("산책 영상.mov 재생")).toBeVisible();
    await dialog
      .getByRole("button", { name: "블로그 원고.md 보기", exact: true })
      .click();
    const blog = dialog.getByLabel("블로그 원고.md 블로그 미리보기");
    await expect(blog.getByRole("heading", { name: "합성 블로그" })).toBeVisible();
    await expect(blog.getByText("첫 문단이에요")).toBeVisible();
    const photo = blog.getByRole("img", { name: "표지 사진" });
    await expect(photo).toHaveAttribute("src", /^data:image/);
    await expect
      .poll(() => photo.evaluate((n) => (n as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    await dialog.screenshot({ path: info.outputPath("content-blog-view.png") });
    await dialog.getByRole("button", { name: "Markdown", exact: true }).click();
    await expect(dialog.getByLabel("블로그 원고.md 본문")).toContainText("첫 문단이에요");
    await dialog.getByRole("button", { name: "메모.txt 보기", exact: true }).click();
    await expect(dialog.getByRole("group", { name: "문서 보기 방식" })).toHaveCount(0);
    await expect(dialog.getByLabel("메모.txt 본문")).toContainText("# 제목 아님");
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
    await page.getByRole("button", { name: "미디어 닫기", exact: true }).click();

    // Link real saved plans and verify the weekly work view opens those exact plans.
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, video);
    await page.evaluate(async (plan) => {
      const api = window.reels!;
      const savedCard = await api.cardNews!.save(plan);
      const savedVideo = (await api.editor.chooseVideo())!;
      const board = await api.loadDashboard();
      const merged = await api.projects!.merge({
        targetId: "board-local", sourceIds: [savedVideo.id], expectedUpdatedAt: board.updatedAt,
      });
      await api.projects!.linkEdit({
        projectId: "board-local", edit: { kind: "card-news", id: savedCard.id },
        expectedUpdatedAt: merged.dashboard.updatedAt,
      });
    }, { ...newCardPlan(), title: "편집 중인 카드뉴스" });
    await reelTitle.click();
    await reelWork.getByText("저장된 편집 구성 2개").click();
    await reelWork.getByRole("button", { name: "산책 영상.mov 영상 편집" }).click();
    await expect(page.locator(".editor-workspace").getByText("산책 영상.mov", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "대시보드", exact: true }).click();
    await reelTitle.click();
    await reelWork.getByText("저장된 편집 구성 2개").click();
    await reelWork.getByRole("button", { name: "편집 중인 카드뉴스 카드뉴스 편집" }).click();
    await expect(page.getByLabel("구성 제목", { exact: true })).toHaveValue("편집 중인 카드뉴스");
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

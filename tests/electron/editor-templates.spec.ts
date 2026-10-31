import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { launchApp, makeProfile, closeApp, cleanProfile } from "./helpers";
const execute = promisify(execFile);
test("desktop template UI saves adjustments and renders matching video and cover manifests", async () => {
  test.setTimeout(90_000);
  const profile = await makeProfile();
  const app = await launchApp(profile, false);
  try {
    const page = await app.firstWindow();
    const runtime = process.env.REELS_ELECTRON_EXECUTABLE
      ? path.resolve(
          path.dirname(process.env.REELS_ELECTRON_EXECUTABLE),
          "../Resources/editor-runtime",
        )
      : path.resolve("native/editor-engine/.build/runtime");
    const input = path.join(profile, "template-source.mp4");
    const output = path.join(profile, "template-output.mp4");
    await execute(path.join(runtime, "bin/ffmpeg"), [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=green:s=720x1280:r=24:d=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      input,
    ]);
    await app.evaluate(
      ({ dialog }, files) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [files.input],
        });
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath: files.output,
        });
      },
      { input, output },
    );
    await page.getByRole("button", { name: "영상 편집", exact: true }).click();
    await page
      .getByRole("button", { name: "로컬 영상 열기", exact: true })
      .click();
    await expect(page.getByLabel("장소명", { exact: true })).toBeVisible();
    await page.evaluate(async () => {
      const api = window.reels!;
      const edits = await api.editor.list();
      const current = await api.loadDashboard();
      await api.saveDashboard({ ...current, projects: [...current.projects, {
        id: "video-production", title: "영상 제작 프로젝트", date: "2026-10-31",
        stage: "review", nextAction: "", publicURL: "", shared: false,
      }] }, current.updatedAt);
      await api.projects!.merge({ targetId: "video-production", sourceIds: [edits[0].id], expectedUpdatedAt: (await api.loadDashboard()).updatedAt });
    });
    await page.getByLabel("장소명", { exact: true }).fill("서울");
    await page.getByLabel("장소 설명", { exact: true }).fill("함께 걷는 길");
    await page
      .getByLabel("표지 훅", { exact: true })
      .fill("함께 걷는\n가을 산책");
    await page
      .getByRole("button", { name: "3번 핀 + 설명 사각 바", exact: true })
      .click();
    await page
      .getByRole("button", { name: "5번 표지 185px 고정", exact: true })
      .click();
    await page.getByText("템플릿 세부 조정", { exact: true }).click();
    await page
      .getByLabel("영상 장소 묶음 세로 이동 (%)", { exact: true })
      .fill("2");
    await page
      .getByLabel("표지 훅 묶음 세로 이동 (%)", { exact: true })
      .fill("-2");
    await page
      .getByLabel("표지 장소 핀 가로 이동 (%)", { exact: true })
      .fill("1");
    await page.getByLabel("표지 글자 크기 직접 지정", { exact: true }).check();
    await page.getByLabel("표지 글자 크기 (px)", { exact: true }).fill("165");
    await page
      .getByRole("button", { name: "영상 미리보기 만들기", exact: true })
      .click();
    await expect(
      page.getByRole("img", { name: /영상 .* 합성 미리보기/ }),
    ).toBeVisible({ timeout: 20_000 });
    await page
      .getByRole("button", { name: "영상과 표지 내보내기", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "내보내기 완료", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    const grouped = await page.evaluate(() => window.reels!.loadDashboard());
    expect(grouped.projects).toHaveLength(1);
    expect(grouped.projects[0].id).toBe("video-production");
    expect(grouped.projects[0].production!.exports).toHaveLength(2);
    const projects = await page.evaluate(() => window.reels!.editor.list());
    const project = await page.evaluate(
      (id) => window.reels!.editor.load(id),
      projects[0].id,
    );
    expect(project.settings.place.offsetY).toBe(0.02);
    expect(project.settings.cover.hookOffsetY).toBe(-0.02);
    expect(project.settings.cover.placeOffsetX).toBe(0.01);
    expect(project.settings.cover.hookSize).toBe(165);
    const dashboard = await page.evaluate(() => window.reels!.loadDashboard());
    const linked = dashboard.projects.find((p) => p.id === "video-production")!;
    expect(linked.stage).toBe("review");
    const canonicalInput = await realpath(input),
      canonicalOutput = await realpath(output);
    expect(
      linked.resources?.some(
        (r) => r.role === "footage" && r.path === canonicalInput,
      ),
    ).toBe(true);
    expect(
      linked.resources?.some(
        (r) => r.role === "draft" && r.path === canonicalOutput,
      ),
    ).toBe(true);
    expect(linked.resources?.some((r) => r.role === "cover")).toBe(true);
    const media = await page.evaluate(
      (id) => window.reels!.contentMedia!.list(id),
      linked.id,
    );
    expect(media.items.every((item) => item.available)).toBe(true);
    const coverResource = linked.resources!.find((r) => r.role === "cover")!;
    expect(
      await page.evaluate(
        ({ id, file }) => window.reels!.contentMedia!.thumbnail(id, file),
        { id: linked.id, file: coverResource.path },
      ),
    ).toMatch(/^data:image/);
    const manifest = JSON.parse(
      await readFile(output.replace(".mp4", ".style.json"), "utf8"),
    );
    expect(manifest.requested.place_offset_y).toBe(0.02);
    expect(manifest.render_options.banner_material).toBe("rectangle");
    const files = await (await import("node:fs/promises")).readdir(profile);
    const coverManifest = files.find(
      (name) => name.includes("cover") && name.endsWith(".style.json"),
    );
    expect(coverManifest).toBeTruthy();
    const cover = JSON.parse(
      await readFile(path.join(profile, coverManifest!), "utf8"),
    );
    expect(cover.hook_size_at_2160).toBe(165);
    expect(cover.requested.hook_offset_y).toBe(-0.02);
    expect(cover.requested.place_offset_x).toBe(0.01);
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { launchApp, makeProfile, closeApp, cleanProfile } from "./helpers";
import { demoRouteMap } from "../../src/shared/route-map-demo";
const execute = promisify(execFile);

test("route map uses registered documents, real local playback, refreshed data and restart persistence", async ({}, info) => {
  test.setTimeout(90000);
  const profile = await realpath(await makeProfile());
  const runtime = process.env.REELS_ELECTRON_EXECUTABLE ? path.resolve(path.dirname(process.env.REELS_ELECTRON_EXECUTABLE), "../Resources/editor-runtime") : path.resolve("native/editor-engine/.build/runtime");
  const video = path.join(profile, "walk.mp4"), doc = path.join(profile, "route-map-data.json");
  await execute(path.join(runtime, "bin/ffmpeg"), ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=24:duration=1.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
  const original = await readFile(video);
  const data = structuredClone(demoRouteMap.data); await writeFile(doc, JSON.stringify(data));
  await writeFile(path.join(profile, "dashboard.json"), JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), projects: [{ id: "map-local", title: "합성 촬영 지도", date: data.captureDate, dateBasis: "capture", stage: "selected", nextAction: "지도 확인", publicURL: "", shared: false, resources: [{ role: "document", path: doc, label: "촬영 지도" }, { role: "footage", path: video, label: "원본" }] }] }));
  let app = await launchApp(profile, false);
  try {
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "촬영 지도 · 동선 보기", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "합성 촬영 지도 촬영 지도", exact: true });
    await expect(dialog.getByRole("heading", { name: "walk.mp4", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "선택한 촬영분 열기", exact: true }).click();
    const playback = dialog.getByLabel("walk.mp4 재생");
    await expect.poll(() => playback.evaluate(n => (n as HTMLVideoElement).readyState)).toBeGreaterThan(0);
    await playback.evaluate(n => (n as HTMLVideoElement).play());
    await expect.poll(() => playback.evaluate(n => (n as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
    await dialog.getByRole("button", { name: "다음 촬영", exact: true }).click();
    await expect(dialog.getByText("이 촬영분의 원본은 아직 연결되지 않았어요.", { exact: false })).toBeVisible();
    await expect(dialog.locator("video")).toHaveCount(0);
    await dialog.screenshot({ path: info.outputPath("route-map-electron.png") });
    await closeApp(app); app = await launchApp(profile, false); page = await app.firstWindow();
    data.assets[0].section = "갱신된 구간"; await writeFile(doc, JSON.stringify(data));
    await page.getByRole("button", { name: "촬영 지도 · 동선 보기", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "합성 촬영 지도 촬영 지도", exact: true });
    await expect(dialog.locator(".route-map-selected")).toContainText("갱신된 구간");
    await dialog.getByRole("button", { name: "촬영 지도 닫기", exact: true }).click();
    await unlink(video);
    await page.getByRole("button", { name: "촬영 지도 · 동선 보기", exact: true }).click();
    await expect(dialog.getByText("이 촬영분의 원본은 아직 연결되지 않았어요.", { exact: false })).toBeVisible();
    expect(original.length).toBeGreaterThan(1000);
  } finally { await closeApp(app); await cleanProfile(profile); }
});

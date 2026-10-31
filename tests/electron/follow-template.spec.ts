import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { launchApp, makeProfile, closeApp, cleanProfile } from "./helpers";

test("signed final card saves and exports a real standalone PNG without a place", async ({}, info) => {
  test.setTimeout(90_000);
  const profile = await makeProfile();
  const app = await launchApp(profile, false);
  try {
    const runtime = process.env.REELS_ELECTRON_EXECUTABLE
      ? path.resolve(
          path.dirname(process.env.REELS_ELECTRON_EXECUTABLE),
          "../Resources/editor-runtime",
        )
      : path.resolve("native/editor-engine/.build/runtime");
    const input = path.join(profile, "follow-source.mp4");
    const output = path.join(profile, "follow-output.png");
    await promisify(execFile)(path.join(runtime, "bin/ffmpeg"), [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=0x445577:s=720x1280:r=24:d=1",
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
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "영상 편집", exact: true }).click();
    await page
      .getByRole("button", { name: "로컬 영상 열기", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "6번 서명 있는 팔로우 마지막 장",
        exact: true,
      })
      .click();
    await page
      .getByLabel("팔로우 문구", { exact: true })
      .fill("팔로우해 주세요!");
    await page.getByLabel("서명 (영문 계정명)").fill("@your_account 🌹");
    await page.getByLabel("마지막 장 배경 어둡기 (%)").fill("30");
    await page
      .getByRole("button", { name: "마지막 장 미리보기 만들기" })
      .click();
    await expect(
      page.getByRole("img", { name: /표지 .* 합성 미리보기/ }),
    ).toBeVisible({ timeout: 20_000 });
    await page
      .getByRole("button", { name: "편집 설정 저장", exact: true })
      .click();
    await page.reload();
    await page.getByRole("button", { name: "영상 편집", exact: true }).click();
    await page
      .getByRole("button", {
        name: "편집 기록 열기 follow-source.mp4",
        exact: true,
      })
      .click();
    await expect(page.getByLabel("서명 (영문 계정명)")).toHaveValue(
      "@your_account 🌹",
    );
    await page.getByRole("button", { name: "마지막 장 PNG 내보내기" }).click();
    await expect(
      page.getByRole("heading", { name: "내보내기 완료", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    const manifest = JSON.parse(
      await readFile(output.replace(".png", ".style.json"), "utf8"),
    );
    expect(manifest.template).toBe("rosy-follow");
    expect(manifest.outputSize).toEqual([1080, 1920]);
    expect(manifest.placeGuide).toBe(false);
    expect(manifest.signature.text).toBe("@your_account 🌹");
    expect(manifest.followDarkness).toBe(0.3);
    expect((await readFile(output)).subarray(1, 4).toString()).toBe("PNG");
    await info.attach("signed-card", {
      path: output,
      contentType: "image/png",
    });
    await page
      .getByRole("region", { name: "편집 템플릿" })
      .screenshot({ path: info.outputPath("follow-template.png") });
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

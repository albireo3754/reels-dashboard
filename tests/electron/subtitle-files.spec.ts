import { test, expect, type ElectronApplication } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchApp, makeProfile, closeApp, cleanProfile } from "./helpers";
let app: ElectronApplication | undefined;
let profile: string;
test.beforeEach(async () => {
  profile = await makeProfile();
  app = await launchApp(profile, true);
});
test.afterEach(async () => {
  await closeApp(app);
  app = undefined;
  await cleanProfile(profile);
});
test("imports and downloads UTF-8 subtitles in the actual desktop renderer", async () => {
  const input = path.join(profile, "가져올 자막.srt"),
    output = path.join(profile, "downloaded.srt");
  await writeFile(
    input,
    "1\n00:00:00,500 --> 00:00:02,000\n실제 앱에서 확인해요.\n",
    "utf8",
  );
  const page = await app!.firstWindow();
  await page.getByRole("button", { name: "영상 편집", exact: true }).click();
  await page
    .getByRole("button", { name: "로컬 영상 열기", exact: true })
    .click();
  await page
    .getByLabel("SRT/VTT 파일 선택", { exact: true })
    .setInputFiles(input);
  await page
    .getByRole("button", { name: "검토한 자막 적용", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "자막 1 내용", exact: true }),
  ).toHaveValue("실제 앱에서 확인해요.");
  await app!.evaluate(({ session }, output) => {
    session.defaultSession.once("will-download", (_event, item) => {
      item.setSavePath(output);
    });
  }, output);
  await page.getByRole("button", { name: "SRT 저장", exact: true }).click();
  await expect
    .poll(async () => {
      try {
        return await readFile(output, "utf8");
      } catch {
        return "";
      }
    })
    .toContain("00:00:00,500 --> 00:00:02,000\n실제 앱에서 확인해요.");
  const notices = await app!.evaluate(({ app }) => {
    const fs = process.getBuiltinModule("fs"),
      path = process.getBuiltinModule("path");
    return {
      license: fs
        .readFileSync(
          path.join(app.getAppPath(), "dist/licenses/opencut-MIT.txt"),
          "utf8",
        )
        .includes("Copyright 2025-2026 OpenCut"),
      notice: fs
        .readFileSync(
          path.join(app.getAppPath(), "THIRD_PARTY_NOTICES.md"),
          "utf8",
        )
        .includes("OpenCut Classic"),
    };
  });
  expect(notices).toEqual({ license: true, notice: true });
});

import { test, expect, type Page } from "@playwright/test";
const srt =
  "1\n00:00:00,500 --> 00:00:02,000\n골목을 걸어봤어요.\n\n2\n00:00:02,000 --> 00:00:04,250\n가게도\n둘러봤어요.\n";
async function open(page: Page) {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "영상 편집", exact: true }).click();
  await page
    .getByRole("button", { name: "로컬 영상 열기", exact: true })
    .click();
  await expect(
    page.getByText("예시 산책 영상.mp4", { exact: true }).first(),
  ).toBeVisible();
}
async function upload(page: Page, name: string, body: string) {
  await page
    .getByLabel("SRT/VTT 파일 선택", { exact: true })
    .setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(body) });
}
test("imports reviewed SRT cues, preserves style and exports matching SRT", async ({
  page,
}, info) => {
  await open(page);
  await page.getByLabel("본문 자막 크기", { exact: true }).fill("0.05");
  await page.getByLabel("본문 자막 세로 위치", { exact: true }).fill("0.60");
  await upload(page, "산책.srt", srt);
  await expect(
    page.getByRole("region", { name: "가져올 자막 검토" }),
  ).toContainText("2개 자막");
  await expect(
    page.getByRole("textbox", { name: "자막 1 내용", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "검토한 자막 적용", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "자막 1 내용", exact: true }),
  ).toHaveValue("골목을 걸어봤어요.");
  await expect(
    page.getByRole("textbox", { name: "자막 2 내용", exact: true }),
  ).toHaveValue("가게도\n둘러봤어요.");
  await expect(page.getByLabel("자막 1 시작", { exact: true })).toHaveValue(
    "0.5",
  );
  await expect(page.getByLabel("본문 자막 크기", { exact: true })).toHaveValue(
    "0.05",
  );
  expect(
    Number(
      await page
        .getByLabel("본문 자막 세로 위치", { exact: true })
        .inputValue(),
    ),
  ).toBe(0.6);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "SRT 저장", exact: true }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  let text = "";
  for await (const chunk of stream!) text += chunk.toString();
  expect(text).toContain("00:00:02,000 --> 00:00:04,250");
  expect(text).toContain("가게도\n둘러봤어요.");
  await page
    .getByRole("button", { name: "편집 설정 저장", exact: true })
    .click();
  await page.reload();
  await page.getByRole("button", { name: "영상 편집", exact: true }).click();
  await page
    .getByRole("button", {
      name: "편집 기록 열기 예시 산책 영상.mp4",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("textbox", { name: "자막 2 내용", exact: true }),
  ).toHaveValue("가게도\n둘러봤어요.");
  await page
    .getByRole("region", { name: "자막 파일 도구" })
    .screenshot({ path: info.outputPath("subtitle-file-tools.png") });
});
test("replacement requires explicit review and rejects invalid files without losing cues", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "자막 추가", exact: true }).click();
  await page
    .getByRole("textbox", { name: "자막 1 내용", exact: true })
    .fill("기존 문구예요.");
  await upload(page, "new.srt", srt);
  const apply = page.getByRole("button", {
    name: "검토한 자막 적용",
    exact: true,
  });
  await expect(apply).toBeDisabled();
  await page
    .getByRole("button", { name: "가져오기 취소", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "자막 1 내용", exact: true }),
  ).toHaveValue("기존 문구예요.");
  await upload(
    page,
    "bad.srt",
    srt.replace(
      "00:00:02,000 --> 00:00:04,250",
      "00:00:01,000 --> 00:00:04,250",
    ),
  );
  await expect(page.getByRole("alert")).toContainText("겹치거나");
  await expect(
    page.getByRole("textbox", { name: "자막 1 내용", exact: true }),
  ).toHaveValue("기존 문구예요.");
  await upload(page, "good.srt", srt);
  await page
    .getByRole("checkbox", {
      name: "기존 자막 1개를 이 파일의 자막으로 바꿔요",
      exact: true,
    })
    .check();
  await apply.click();
  await expect(
    page.getByRole("textbox", { name: "자막 1 내용", exact: true }),
  ).toHaveValue("골목을 걸어봤어요.");
});
test("WebVTT review is invalidated when existing settings change", async ({
  page,
}) => {
  await open(page);
  await upload(
    page,
    "notes.vtt",
    "WEBVTT\n\nNOTE 참고\n설명\n\nopening\n00:01.000 --> 00:03.000\n직접 확인했어요.",
  );
  await expect(
    page.getByRole("region", { name: "가져올 자막 검토" }),
  ).toContainText("VTT 주석 1개");
  await page.getByLabel("본문 자막 세로 위치", { exact: true }).fill("0.7");
  await expect(
    page.getByRole("region", { name: "가져올 자막 검토" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "자막 1 내용", exact: true }),
  ).toHaveCount(0);
  await upload(
    page,
    "notes.vtt",
    "WEBVTT\n\n00:01.000 --> 00:03.000\n직접 확인했어요.",
  );
  await page
    .getByRole("button", { name: "검토한 자막 적용", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "자막 1 내용", exact: true }),
  ).toHaveValue("직접 확인했어요.");
});

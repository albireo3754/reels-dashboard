import { test, expect } from "@playwright/test";
import { launchApp, makeProfile, closeApp, cleanProfile } from "./helpers";
test("blog reference import selects child anchors, keeps location for unanchored groups and retains across sub-tabs", async ({}, testInfo) => {
  const profile = await makeProfile();
  let app;
  try {
    app = await launchApp(profile);
    const page = await app.firstWindow();
    await page.route("https://blog.naver.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<div style="height:1500px">top</div><div id="child-group">selected group</div><div style="height:1000px"></div>',
      }),
    );
    await page.getByRole("button", { name: "블로그", exact: true }).click();
    await page
      .getByRole("button", { name: "레퍼런스 추출·탐색", exact: true })
      .click();
    await page.getByText("구조 파일 직접 가져오기", { exact: true }).click();
    const rect = { x: 0, y: 1000, width: 600, height: 200 };
    const block = {
      order: 0,
      id: "",
      anchorId: "child-group",
      className: "se-imageGroup",
      rect,
      css: {},
      paragraphs: [],
      images: [],
    };
    const refs = [
      {
        name: "구조 확인용",
        url: "https://blog.naver.com/fixture/1",
        pageUrl: "https://blog.naver.com/PostView.naver?blogId=fixture&logNo=1",
        width: 600,
        blocks: [block, { ...block, order: 1, anchorId: null }],
      },
    ];
    await page
      .getByLabel("레퍼런스 구조 파일")
      .setInputFiles({
        name: "reference.md",
        mimeType: "text/markdown",
        buffer: Buffer.from("```json\n" + JSON.stringify(refs) + "\n```"),
      });
    await page
      .getByRole("button", { name: "원본 페이지 보기", exact: true })
      .click();
    await page
      .getByRole("button", { name: "#1 이미지 그룹", exact: false })
      .click();
    const frame = page.locator('iframe[title="레퍼런스 원본"]');
    await expect(frame).toHaveAttribute("src", /\#child-group$/);
    await expect(
      page
        .frameLocator('iframe[title="레퍼런스 원본"]')
        .locator("#child-group"),
    ).toBeInViewport();
    await page
      .getByRole("button", { name: "#2 이미지 그룹", exact: false })
      .click();
    await expect(frame).toHaveAttribute("src", /\#child-group$/);
    await expect(
      page.getByText("이 블록에는 이동 앵커가 없어 원본 위치를 유지해요."),
    ).toBeVisible();
    await page.getByRole("button", { name: "원고·배치", exact: true }).click();
    await page
      .getByRole("button", { name: "레퍼런스 추출·탐색", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "구조 확인용", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "구조 도식 보기", exact: true })
      .click();
    await page
      .locator(".blog-references")
      .screenshot({ path: testInfo.outputPath("references.png") });
  } finally {
    if (app) await closeApp(app);
    await cleanProfile(profile);
  }
});

test("saved analysis folder opens structure and preview and remains after restart", async ({}, testInfo) => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const profile = await makeProfile();
  const dir = join(profile, "extracted");
  await mkdir(dir);
  const rect = { x: 0, y: 0, width: 600, height: 100 };
  const refs = [
    {
      name: "저장된 분석 결과",
      url: "https://blog.naver.com/fixture/1",
      pageUrl: "https://blog.naver.com/fixture/1",
      width: 600,
      blocks: [
        {
          order: 0,
          id: "b",
          className: "se-text",
          rect,
          css: {},
          paragraphs: [],
          images: [],
        },
      ],
    },
  ];
  await writeFile(join(dir, "reference-structures.json"), JSON.stringify(refs));
  await writeFile(join(dir, "index.html"), "<h1>기존 템플릿 미리보기</h1>");
  let app;
  try {
    app = await launchApp(profile);
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      });
    }, dir);
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "블로그", exact: true }).click();
    await page
      .getByRole("button", { name: "레퍼런스 추출·탐색", exact: true })
      .click();
    await page
      .getByRole("button", { name: "분석 결과 폴더 연결", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "저장된 분석 결과 · 1개 블록",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByLabel("원본 블록 목록")).toBeVisible();
    await page
      .getByRole("button", { name: "템플릿 미리보기 열기", exact: true })
      .click();
    await expect(
      page
        .frameLocator('iframe[title="저장된 블로그 템플릿 미리보기"]')
        .getByRole("heading", { name: "기존 템플릿 미리보기" }),
    ).toBeVisible();
    await closeApp(app);
    app = await launchApp(profile);
    page = await app.firstWindow();
    await page.getByRole("button", { name: "블로그", exact: true }).click();
    await page
      .getByRole("button", { name: "레퍼런스 추출·탐색", exact: true })
      .click();
    await page
      .getByRole("button", { name: "저장된 분석 결과 · 1개 블록", exact: true })
      .click();
    await expect(page.getByLabel("원본 블록 목록")).toBeVisible();
    await page
      .locator(".blog-references")
      .screenshot({ path: testInfo.outputPath("saved-results.png") });
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

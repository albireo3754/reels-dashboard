import { expect, test, type Page } from "@playwright/test";

const snapshot = {
  schemaVersion: 1,
  generatedAt: "2026-10-27T12:00:00.000Z",
  projects: [
    {
      id: "shared-visit",
      title: "Shared synthetic visit",
      date: "2026-10-26",
      stage: "review",
      nextAction: "Review the opening scene",
      publicURL: "https://example.com/published-video",
    },
  ],
};

async function mockSnapshot(page: Page, value: unknown, status = 200) {
  await page.route("**/snapshot.json", async (route) => {
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(value),
    });
  });
}

test("web mode renders the shared snapshot and exposes no local Photos controls", async ({
  page,
}, testInfo) => {
  await mockSnapshot(page, snapshot);
  await page.goto("/");
  await expect(
    page.getByText("Shared synthetic visit", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Review the opening scene", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /게시|영상|링크/ }),
  ).toHaveAttribute("href", "https://example.com/published-video");
  await expect(
    page.getByRole("button", { name: "날짜 색인", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "원본 이동 실행", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "새 콘텐츠", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("shared-dashboard-desktop.png"),
    fullPage: true,
  });
  for (const tab of ["촬영 보관함", "내보내기", "설정"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await expect(
      page.getByText("촬영본 작업은 데스크톱에서 이어가요.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "날짜 색인", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "원본 이동 실행", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "선택한 현황 동기화", exact: true }),
    ).toHaveCount(0);
  }
});

test("empty shared snapshot remains empty instead of displaying demo projects", async ({
  page,
}) => {
  await mockSnapshot(page, { ...snapshot, projects: [] });
  await page.goto("/");
  await expect(page.getByText("도쿄의 오후 산책", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("골목에서 찾은 커피", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(/아직|없어요|비어/).first()).toBeVisible();
});

for (const invalid of [
  { name: "schema version", value: { ...snapshot, schemaVersion: 2 } },
  {
    name: "missing project field",
    value: { ...snapshot, projects: [{ id: "bad" }] },
  },
  {
    name: "unsafe link",
    value: {
      ...snapshot,
      projects: [{ ...snapshot.projects[0], publicURL: "javascript:alert(1)" }],
    },
  },
  {
    name: "invalid timestamp",
    value: { ...snapshot, generatedAt: "not-a-date" },
  },
]) {
  test(`web mode reports invalid ${invalid.name} without a demo fallback`, async ({
    page,
  }) => {
    await mockSnapshot(page, invalid.value);
    await page.goto("/");
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(
      page.getByText("도쿄의 오후 산책", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Shared synthetic visit", { exact: true }),
    ).toHaveCount(0);
  });
}

test("network failure is reported rather than treated as an empty successful snapshot", async ({
  page,
}) => {
  await mockSnapshot(page, { error: "unavailable" }, 503);
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText(/불러오지 못|연결|현황/);
});

test("web snapshot can be refreshed after a temporary network failure", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/snapshot.json", async (route) => {
    requests += 1;
    await route.fulfill({
      status: requests === 1 ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify(requests === 1 ? { error: "temporary" } : snapshot),
    });
  });
  await page.goto("/");
  await expect(page.getByRole("alert")).toBeVisible();
  await page
    .getByRole("button", { name: "현황 새로고침", exact: true })
    .click();
  await expect(
    page.getByText("Shared synthetic visit", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("mobile shared dashboard is readable without horizontal overflow", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockSnapshot(page, snapshot);
  await page.goto("/");
  await expect(
    page.getByText("Shared synthetic visit", { exact: true }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: testInfo.outputPath("shared-dashboard-mobile.png"),
    fullPage: true,
  });
});

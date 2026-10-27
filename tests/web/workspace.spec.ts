import { expect, test, type Page } from "@playwright/test";

// All library operations here use synthetic fixtures. These tests never open,
// export, move or delete assets from the machine's actual Photos library.
async function openDemo(page: Page, query = "") {
  await page.goto(`/?demo=1${query ? `&${query}` : ""}`);
  await expect(
    page.getByRole("heading", { name: "작업의 흐름을 한눈에", exact: true }),
  ).toBeVisible();
}

async function openLibrary(page: Page) {
  await page.getByRole("button", { name: "촬영 보관함", exact: true }).click();
}

async function indexDate(page: Page, level = "fine") {
  await openLibrary(page);
  await page.getByLabel("촬영 날짜", { exact: true }).fill("2026-08-16");
  await page.getByLabel("그룹 크기", { exact: true }).selectOption(level);
  await page.getByRole("button", { name: "날짜 색인", exact: true }).click();
}

async function openFirstGroup(page: Page) {
  await indexDate(page);
  await page
    .getByRole("button", { name: /그룹 .* · \d+개/ })
    .first()
    .click();
}

async function prepareDecision(page: Page) {
  await openFirstGroup(page);
  await page.getByRole("button", { name: "모두 포함", exact: true }).click();
  await page
    .getByLabel("콘텐츠 이름", { exact: true })
    .fill("Synthetic café visit");
  await page.getByLabel("판단 신뢰도", { exact: true }).fill("0.95");
  await page.getByRole("button", { name: "선택 검증", exact: true }).click();
}

async function preparePlan(page: Page, kind: "copy" | "move") {
  await prepareDecision(page);
  await page.getByRole("button", { name: "목적지 선택", exact: true }).click();
  await page
    .getByRole("button", {
      name: kind === "copy" ? "복사 계획 만들기" : "이동 계획 만들기",
      exact: true,
    })
    .click();
}

test("demo clearly identifies synthetic data and has no renderer exceptions", async ({
  page,
}, testInfo) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await openDemo(page);
  await expect(page.getByRole("note")).toContainText("예시 데이터");
  await page.screenshot({
    path: testInfo.outputPath("dashboard-desktop.png"),
    fullPage: true,
  });
  expect(failures).toEqual([]);
});

const permissionLabels: Record<string, string> = {
  authorized: "허용됨",
  limited: "일부 사진만 허용",
  denied: "접근 거부됨",
  restricted: "시스템에서 제한됨",
  "not-determined": "아직 요청하지 않음",
  unknown: "상태 확인 필요",
};
for (const permission of Object.keys(permissionLabels)) {
  test(`Photos permission ${permission} is visible and never silently upgraded`, async ({
    page,
  }) => {
    await openDemo(page, `demoPermission=${permission}`);
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await expect(
      page.getByText(`Photos ${permissionLabels[permission]}`, { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "상태 새로고침", exact: true })
      .click();
    await expect(
      page.getByText(`Photos ${permissionLabels[permission]}`, { exact: true }),
    ).toBeVisible();
  });
}

test("denied permission prevents indexing and explicit authorization updates the state", async ({
  page,
}) => {
  await openDemo(page, "demoPermission=denied");
  await openLibrary(page);
  await expect(
    page.getByRole("button", { name: "날짜 색인", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page
    .getByRole("button", { name: "Photos 접근 요청", exact: true })
    .click();
  await expect(page.getByText("Photos 허용됨", { exact: true })).toBeVisible();
  await indexDate(page);
  await expect(
    page.getByRole("button", { name: /그룹 .* · \d+개/ }).first(),
  ).toBeVisible();
});

test("protocol mismatch is reported instead of showing a healthy connection", async ({
  page,
}) => {
  await openDemo(page, "demoProtocol=2");
  await expect(page.getByRole("alert")).toContainText(
    /protocol|프로토콜|버전/i,
  );
  await openLibrary(page);
  await expect(
    page.getByRole("button", { name: "날짜 색인", exact: true }),
  ).toBeDisabled();
});

test("connection error can be retried without inventing an authorized status", async ({
  page,
}) => {
  await openDemo(page, "demoError=status");
  await expect(page.getByRole("alert")).toContainText("status");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await expect(
    page.getByText("네이티브 연결 확인 필요", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "상태 새로고침", exact: true })
    .click();
  await expect(page.getByText("Photos 허용됨", { exact: true })).toBeVisible();
});

test("date index supports fine and coarse groups and resets stale selection", async ({
  page,
}) => {
  await openDemo(page);
  await openFirstGroup(page);
  await expect(page.getByLabel(/^자산 분류 /).first()).toBeVisible();
  await page.getByLabel("그룹 크기", { exact: true }).selectOption("coarse");
  await page.getByRole("button", { name: "날짜 색인", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /그룹 .* · \d+개/ }).first(),
  ).toBeVisible();
  await expect(page.getByLabel(/^자산 분류 /)).toHaveCount(0);
  await page
    .getByRole("button", { name: /그룹 .* · \d+개/ })
    .first()
    .click();
  await expect(page.getByLabel(/^자산 분류 /).first()).toBeVisible();
});

test("inspection shows paginated evidence, OCR and privacy warnings", async ({
  page,
}, testInfo) => {
  await openDemo(page);
  await openFirstGroup(page);
  await page
    .getByRole("button", { name: "미리보기 만들기", exact: true })
    .click();
  await expect(page.getByText(/이메일 가림|REDACTED/).first()).toBeVisible();
  await expect(
    page.getByText("face-detected", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "이전 페이지", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath("library-evidence.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "다음 페이지", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "다음 페이지", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "이전 페이지", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "이전 페이지", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "이전 페이지", exact: true }),
  ).toBeDisabled();
});

test("evidence timeout is visible and the same page can be retried", async ({
  page,
}) => {
  await openDemo(page, "demoError=evidence-timeout");
  await openFirstGroup(page);
  await page
    .getByRole("button", { name: "미리보기 만들기", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(/timeout|시간|완료되지/i);
  await page
    .getByRole("button", { name: "미리보기 만들기", exact: true })
    .click();
  await expect(page.getByText(/이메일 가림|REDACTED/).first()).toBeVisible();
});

test("all three evidence pages preserve their 12, 12, 2 asset coverage", async ({
  page,
}) => {
  await openDemo(page, "demoAssets=26");
  await openFirstGroup(page);
  await page
    .getByRole("button", { name: "미리보기 만들기", exact: true })
    .click();
  await expect(page.getByRole("img", { name: /미리보기$/ })).toHaveCount(12);
  await expect(
    page.getByText("미리보기 1 / 3페이지", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "다음 페이지", exact: true }).click();
  await expect(page.getByRole("img", { name: /미리보기$/ })).toHaveCount(12);
  await expect(
    page.getByText("미리보기 2 / 3페이지", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "이전 페이지", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "다음 페이지", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "다음 페이지", exact: true }).click();
  await expect(page.getByRole("img", { name: /미리보기$/ })).toHaveCount(2);
  await expect(
    page.getByText("미리보기 3 / 3페이지", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "다음 페이지", exact: true }),
  ).toBeDisabled();
});

test("partial evidence displays missing-preview warning and retains asset selection coverage", async ({
  page,
}) => {
  await openDemo(page, "demoPartial=1");
  await openFirstGroup(page);
  await page
    .getByRole("button", { name: "미리보기 만들기", exact: true })
    .click();
  await expect(page.getByText(/partial-evidence:/)).toBeVisible();
  await expect(page.getByRole("img", { name: /미리보기$/ })).toHaveCount(11);
  await expect(page.getByLabel(/^자산 분류 /)).toHaveCount(15);
});

test("incomplete decision, low confidence and unresolved unknowns are rejected", async ({
  page,
}) => {
  await openDemo(page);
  await openFirstGroup(page);
  await page.getByLabel("콘텐츠 이름", { exact: true }).fill("Synthetic visit");
  await page.getByRole("button", { name: "선택 검증", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "모두 포함", exact: true }).click();
  await page.getByLabel("판단 신뢰도", { exact: true }).fill("0.4");
  await page.getByRole("button", { name: "선택 검증", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(/신뢰|confidence|0\.8/i);
  await page.getByLabel("판단 신뢰도", { exact: true }).fill("0.95");
  await page.getByLabel("미해결 사항", { exact: true }).fill("Unknown venue");
  await page.getByRole("button", { name: "선택 검증", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(/미해결|unknown/i);
});

test("copy requires reviewing its plan and completes with a receipt", async ({
  page,
}) => {
  await openDemo(page);
  await preparePlan(page, "copy");
  const apply = page.getByRole("button", { name: "복사 실행", exact: true });
  await expect(apply).toBeDisabled();
  await page.getByLabel("계획을 검토했어요", { exact: true }).check();
  await apply.click();
  await expect(
    page.getByRole("heading", { name: "작업 결과", exact: true }),
  ).toBeVisible();
});

test("saved decision can be imported and must be validated again", async ({
  page,
}) => {
  await openDemo(page, "demoDocument=decision");
  await prepareDecision(page);
  await page
    .getByRole("button", { name: "분류 파일 저장", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("분류를 저장했어요");
  await page
    .getByLabel("콘텐츠 이름", { exact: true })
    .fill("Unsaved replacement");
  await page
    .getByLabel(/^자산 분류 /)
    .first()
    .selectOption("excluded");
  await page
    .getByRole("button", { name: "분류 파일 불러오기", exact: true })
    .click();
  await expect(page.getByLabel("콘텐츠 이름", { exact: true })).toHaveValue(
    "Synthetic café visit",
  );
  await expect(page.getByLabel(/^자산 분류 /).first()).toHaveValue("included");
  await page.getByRole("button", { name: "목적지 선택", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "복사 계획 만들기", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "선택 검증", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "복사 계획 만들기", exact: true }),
  ).toBeEnabled();
});

test("duplicate IDs in an imported decision are rejected without normalizing them away", async ({
  page,
}) => {
  await openDemo(page, "demoDocument=decision&demoDocumentInvalid=duplicate");
  await prepareDecision(page);
  await page
    .getByRole("button", { name: "분류 파일 저장", exact: true })
    .click();
  await page
    .getByLabel("콘텐츠 이름", { exact: true })
    .fill("Keep this unsaved title");
  await page
    .getByLabel(/^자산 분류 /)
    .first()
    .selectOption("excluded");
  await page
    .getByRole("button", { name: "분류 파일 불러오기", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(/중복|duplicate/i);
  await expect(page.getByLabel("콘텐츠 이름", { exact: true })).toHaveValue(
    "Keep this unsaved title",
  );
  await expect(page.getByLabel(/^자산 분류 /).first()).toHaveValue("excluded");
});

test("move requires a separate source-deletion acknowledgement", async ({
  page,
}) => {
  await openDemo(page);
  await preparePlan(page, "move");
  const apply = page.getByRole("button", {
    name: "원본 이동 실행",
    exact: true,
  });
  await expect(apply).toBeDisabled();
  await page.getByLabel("계획을 검토했어요", { exact: true }).check();
  await expect(apply).toBeDisabled();
  await page
    .getByLabel("Photos 원본이 최근 삭제 항목으로 이동함을 확인했어요", {
      exact: true,
    })
    .check();
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(
    page.getByRole("heading", { name: "작업 결과", exact: true }),
  ).toBeVisible();
});

test("changing a selection invalidates a previously reviewed plan", async ({
  page,
}) => {
  await openDemo(page);
  await preparePlan(page, "copy");
  await page.getByLabel("계획을 검토했어요", { exact: true }).check();
  await openLibrary(page);
  await page
    .getByLabel(/^자산 분류 /)
    .first()
    .selectOption("excluded");
  await page.getByRole("button", { name: "내보내기", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "복사 실행", exact: true }),
  ).toHaveCount(0);
});

test("copy failure remains a failure until the same operation succeeds", async ({
  page,
}) => {
  await openDemo(page, "demoError=export.apply");
  await preparePlan(page, "copy");
  await page.getByLabel("계획을 검토했어요", { exact: true }).check();
  await page.getByRole("button", { name: "복사 실행", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("export.apply");
  await page.getByRole("button", { name: "복사 실행", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "작업 결과", exact: true }),
  ).toBeVisible();
});

for (const failure of ["icloud-upload-timeout", "source-delete-failed"]) {
  test(`failed move ${failure} supports loading and retrying its same plan`, async ({
    page,
  }) => {
    await openDemo(page, `demoError=${failure}`);
    await preparePlan(page, "move");
    await page.getByLabel("계획을 검토했어요", { exact: true }).check();
    await page
      .getByLabel("Photos 원본이 최근 삭제 항목으로 이동함을 확인했어요", {
        exact: true,
      })
      .check();
    await page
      .getByRole("button", { name: "원본 이동 실행", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText(failure);
    await page
      .getByRole("button", { name: "기존 계획 불러오기", exact: true })
      .click();
    await page.getByLabel("복구 digest", { exact: true }).fill("b".repeat(64));
    await page
      .getByLabel("같은 이동의 원본 삭제와 복구 내용을 확인했어요", {
        exact: true,
      })
      .check();
    await page
      .getByRole("button", { name: "같은 이동 재시도", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "작업 결과", exact: true }),
    ).toBeVisible();
  });
}

test("empty capture date reports no groups and does not retain previous assets", async ({
  page,
}) => {
  await openDemo(page);
  await openFirstGroup(page);
  await page.getByLabel("촬영 날짜", { exact: true }).fill("1900-01-01");
  await page.getByRole("button", { name: "날짜 색인", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /그룹 .* · \d+개/ }),
  ).toHaveCount(0);
  await expect(page.getByLabel(/^자산 분류 /)).toHaveCount(0);
  await expect(page.getByText(/없어요|찾지 못|0개/).first()).toBeVisible();
});

test("existing move recovery does not require an active indexed group", async ({
  page,
}) => {
  await openDemo(page);
  await page.getByRole("button", { name: "내보내기", exact: true }).click();
  await page
    .getByRole("button", { name: "기존 계획 불러오기", exact: true })
    .click();
  const retry = page.getByRole("button", {
    name: "같은 이동 재시도",
    exact: true,
  });
  await page.getByLabel("복구 digest", { exact: true }).fill("b".repeat(64));
  await expect(retry).toBeDisabled();
  await page
    .getByLabel("같은 이동의 원본 삭제와 복구 내용을 확인했어요", {
      exact: true,
    })
    .check();
  await retry.click();
  await expect(
    page.getByRole("heading", { name: "작업 결과", exact: true }),
  ).toBeVisible();
});

test("recovery rejects a wrong digest and changing it clears acknowledgement", async ({
  page,
}) => {
  await openDemo(page);
  await page.getByRole("button", { name: "내보내기", exact: true }).click();
  await page
    .getByRole("button", { name: "기존 계획 불러오기", exact: true })
    .click();
  await page.getByLabel("복구 digest", { exact: true }).fill("0".repeat(64));
  await page
    .getByLabel("같은 이동의 원본 삭제와 복구 내용을 확인했어요", {
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "같은 이동 재시도", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("digest-mismatch");
  await expect(
    page.getByRole("heading", { name: "작업 결과", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("복구 digest", { exact: true }).fill("b".repeat(64));
  await expect(
    page.getByRole("button", { name: "같은 이동 재시도", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("같은 이동의 원본 삭제와 복구 내용을 확인했어요", {
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "같은 이동 재시도", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "작업 결과", exact: true }),
  ).toBeVisible();
});

test("small viewport retains accessible navigation without horizontal overflow", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDemo(page);
  await openFirstGroup(page);
  await expect(page.getByLabel("콘텐츠 이름", { exact: true })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: testInfo.outputPath("library-mobile.png"),
    fullPage: true,
  });
});

test("navigation and project creation can be activated from the keyboard", async ({
  page,
}) => {
  await openDemo(page);
  await page.getByRole("button", { name: "설정", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "내 작업 환경", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "대시보드", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "새 콘텐츠", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("콘텐츠 제목", { exact: true })).toBeFocused();
  await page.keyboard.type("Keyboard synthetic project");
  await page.getByRole("button", { name: "저장", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", {
      name: "Keyboard synthetic project",
      exact: true,
    }),
  ).toBeVisible();
});

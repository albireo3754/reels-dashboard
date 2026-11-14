import { test, expect } from "@playwright/test";
import { mkdir, writeFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { launchApp, makeProfile, closeApp, cleanProfile } from "./helpers";
import { callAgent } from "../../src/shared/lib/agent-socket";
test("project analysis UI searches, corrects and persists through IPC; MCP reads same data", async () => {
  const profile = await realpath(await makeProfile());
  let app;
  try {
    const project = {
      id: "analysis-demo",
      title: "분석 테스트",
      date: "2026-10-31",
      stage: "review",
      nextAction: "",
      publicURL: "",
      shared: false,
      resources: [],
    };
    await writeFile(
      path.join(profile, "dashboard.json"),
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: "2026-10-31T00:00:00.000Z",
        projects: [project],
      }),
    );
    await mkdir(path.join(profile, "media-analysis"));
    const doc = {
      schemaVersion: 1,
      context: {
        venue: "테스트 식당",
        location: "테스트 지역",
        visit: "2026-09-23",
        menus: "테스트 생맥주",
        surroundings: "야외석",
        notes: "확인한 기록",
        sources: ["테스트 출처"],
      },
      projectId: project.id,
      revision: 1,
      runs: [],
      corrections: {},
      results: [
        {
          sample: {
            id: "s1",
            sourcePath: "/synthetic/glasses.mov",
            sourceVersion: "v1",
            kind: "video-frame",
            time: 1.5,
            imagePath: "/synthetic/frame.jpg",
          },
          provider: "codex",
          runId: "run",
          analyzedAt: "2026-10-31T00:00:00.000Z",
          fields: {
            contextNotes: ["주문 기록으로 생맥주 이름을 확인했어요."],
            description: "테이블 위 맥주잔 두 개",
            tags: ["맥주", "야외 테이블"],
            ocr: [],
            uncertainties: ["건배 동작 미확인"],
          },
        },
      ],
    };
    await writeFile(
      path.join(
        profile,
        "media-analysis",
        createHash("sha256").update(project.id).digest("hex") + ".json",
      ),
      JSON.stringify(doc),
    );
    app = await launchApp(profile, false);
    const page = await app.firstWindow();
    await page
      .getByRole("button", { name: "사진·영상 메타데이터 분석", exact: true })
      .click();
    await expect(
      page.getByText("테이블 위 맥주잔 두 개", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("기록 근거: 주문 기록으로 생맥주 이름을 확인했어요."),
    ).toBeVisible();
    await page
      .getByText("분석에 함께 전달할 가게·메뉴·방문 정보", { exact: true })
      .click();
    await expect(
      page.getByLabel("주문 메뉴·정확한 이름·곁들임", { exact: true }),
    ).toHaveValue("테스트 생맥주");
    await page
      .getByLabel("주문 메뉴·정확한 이름·곁들임", { exact: true })
      .fill("아직 저장하지 않은 수정");
    await page.getByLabel("설명·태그·OCR 검색").fill("없는단어");
    await expect(page.getByText("0개 결과", { exact: true })).toBeVisible();
    await expect(
      page.getByLabel("주문 메뉴·정확한 이름·곁들임", { exact: true }),
    ).toHaveValue("아직 저장하지 않은 수정");
    await page
      .getByText("분석에 함께 전달할 가게·메뉴·방문 정보", { exact: true })
      .click();
    await page.getByLabel("설명·태그·OCR 검색").fill("맥주");
    await expect(page.getByText("1개 결과", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "설명 수정", exact: true }).click();
    await page.getByLabel("수정 설명").fill("직접 수정한 야외 맥주잔");
    await page.getByRole("button", { name: "수정 저장", exact: true }).click();
    await expect(
      page.getByText("직접 수정한 야외 맥주잔", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: "artifacts/analysis-panel.png" });
    const result = (await callAgent(profile, "reels_search_analysis", {
      projectId: project.id,
      query: "직접",
    })) as any;
    expect(result.matches[0].effective.description).toBe(
      "직접 수정한 야외 맥주잔",
    );
    expect(result.matches[0].fields.description).toBe("테이블 위 맥주잔 두 개");
    const selection = await callAgent(profile, "reels_get_analysis_selection", { projectId: project.id }) as any;
    expect(selection.candidates).toEqual([]);
    expect(selection.groups).toEqual([]);
    expect(selection.usage).toEqual([]);
    await expect(
      page.evaluate(() =>
        window.reels!.analysis!.start({
          projectId: "analysis-demo",
          folder: "/tmp",
          provider: "codex",
        }),
      ),
    ).rejects.toThrow();
    await closeApp(app);
    app = undefined;
    app = await launchApp(profile, false);
    const p = await app.firstWindow();
    await p
      .getByRole("button", { name: "사진·영상 메타데이터 분석", exact: true })
      .click();
    await expect(
      p.getByText("직접 수정한 야외 맥주잔", { exact: true }),
    ).toBeVisible();
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

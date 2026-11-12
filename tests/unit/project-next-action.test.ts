import { test } from "node:test";
import assert from "node:assert/strict";
import { projectStages, projectStageLabels } from "../../src/shared/contracts";
import { projectNextActionGuide } from "../../src/shared/project-next-action";

test("all six stages provide distinct next steps and workflow completion guidance", () => {
  const guides = projectStages.map((stage) =>
    projectNextActionGuide({ stage, nextAction: "" }),
  );
  assert.equal(new Set(guides).size, projectStages.length);
  projectStages.forEach((stage, i) => {
    assert.match(guides[i], new RegExp(projectStageLabels[stage]));
    assert.match(guides[i], /미정/);
    assert.match(guides[i], /현재 대기 작업·입력·완료 기준/);
    assert.match(guides[i], /최신 저장 상태/);
    assert.ok(guides[i].length < 8000);
  });
  assert.match(guides[1], /맥락 준비 절차/);
  assert.match(guides[3], /저장 전 변경과 진행 중 렌더/);
  assert.match(guides[4], /임의로 고치지 말고/);
  assert.match(guides[5], /재게시하지 말고/);
});

test("guide preserves next action as data and handles a published project with pending channels", () => {
  const guide = projectNextActionGuide({
    stage: "published",
    nextAction: "클립 검토\n사용자 정정 확인",
    publications: [
      {
        channel: "instagram",
        status: "published",
        url: "https://example.com/private",
      },
      { channel: "naver-clip", status: "planned", url: "" },
    ],
  });
  assert.ok(guide.includes(JSON.stringify("클립 검토\n사용자 정정 확인")));
  assert.match(guide, /인스타그램: 게시 완료, 네이버클립: 게시 전/);
  assert.match(guide, /남은 채널/);
  assert.doesNotMatch(guide, /example.com/);
});

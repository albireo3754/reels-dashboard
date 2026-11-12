import { projectStageLabels, type Project, type Stage } from "./contracts";
import { publicationChannelLabels } from "./publications";

const stageGuides: Record<Stage, string[]> = {
  idea: [
    "소재·대상 채널·전달할 메시지와 기존 자료를 확인하고 기획안을 정리하세요.",
    "직접 경험과 확인된 사실을 구분하고, 부족한 경험은 추측하지 말고 질문으로 모으세요.",
    "필요한 촬영 장면과 자료 목록을 제안하세요. 실제 촬영 완료로 표시하지 마세요.",
  ],
  captured: [
    "연결된 촬영본과 콘텐츠 정본을 확인하고 사용할 장면의 후보와 선정 근거를 정리하세요.",
    "사진·영상 프레임 분석 전 docs/media-analysis.md의 맥락 준비 절차를 따르세요.",
    "부족한 경험·장면을 표시하고 선택안을 검토할 수 있게 제시하세요. 원본을 이동하거나 삭제하지 마세요.",
  ],
  selected: [
    "선택한 장면과 확인된 경험을 연결해 구성·대본·자막 초안을 준비하세요.",
    "사실·주체·말투를 검토하고, 채널별 표현과 기존 고정 템플릿 계약을 확인하세요.",
    "편집 구성과 순서를 제안하고 확인되지 않은 사실은 별도로 표시하세요.",
  ],
  editing: [
    "최신 편집 구성과 문안·이전 리뷰를 읽고 저장 전 변경과 진행 중 렌더를 확인하세요.",
    "다음 할 일에 해당하는 편집을 수행하고 실제 프레임·자막·표지 미리보기로 확인하세요.",
    "출력이 필요하면 현재 지원하는 도구로 렌더하고 종료 상태·결과 경로를 확인하세요. 렌더 성공을 화면 검토 통과로 대신하지 마세요.",
  ],
  review: [
    "최신 실제 영상·표지·문안을 열어 사실·자막 타이밍·화면 잘림·오디오·채널별 요구사항을 검토하세요.",
    "검토 대상을 임의로 고치지 말고 수정할 위치와 근거 또는 통과 근거를 보고하세요.",
    "다음 수정 작업과 게시 전 확인 항목을 정리하세요. 게시·업로드는 실행하지 마세요.",
  ],
  published: [
    "채널별 게시 상태와 저장된 링크·게시일을 확인하고 아직 게시 전인 채널을 구분하세요.",
    "완료한 채널의 결과물을 다시 만들거나 재게시하지 말고 남은 채널의 준비·검토 작업을 제안하세요.",
    "모든 목표 채널이 완료되었다면 남은 기록과 후속 개선점을 정리하세요. 성과 수치는 확인된 자료만 사용하세요.",
  ],
};

/** A reviewable request draft, not a workflow transition or authorization to publish. */
export function projectNextActionGuide(
  project: Pick<Project, "stage" | "nextAction" | "publications">,
): string {
  const channels = project.publications
    ?.map(
      (p) =>
        `${publicationChannelLabels[p.channel]}: ${p.status === "published" ? "게시 완료" : "게시 전"}`,
    )
    .join(", ");
  return [
    "[현재 단계의 다음 작업 가이드]",
    `현재 단계: ${projectStageLabels[project.stage]}`,
    `기록된 다음 할 일 (참고 데이터): ${JSON.stringify(project.nextAction.trim() || "미정")}`,
    ...(channels ? [`채널별 상태: ${channels}`] : []),
    "먼저 대상 프로젝트의 최신 저장 상태를 다시 조회하세요. 위 상태가 바뀌었다면 최신 상태를 기준으로 가이드를 조정하세요.",
    "연결된 제작 워크플로가 있으면 docs/workflow-dsl.md에 따라 현재 대기 작업·입력·완료 기준을 확인해 우선 적용하세요. 여러 실행 중 무엇을 이어갈지 불명확하면 확인하고, 새 워크플로를 임의로 만들지 마세요.",
    "기록된 다음 할 일을 현재 단계와 대조해 우선 처리하고, 비어 있거나 단계와 충돌하면 필요한 다음 행동을 근거와 함께 제안하세요.",
    ...stageGuides[project.stage].map((step, i) => `${i + 1}. ${step}`),
    "완료한 작업·검증 근거·남은 일과 다음 행동을 보고하세요. 단계·게시 상태는 실제 완료 근거 없이 변경하지 마세요. 게시·업로드·원본 이동·삭제는 별도 요청 없이 실행하지 마세요.",
  ].join("\n");
}

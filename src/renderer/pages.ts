import type { Stage } from "../shared/contracts";

export type Tab =
  | "dashboard"
  | "library"
  | "editor"
  | "cards"
  | "workflow"
  | "logs"
  | "blog"
  | "transfers"
  | "settings";

type Page = {
  label: string;
  eyebrow: string;
  title: string;
  description: string;
};

/** Navigation label and page heading copy for each workspace screen. */
export const pages: Record<Tab, Page> = {
  dashboard: {
    label: "대시보드",
    eyebrow: "YOUR CREATIVE FLOW",
    title: "작업의 흐름을 한눈에",
    description: "촬영부터 게시까지, 지금 필요한 다음 작업을 확인해요.",
  },
  library: {
    label: "촬영 보관함",
    eyebrow: "FROM YOUR CAMERA",
    title: "다음 이야기를 골라요",
    description:
      "Apple Photos에서 날짜별 촬영본을 찾고 콘텐츠에 사용할 장면을 골라요.",
  },
  editor: {
    label: "영상 편집",
    eyebrow: "MAKE YOUR REEL",
    title: "선택한 장면을 완성해요",
    description:
      "장소 안내 묶음과 본문 자막을 더하고, 선택한 시점으로 표지를 만들어요.",
  },
  cards: {
    label: "카드뉴스 릴스",
    eyebrow: "CARD NEWS · TIMING & MUSIC",
    title: "읽는 속도에 맞춰 이야기를 전해요",
    description: "사진·문구·음악을 구성하고 카드뉴스 릴스를 MP4로 내보내요.",
  },
  blog: {
    label: "블로그",
    eyebrow: "BLOG WORKSPACE",
    title: "원고와 사진을 함께 살펴봐요",
    description: "원고와 사진의 순서를 정하고 미리 확인해요.",
  },
  workflow: {
    label: "워크플로",
    eyebrow: "워크플로",
    title: "작업을 이어가고, 검토를 쌓아요",
    description: "세션에서 수행하는 제작 작업의 순서와 검토 이력을 관리해요.",
  },
  transfers: {
    label: "내보내기",
    eyebrow: "REVIEW & TRANSFER",
    title: "확인하고, 안전하게 옮겨요",
    description: "원본을 유지하는 복사와 검증 후 이동을 구분해서 실행해요.",
  },
  logs: {
    label: "실행 로그",
    eyebrow: "실행 로그",
    title: "실행 중인 처리와 종료 이력",
    description: "앱에서 실행한 영상 처리의 진행과 결과를 확인해요.",
  },
  settings: {
    label: "설정",
    eyebrow: "WORKSPACE SETTINGS",
    title: "내 작업 환경",
    description: "로컬 연결과 모바일에서 볼 현황의 공유 범위를 관리해요.",
  },
};

export const stageLabels: Record<Stage, string> = {
  idea: "아이디어",
  captured: "촬영 완료",
  selected: "촬영본 선택",
  editing: "편집 중",
  review: "검토 대기",
  published: "게시 완료",
};

export const permissionLabels: Record<string, string> = {
  "not-determined": "아직 요청하지 않음",
  authorized: "허용됨",
  limited: "일부 사진만 허용",
  denied: "접근 거부됨",
  restricted: "시스템에서 제한됨",
  unknown: "상태 확인 필요",
};

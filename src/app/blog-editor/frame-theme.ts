/**
 * 원고 frame(별도 문서) 안에 그리는 편집 UI의 색·글꼴.
 * frame은 tokens.css를 불러오지 못하므로 같은 값을 리터럴로 여기 한곳에 모은다.
 * 중립색·강조색·상태색은 src/shared/ui/tokens.css와 같은 값을 유지한다.
 * 원고 자체의 색(글자색 팔레트, 레이아웃 CSS)은 여기 두지 않는다.
 */
export const FRAME_UI = {
  font: '-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard","Noto Sans KR","Segoe UI",sans-serif',
  mono: 'ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace',
  // --color-text / -muted / -subtle
  text: "#37352f",
  muted: "#6b6a66",
  subtle: "#72716c",
  // --color-border(hairline) / --color-border-strong
  border: "#e9e9e7",
  borderStrong: "#d3d2ce",
  // --color-surface / --color-surface-muted
  surface: "#ffffff",
  surfaceMuted: "#f7f7f5",
  // --color-hover / --color-selected
  hover: "rgb(55 53 47 / 6%)",
  selected: "rgb(55 53 47 / 9%)",
  // --color-primary / -hover / -soft
  primary: "#386354",
  primaryHover: "#224d3c",
  primarySoft: "#eef4f0",
  // --color-focus
  focus: "rgb(56 99 84 / 55%)",
  // --color-warning / -soft / -text
  warning: "#b67c36",
  warningSoft: "#fdf8ef",
  warningText: "#85581f",
  // --shadow-popover
  shadow:
    "0 0 0 1px rgb(15 15 15 / 5%),0 3px 6px rgb(15 15 15 / 10%),0 9px 24px rgb(15 15 15 / 20%)",
  // 인라인 diff는 의미색이라 유지한다(빨간 취소선 = 삭제, 초록 밑줄 = 추가).
  del: "#b3261e",
  delSoft: "#fde2df",
  ins: "#13612e",
  insSoft: "#d9f3df",
  insLine: "#4f9a64",
  insActive: "#bdebc9",
  target: "#eef2f7",
  targetLine: "#7d8aa0",
  mark: "#fff0b3",
  // 추천 고스트 글자색. canonical-tab-suggest spec이 계산값 rgb(154, 162, 156)을 고정한다.
  ghost: "#9aa29c",
} as const;

const ui = FRAME_UI;

/**
 * frame 문서의 편집 chrome(문단 포커스, 묶음 이름표·선택, 저장 전 사진 표시).
 * 원고 레이아웃 CSS 뒤에 붙고, 편집 전용 셀렉터만 다룬다.
 */
export const EDITOR_FRAME_CSS = [
  "body{background:white}",
  "main,main.mobile{width:100%;margin:0 auto;padding:16px 20px 24px;box-sizing:border-box}",
  "header{margin-bottom:20px}",
  "[contenteditable]{outline:none;cursor:text;min-height:1em}",
  // 캐럿이 주 표시이고, 포커스 문단은 hairline 하나로만 알린다.
  `[contenteditable]:focus{outline:1px solid ${ui.border};outline-offset:6px;border-radius:2px}`,
  // 이름표는 묶음을 고르는 손잡이. 평소엔 옅게, 묶음에 올리거나 활성일 때 또렷하게.
  `.editor-bundle-label{font:11px/1.5 ${ui.font};color:${ui.subtle};opacity:.55;text-align:left;margin:8px 0 10px;cursor:pointer;transition:opacity .12s}`,
  ".editor-bundle:hover>.editor-bundle-label,.editor-bundle.active>.editor-bundle-label,.editor-bundle.picked>.editor-bundle-label{opacity:1}",
  `.editor-bundle.active{box-shadow:inset 2px 0 ${ui.borderStrong}}`,
  `.editor-bundle.picked{outline:2px solid ${ui.primary};outline-offset:6px;border-radius:2px}`,
  ".editor-bundle[hidden]{display:none}",
  `[data-pending-photo]{position:relative;outline:1px dashed ${ui.primary};outline-offset:4px}`,
  `[data-pending-photo]::after{content:"저장 전 사진";position:absolute;top:8px;left:8px;padding:1px 6px;border-radius:4px;background:${ui.surface};color:${ui.primary};box-shadow:0 0 0 1px ${ui.border};font:11px/1.5 ${ui.font}}`,
].join("");

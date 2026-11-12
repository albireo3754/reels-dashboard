/** Request sent to a new agent terminal by the board's "프로젝트 정리" button. */
export const projectTidyTask = [
  "프로젝트 정리: skills/reels-project-tidy/SKILL.md(설치된 이름 reels-project-tidy) 스킬을 읽고 그대로 실행하세요.",
  "`reels scan-orphan-edits`로 편집기가 따로 만든 카드 전체를 스캔하고, 카드별 검증은 병렬로, 병합은 `reels merge-projects`로 하나씩 하세요.",
  "이 요청이 허용하는 변경은 대시보드 카드 병합뿐이에요. 코드·콘텐츠 문서·미디어는 바꾸지 말고, 근거가 부족한 카드는 남긴 채 이유를 보고하세요.",
].join("\n");

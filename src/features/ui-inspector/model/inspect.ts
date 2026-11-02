export interface InspectionTarget {
  tag: string;
  role?: string;
  sources: string[];
}
const sourcePattern = /^src\/[\w./-]+\.tsx:[1-9]\d*:[1-9]\d*$/;
export function compactSources(sources: string[]): string[] {
  const result: string[] = [];
  let previousFile = "";
  for (const source of sources) {
    if (!sourcePattern.test(source) || source.split("/").includes(".."))
      continue;
    const file = source.replace(/:\d+:\d+$/, "");
    if (file !== previousFile) result.push(source);
    previousFile = file;
  }
  return result.slice(0, 8);
}
export function inspectTarget(element: Element): InspectionTarget {
  const sources: string[] = [];
  for (
    let current: Element | null = element;
    current;
    current = current.parentElement
  ) {
    const source = current.getAttribute("data-reels-source");
    if (source) sources.push(source);
  }
  // Never capture values, textContent, URLs, selectors or arbitrary HTML attributes.
  const role = element.getAttribute("role");
  return {
    tag: element.tagName.toLowerCase(),
    ...(role && /^[a-z-]{1,32}$/.test(role) ? { role } : {}),
    sources: compactSources(sources),
  };
}
export function feedbackPrompt(
  target: InspectionTarget,
  comment: string,
): string {
  return [
    "[Reels Dashboard 화면 수정 요청]",
    `선택 요소: <${target.tag}>${target.role ? ` (role=${target.role})` : ""}`,
    "코드 위치 (가장 안쪽부터):",
    ...(target.sources.length
      ? target.sources.map((source) => `- ${source}`)
      : [
          "- 위치를 확인하지 못했어요. 현재 화면의 관련 코드를 먼저 찾아주세요.",
        ]),
    "",
    "사용자 요청:",
    comment.trim(),
    "",
    "해당 화면의 문제를 확인하고 요청 범위만 수정한 뒤 관련 검증을 실행해주세요.",
  ].join("\n");
}

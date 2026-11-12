/** Local video component contract shared by validation, rendering and asset serving. */
export const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "webm"] as const;
export function localVideoFile(value: unknown): value is string {
  return typeof value === "string" && /^[^/\\:?<>|\u0000-\u001f]+\.(mp4|m4v|mov|webm)$/i.test(value) && !value.startsWith(".");
}
export function videoRatio(value: unknown): number | undefined {
  if (typeof value !== "string") return;
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value);
  const ratio = m && Number(m[1]) / Number(m[2]);
  return ratio && Number.isFinite(ratio) && ratio >= 0.05 && ratio <= 20 ? ratio : undefined;
}
export function videoPosition(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const m = /^(\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%$/.exec(value);
  return m && Number(m[1]) <= 100 && Number(m[2]) <= 100 ? value : undefined;
}
export const videoFlag = (value: unknown) => value === true || value === "true";
export function videoIssues(attrs: Record<string, string | true>): string[] {
  const errors: string[] = [];
  const allowed = new Set(["file", "alt", "poster", "caption", "ratio", "fit", "position", "muted", "loop"]);
  for (const key of Object.keys(attrs)) if (!allowed.has(key)) errors.push(`Video에서 지원하지 않는 속성: ${key}`);
  if (!localVideoFile(attrs.file)) errors.push("Video file은 미디어 폴더 안의 mp4/m4v/mov/webm 파일명이어야 해요.");
  if (attrs.poster !== undefined && (typeof attrs.poster !== "string" || !/^[^/\\:?<>|\u0000-\u001f]+\.(png|jpe?g|webp)$/i.test(attrs.poster) || attrs.poster.startsWith("."))) errors.push("Video poster는 미디어 폴더 안의 이미지 파일명이어야 해요.");
  if (attrs.ratio !== undefined && !videoRatio(attrs.ratio)) errors.push("Video ratio는 유효한 가로:세로 비율이어야 해요.");
  if (attrs.fit !== undefined && !["contain", "cover"].includes(String(attrs.fit))) errors.push("Video fit은 contain 또는 cover예요.");
  if (attrs.position !== undefined && !videoPosition(attrs.position)) errors.push("Video position은 0~100% 두 값이어야 해요. 예: 50% 70%");
  for (const key of ["muted", "loop"]) if (attrs[key] !== undefined && ![true, "true", "false"].includes(attrs[key])) errors.push(`Video ${key}는 true/false 또는 값 없는 속성이에요.`);
  for (const key of ["alt", "caption"]) if (attrs[key] !== undefined && typeof attrs[key] !== "string") errors.push(`Video ${key}는 문자열이어야 해요.`);
  return errors;
}

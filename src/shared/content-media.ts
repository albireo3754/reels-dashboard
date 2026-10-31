import type { LocalResource } from "./contracts";
export type MediaKind =
  | "video"
  | "image"
  | "audio"
  | "folder"
  | "document"
  | "archive";
export interface ContentMediaItem {
  path: string;
  label: string;
  role: LocalResource["role"];
  kind: MediaKind;
  available: boolean;
  bytes?: number;
}
export interface ContentMediaPage {
  items: ContentMediaItem[];
  total: number;
  nextOffset: number | null;
}
export interface ContentMediaBridge {
  list(
    projectId: string,
    folder?: string,
    offset?: number,
  ): Promise<ContentMediaPage>;
  thumbnail(projectId: string, file: string): Promise<string>;
  open(
    projectId: string,
    file: string,
  ): Promise<{ url: string; kind: MediaKind }>;
}
export const resourceLabels = {
  footage: "촬영본",
  final: "완성본",
  cover: "표지",
  draft: "시안",
  document: "문서",
  folder: "폴더",
};
export function mediaKind(file: string): MediaKind {
  const ext = file.split(".").at(-1)?.toLowerCase();
  if (["mp4", "mov", "m4v"].includes(ext ?? "")) return "video";
  if (["png", "jpg", "jpeg", "heic", "webp"].includes(ext ?? ""))
    return "image";
  if (["mp3", "m4a", "wav"].includes(ext ?? "")) return "audio";
  return ext === "zip" ? "archive" : "document";
}

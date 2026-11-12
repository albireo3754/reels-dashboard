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
export interface ContentDocumentText {
  text: string;
  /** The file is longer than the preview cap; `text` holds only the beginning. */
  truncated: boolean;
}
export interface ContentMediaBridge {
  list(
    projectId: string,
    folder?: string,
    offset?: number,
  ): Promise<ContentMediaPage>;
  thumbnail(projectId: string, file: string): Promise<string>;
  /** Text of a linked document (or one inside a linked folder), capped in size. */
  text(projectId: string, file: string): Promise<ContentDocumentText>;
  /**
   * Videos stream the original file by default. `copy` asks for a playback copy
   * after the renderer could not play the original; the main process also picks a
   * copy itself for an iCloud file that is not downloaded.
   */
  open(
    projectId: string,
    file: string,
    options?: ContentMediaOpenOptions,
  ): Promise<OpenedContentMedia>;
  /**
   * Desktop only: asks where to save, then converts a linked video into a silent,
   * looping GIF with the default settings. null when the save panel is cancelled.
   */
  gif?(
    projectId: string,
    file: string,
  ): Promise<import("./gif-convert").GifConvertResult | null>;
}
export interface ContentMediaOpenOptions {
  copy?: boolean;
}
export interface OpenedContentMedia {
  url: string;
  kind: MediaKind;
  /** Videos only: whether the URL streams the original or a playback copy. */
  playback?: "original" | "copy";
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

import type { Project } from "./contracts";

export const maxEditsCaptionLength = 2200;
const captionCharacters = new Intl.Segmenter("ko", { granularity: "grapheme" });
export const countEditsCaption = (text: string) => Array.from(captionCharacters.segment(text)).length;
export const isEditsCaption = (value: unknown): value is string =>
  typeof value === "string" && !value.includes("\0") && countEditsCaption(value) <= maxEditsCaptionLength;

export const editsShareLabel = "인스타그램 최종 게시";

export function canShareInstagramFromEdits(project: Project): boolean {
  return (project.kind ?? "content") === "content" && project.publications?.some(
    ({ channel, status }) => channel === "instagram" && (status === "planned" || status === "draft"),
  ) === true;
}

export type EditsShareBlock = "locked" | "session-unknown" | "permission" | "window" |
  "caption" | "changed" | "cancelled" | "target-used" | "busy" | "unavailable";

export type EditsShareResult =
  | { state: "ready"; token: string; image: string; account: string; caption: string; documentCaption?: string }
  | { state: "blocked"; reason: EditsShareBlock }
  | { state: "pending"; reason?: "locked" | "session-unknown" }
  | { state: "confirmed"; url: string };

export type EditsPermissionPane = "accessibility" | "screen-recording";

export type EditsConnectionStatus =
  | { state: "unavailable" }
  | { state: "checked"; accessibility: boolean; screenRecording: boolean;
      installed: boolean; running: boolean; screen: "locked" | "unlocked" | "unknown" };

export interface EditsFinalShareBridge {
  connectionStatus(): Promise<EditsConnectionStatus>;
  openPermissionSettings(pane: EditsPermissionPane): Promise<void>;
  preview(projectId: string): Promise<EditsShareResult>;
  applyCaption(projectId: string, token: string, caption: string): Promise<EditsShareResult>;
  confirm(projectId: string, token: string): Promise<EditsShareResult>;
  recheck(projectId: string): Promise<EditsShareResult>;
  cancel(token: string): Promise<void>;
}

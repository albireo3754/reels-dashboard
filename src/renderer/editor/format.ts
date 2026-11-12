import type { EditorProject } from "../../shared/editor";
import { validateEditSettings } from "../../shared/editor-model";

export const formatSeconds = (value: number) =>
  `${Math.floor(value / 60)}:${(value % 60).toFixed(2).padStart(5, "0")}`;
export const signature = (project: EditorProject) =>
  JSON.stringify({ id: project.id, settings: project.settings });
export const clampedTime = (time: number, duration: number) =>
  Math.min(Math.max(0, time), Math.max(0, duration - 0.01));
export function validate(project: EditorProject, kind: "video" | "cover" | "export") {
  validateEditSettings(project.settings, project.source.duration, kind);
}

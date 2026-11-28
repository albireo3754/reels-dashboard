import type { Project } from "./contracts";

export function isYoutubeEpisode(project: Project) {
  return project.publications?.some(p => p.channel === "youtube" && p.format !== "shorts")
    || /후라이윤\s*EP\s*\d+/iu.test(project.title.normalize("NFC"));
}

export const isEpisodeVideo = (file: string) => /\.(mov|mp4|m4v)$/i.test(file);
export interface EpisodeTranscriptionBridge {
  run(projectId: string, linkedSource?: string): Promise<{ directory: string; reused: boolean } | null>;
}

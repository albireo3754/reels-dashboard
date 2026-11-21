/** macOS 알림 — "EP.03 준비됨: <경로>" (osascript). 알림 실패는 파이프라인 실패가 아닙니다. */

import { execFile } from "node:child_process";
import path from "node:path";

function escape(text: string): string {
  return String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function notify(title: string, message: string): void {
  console.log(`[알림] ${title} — ${message}`);
  if (process.platform !== "darwin") return;
  const script = `display notification "${escape(message)}" with title "${escape(title)}" sound name "Glass"`;
  try {
    execFile("osascript", ["-e", script], { timeout: 15_000 }, () => undefined);
  } catch {
    /* 알림은 실패해도 무시 */
  }
}

export function notifyReady(projectDir: string, episodeId: string, duration?: number): void {
  const suffix = duration ? ` (${Math.round(duration)}초)` : "";
  notify(`${episodeId} 준비됨${suffix}`, `검수 후 수동 업로드하세요: ${path.basename(projectDir)}/render/short.mp4`);
}

export function notifyBlocked(projectDir: string, stage: string, reason: string): void {
  notify(`멈춤 — ${stage}`, `${path.basename(projectDir)}: ${reason.slice(0, 140)}`);
}

export function notifyFailed(projectDir: string, stage: string, reason: string): void {
  notify(`실패 — ${stage}`, `${path.basename(projectDir)}: ${reason.slice(0, 140)}`);
}

import type {
  TerminalBackendId,
  TerminalBackendState,
  WorkTerminal,
} from "../../../shared/workbench";

/** The host rejects a backend change while any session is running or detached. */
export function backendLocked(sessions: readonly WorkTerminal[]): boolean {
  return sessions.some((s) => s.state === "running" || s.state === "detached");
}

/** Why the 세션 유지 choice is disabled, or "" when it can be changed. */
export function backendLockReason(
  backend: TerminalBackendState,
  sessions: readonly WorkTerminal[],
): string {
  if (backend.forcedByEnv)
    return "REELS_TERMINAL_BACKEND 환경변수로 고정돼 있어요.";
  if (backendLocked(sessions))
    return "실행 중이거나 연결이 끊긴 세션을 종료한 뒤 바꿀 수 있어요.";
  return "";
}

export const BACKEND_LABELS: Record<TerminalBackendId, string> = {
  herdr: "herdr 세션",
  direct: "직접 실행",
};

/** Shown when herdr is chosen but not installed; the install command is text only. */
export function herdrMissingNotice(backend: TerminalBackendState): boolean {
  return (
    backend.selected === "herdr" &&
    !backend.herdrInstalled &&
    !backend.checking &&
    !backend.error
  );
}

/** The status line for new shell/agent sessions; honest while the startup check runs. */
export function backendStatus(backend: TerminalBackendState): string {
  if (backend.checking) return "새 쉘·코딩 도구 세션: herdr 확인 중이에요.";
  return `새 쉘·코딩 도구 세션: ${BACKEND_LABELS[backend.effective]}`;
}

export function sessionStateLabel(session: WorkTerminal): string {
  if (session.state === "running") return "실행 중";
  if (session.state === "detached") return "연결 끊김";
  return `종료 ${session.exitCode ?? ""}`.trim();
}

/** The session list shows a reattach button only for a live herdr workspace nobody is attached to. */
export function canReattach(session: WorkTerminal): boolean {
  return session.backend === "herdr" && session.state === "detached";
}

/** Closing a tab really ends herdr sessions too, so the wording stays "종료". */
export function closeTitle(session: WorkTerminal): string {
  return session.backend === "herdr"
    ? "herdr 세션을 종료하고 탭을 닫아요"
    : "프로세스를 종료하고 탭을 닫아요";
}

/** What the primary meta-bar action does for the selected session. */
export function metaAction(session: WorkTerminal): "stop" | "remove" {
  if (session.state === "running") return "stop";
  // A detached herdr workspace is still alive; remove() would be rejected.
  return session.state === "detached" ? "stop" : "remove";
}

/** Whether terminal input and resizes are forwarded to the host. */
export function acceptsInput(session: WorkTerminal | undefined): boolean {
  return session?.state === "running";
}

/** What happens to sessions when the app quits, for the hint text. */
export function appExitNote(
  backend: TerminalBackendState | undefined,
  sessions: readonly WorkTerminal[],
): string {
  const herdr =
    sessions.some((s) => s.backend === "herdr" && s.state !== "exited") ||
    backend?.effective === "herdr";
  return herdr
    ? "herdr 세션은 앱을 종료해도 유지되고 다음 실행 때 탭으로 복원돼요. 직접 실행 세션과 미리보기·검증은 앱을 종료하면 종료돼요."
    : "앱을 종료하면 모든 세션이 종료돼요.";
}

import type { KeyAction } from "./keymap";

export type AgentProvider = "codex" | "claude";
export interface AgentProviderOption {
  id: AgentProvider;
  label: string;
}
export type WorkPhase = "design" | "implement" | "review" | "fix";
export type TerminalKind = AgentProvider | "shell" | "preview" | "checks";
export interface StartTerminal {
  kind: TerminalKind;
  phase?: WorkPhase;
  task?: string;
}
/** direct: node-pty owns the process. herdr: a herdr workspace owns it and the app only attaches. */
export type TerminalBackendId = "direct" | "herdr";
export const TERMINAL_BACKENDS: readonly TerminalBackendId[] = ["direct", "herdr"];
/** Kinds that may run in herdr; preview and checks always run direct (exit code and child cleanup). */
export const HERDR_TERMINAL_KINDS: readonly TerminalKind[] = [
  "shell",
  "codex",
  "claude",
];
/** running: attached/owned. detached: herdr workspace alive but not attached (takeover, server restart). */
export type WorkTerminalState = "running" | "detached" | "exited";
export interface WorkTerminal {
  id: string;
  kind: TerminalKind;
  title: string;
  cwd: string;
  backend: TerminalBackendId;
  state: WorkTerminalState;
  /** Omitted when unknown (a herdr workspace that ended on its own). */
  exitCode?: number;
  startedAt: string;
  /** Re-attached from a herdr workspace left by an earlier app run. */
  restored?: boolean;
}
export interface TerminalBackendState {
  /** Saved choice or env override; default "herdr". */
  selected: TerminalBackendId;
  /** What new shell/agent sessions use: "direct" when herdr is not installed or `error` is set. */
  effective: TerminalBackendId;
  herdrInstalled: boolean;
  herdrVersion?: string;
  /** herdr session name the workspaces live in (as given, when `error` rejects it). */
  session: string;
  /** REELS_TERMINAL_BACKEND decided `selected`. */
  forcedByEnv: boolean;
  /** The startup herdr check and restore are still running: herdrInstalled/effective are not final yet. */
  checking: boolean;
  /** Why herdr is disabled for this run (a malformed REELS_HERDR_SESSION). */
  error?: string;
}
export interface TerminalSnapshot {
  session: WorkTerminal;
  output: string;
  sequence: number;
}
export type WorkbenchEvent =
  | { type: "data"; id: string; data: string; sequence: number }
  | { type: "changed" };
export interface WorkbenchState {
  workspace: string | null;
  sessions: WorkTerminal[];
  previewURL: string;
  providers: AgentProviderOption[];
  defaultProvider: AgentProvider;
  terminalBackend: TerminalBackendState;
}
export interface WorkbenchBridge {
  state(): Promise<WorkbenchState>;
  chooseWorkspace(): Promise<WorkbenchState>;
  start(input: StartTerminal): Promise<WorkTerminal>;
  snapshot(id: string): Promise<TerminalSnapshot>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  stop(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  close(id: string): Promise<void>;
  /** Saves the backend for new sessions; rejected while a session is running or detached. */
  setTerminalBackend(id: TerminalBackendId): Promise<WorkbenchState>;
  /** Re-attaches a detached herdr session (taking it over from other clients). */
  reattach(id: string): Promise<WorkTerminal>;
  hideWindow(): Promise<void>;
  openPreview(): Promise<void>;
  onEvent(callback: (event: WorkbenchEvent) => void): () => void;
  /** Host-scope shortcut action names from the dev desktop `before-input-event`. */
  onShortcut(callback: (action: KeyAction) => void): () => void;
}

export const phaseLabels: Record<WorkPhase, string> = {
  design: "설계",
  implement: "구현",
  review: "리뷰",
  fix: "수정·재검증",
};

export function workPrompt(phase: WorkPhase, task: string): string {
  const instructions: Record<WorkPhase, string> = {
    design:
      "관련 코드와 AGENTS.md를 읽고 요청 범위의 설계, 변경 위치, 검증 기준을 제시하세요. 아직 구현하지 마세요.",
    implement:
      "관련 코드와 AGENTS.md를 읽고 요청을 구현하세요. 기존 미커밋 변경을 보존하고 필요한 검증을 실행한 뒤 결과와 남은 제한을 보고하세요.",
    review:
      "읽기 전용으로 요청 관련 코드와 현재 diff를 리뷰하세요. 다른 작업의 변경을 구분하고 실제 결함만 파일·위치·재현 조건과 함께 보고하세요. 파일을 수정하지 마세요.",
    fix: "요청에 포함된 리뷰 지적을 코드로 확인하고 해당 결함을 수정하세요. 관련 검증을 재실행하고 수정 결과와 남은 제한을 보고하세요. 기존 변경을 보존하세요.",
  };
  return `Reels Dashboard 개발 작업\n${instructions[phase]}\n외부 게시·배포·push, 개인 자료 변경은 이 요청에 포함되지 않습니다.\n\n사용자 요청 및 인계:\n${task.trim()}`;
}

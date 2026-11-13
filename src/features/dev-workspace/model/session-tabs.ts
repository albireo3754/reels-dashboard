import type {
  AgentProvider,
  AgentProviderOption,
  TerminalKind,
  WorkTerminal,
} from "../../../shared/workbench";

/** Roving tab focus: arrows wrap around, Home and End jump. Other keys return undefined. */
export function tabKeyTarget(
  key: string,
  index: number,
  count: number,
): number | undefined {
  if (count <= 0) return;
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
  }
}


export interface StartChoice {
  /** Stable key for the menu and the empty screen. */
  id: string;
  kind: TerminalKind;
  label: string;
  /** Shown in the empty screen and as a tooltip. */
  detail: string;
  /** Also listed on the empty screen. */
  primary: boolean;
}

const OPEN_LABEL: Record<AgentProvider, string> = {
  codex: "Codex 열기",
  claude: "Claude 열기",
};

/**
 * What the + menu and the empty screen offer, in order: terminal, each
 * available coding tool, then preview server and checks. A tool the host does
 * not advertise is never offered.
 */
export function startChoices(
  providers: readonly AgentProviderOption[],
  hasTask: boolean,
): StartChoice[] {
  const how = hasTask
    ? "작성기의 요청문과 단계를 전달해 열어요"
    : "요청문 없이 대화형으로 열어요";
  return [
    {
      id: "shell",
      kind: "shell",
      label: "터미널",
      detail: "일반 셸을 새 탭으로 열어요",
      primary: true,
    },
    ...providers.map((provider) => ({
      id: provider.id,
      kind: provider.id as TerminalKind,
      label: OPEN_LABEL[provider.id] ?? `${provider.label} 열기`,
      detail: how,
      primary: true,
    })),
    {
      id: "preview",
      kind: "preview" as const,
      label: "미리보기 서버",
      detail: "로컬 웹 미리보기 서버를 시작해요",
      primary: false,
    },
    {
      id: "checks",
      kind: "checks" as const,
      label: "검증 실행",
      detail: "타입 → 구조 → 단위 테스트 → 빌드를 순서대로 실행해요",
      primary: false,
    },
  ];
}

/** Menu keyboard: arrows wrap, Home and End jump. */
export function menuKeyTarget(
  key: string,
  index: number,
  count: number,
): number | undefined {
  if (count <= 0) return;
  switch (key) {
    case "ArrowDown":
      return (index + 1) % count;
    case "ArrowUp":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
  }
}

/** The tab tooltip: title, state, folder, herdr ownership and the ⌘N shortcut (when there is one). */
export function tabTooltip(
  session: WorkTerminal,
  stateLabel: string,
  shortcut = "",
): string {
  const parts = [session.title, stateLabel, session.cwd];
  if (session.backend === "herdr")
    parts.push(
      session.restored
        ? "이전 실행에서 복원한 herdr 세션(앱을 종료해도 유지)"
        : "herdr 세션(앱을 종료해도 유지)",
    );
  if (shortcut) parts.push(shortcut);
  return parts.filter(Boolean).join(" · ");
}

/**
 * What Codex/Claude from the + menu or the empty screen does. A written request is never
 * sent from a collapsed composer: the composer opens first so the user sees what goes out.
 */
export function agentStartIntent(
  kind: TerminalKind,
  hasTask: boolean,
  composerOpen: boolean,
): "start" | "reveal" {
  const agent = kind === "codex" || kind === "claude";
  return agent && hasTask && !composerOpen ? "reveal" : "start";
}

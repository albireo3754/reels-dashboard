import type {
  AgentPermission,
  AgentProvider,
  AgentProviderOption,
  WorkPhase,
} from "../shared/workbench";

interface ProviderAdapter extends AgentProviderOption {
  enabled: boolean;
  args(phase: WorkPhase, permission?: AgentPermission): string[];
}

const readOnly = (phase: WorkPhase) => phase === "review" || phase === "design";
// Bypass is a per-start opt-in and never widens the read-only phases.
const bypasses = (phase: WorkPhase, permission?: AgentPermission) =>
  permission === "bypass" && !readOnly(phase);

// Enabling another provider is a host policy change, not a renderer preference.
const providers: Record<AgentProvider, ProviderAdapter> = {
  codex: {
    id: "codex",
    label: "Codex",
    enabled: true,
    args: (phase, permission) =>
      bypasses(phase, permission)
        ? ["codex", "--dangerously-bypass-approvals-and-sandbox"]
        : readOnly(phase)
          ? ["codex", "--sandbox", "read-only", "--ask-for-approval", "on-request"]
          : // Auto review: workspace-write sandbox, approval requests go to Codex's reviewer.
            ["codex", "--approve-for-me"],
  },
  claude: {
    id: "claude",
    label: "Claude Code",
    enabled: true,
    // An explicit mode keeps a user-level bypass default out: write phases start in auto
    // mode, read-only phases in plan; bypass happens only when this start request asks for it.
    args: (phase, permission) =>
      bypasses(phase, permission)
        ? ["claude", "--dangerously-skip-permissions"]
        : ["claude", "--permission-mode", readOnly(phase) ? "plan" : "auto"],
  },
};

export const DEFAULT_AGENT_PROVIDER: AgentProvider = "codex";

export function availableAgentProviders(): AgentProviderOption[] {
  return Object.values(providers)
    .filter((provider) => provider.enabled)
    .map(({ id, label }) => ({ id, label }));
}

export function agentProvider(id: AgentProvider): ProviderAdapter {
  const provider = providers[id];
  if (!provider?.enabled)
    throw new Error("아직 사용할 수 없는 코딩 도구예요. Codex나 Claude Code를 선택해주세요.");
  return provider;
}

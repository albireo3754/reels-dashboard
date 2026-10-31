import type {
  AgentProvider,
  AgentProviderOption,
  WorkPhase,
} from "../shared/workbench";

interface ProviderAdapter extends AgentProviderOption {
  enabled: boolean;
  args(phase: WorkPhase): string[];
}

// Enabling another provider is a host policy change, not a renderer preference.
const providers: Record<AgentProvider, ProviderAdapter> = {
  codex: {
    id: "codex",
    label: "Codex",
    enabled: true,
    args: (phase) => [
      "codex",
      "--sandbox",
      phase === "review" || phase === "design"
        ? "read-only"
        : "workspace-write",
      "--ask-for-approval",
      "on-request",
    ],
  },
  claude: {
    id: "claude",
    label: "Claude Code",
    enabled: false,
    args: (phase) => [
      "claude",
      "--permission-mode",
      phase === "review" || phase === "design" ? "plan" : "manual",
    ],
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
    throw new Error("아직 사용할 수 없는 코딩 도구예요. Codex를 선택해주세요.");
  return provider;
}

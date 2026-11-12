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
        : [
            "codex",
            "--sandbox",
            readOnly(phase) ? "read-only" : "workspace-write",
            "--ask-for-approval",
            "on-request",
          ],
  },
  claude: {
    id: "claude",
    label: "Claude Code",
    enabled: true,
    // "manual" is a valid choice of the installed CLI and keeps a user-level bypass
    // default out; bypass happens only when this start request asks for it.
    args: (phase, permission) =>
      bypasses(phase, permission)
        ? ["claude", "--dangerously-skip-permissions"]
        : ["claude", "--permission-mode", readOnly(phase) ? "plan" : "manual"],
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

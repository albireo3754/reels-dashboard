import { createAgentDispatch, type AgentPorts } from "../features/agent-tools";
import { startAgentSocket } from "../shared/lib/agent-socket";

export function connectAgent(root: string, ports: AgentPorts) {
  return startAgentSocket(root, createAgentDispatch(ports));
}

// Test-only launcher: simulates Paseo agents in memory. Never used by bridge.mjs.
import { readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentInfo, LaunchSpec, Launcher } from "./instructions";

export type Scenario =
  | "done"
  | "needs_user"
  | "failed"
  | "missing"
  | "late"
  | "invalid"
  | "oversize"
  | "symlink"
  | "permission"
  | "error"
  | "hang";

export interface FakeAgent {
  id: string;
  status: string;
  pending: number;
  labels: Record<string, string>;
  spec: LaunchSpec;
  scenario: Scenario;
  resultFile: string;
  instructionId: string;
  attemptId: string;
  sends: number;
}

export function parsePrompt(prompt: string) {
  const instructionFile = JSON.parse(
    /지시 원문은 ("(?:[^"\\]|\\.)*")/.exec(prompt)![1],
  ) as string;
  const resultFile = JSON.parse(
    /끝나면 ("(?:[^"\\]|\\.)*")/.exec(prompt)![1],
  ) as string;
  const instructionId = /"instructionId":"([^"]+)"/.exec(prompt)![1];
  const attemptId = /"attemptId":"([^"]+)"/.exec(prompt)![1];
  return { instructionFile, resultFile, instructionId, attemptId };
}

export class FakeLauncher implements Launcher {
  readyValue = true;
  /** "before": fail without creating; "after": create the agent, then fail. */
  launchFails: false | "before" | "after" = false;
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly agents = new Map<string, FakeAgent>();
  private seq = 0;
  constructor(private readonly opts: { autoCompleteMs?: number } = {}) {}

  scenarioFor(text: string): Scenario {
    return (/\[fake:([a-z_]+)\]/.exec(text)?.[1] as Scenario) ?? "done";
  }

  /** Adds an agent as if a previous bridge process had launched it. */
  seed(labels: Record<string, string>, status = "running") {
    const id = "fake-" + ++this.seq;
    this.agents.set(id, {
      id,
      status,
      pending: 0,
      labels,
      spec: null as unknown as LaunchSpec,
      scenario: "hang",
      resultFile: "",
      instructionId: labels.instruction ?? "",
      attemptId: "",
      sends: 0,
    });
    return id;
  }

  async ready() {
    this.calls.push({ method: "ready", args: [] });
    return this.readyValue;
  }
  async launch(spec: LaunchSpec) {
    this.calls.push({ method: "launch", args: [spec] });
    if (this.launchFails === "before") throw new Error("fake launch failure");
    const p = parsePrompt(spec.prompt);
    const text = await readFile(p.instructionFile, "utf8");
    const id = "fake-" + ++this.seq;
    const agent: FakeAgent = {
      id,
      status: "running",
      pending: 0,
      labels: spec.labels,
      spec,
      scenario: this.scenarioFor(text),
      resultFile: p.resultFile,
      instructionId: p.instructionId,
      attemptId: p.attemptId,
      sends: 0,
    };
    this.agents.set(id, agent);
    if (this.opts.autoCompleteMs !== undefined)
      setTimeout(() => void this.complete(id), this.opts.autoCompleteMs);
    if (this.launchFails === "after") throw new Error("fake response lost");
    return { agentId: id };
  }
  async inspect(agentId: string): Promise<AgentInfo> {
    this.calls.push({ method: "inspect", args: [agentId] });
    const a = this.agents.get(agentId);
    if (!a) throw new Error("not found");
    return { status: a.status, pendingPermissions: a.pending };
  }
  async findByLabel(key: string, value: string) {
    this.calls.push({ method: "findByLabel", args: [key, value] });
    return [...this.agents.values()]
      .filter((a) => a.labels[key] === value)
      .map((a) => a.id);
  }
  async send(agentId: string, promptFile: string) {
    this.calls.push({ method: "send", args: [agentId, promptFile] });
    const a = this.agents.get(agentId)!;
    a.sends++;
    if (a.scenario === "late") {
      a.scenario = "done";
      await this.complete(agentId);
    }
  }
  async stop(agentId: string) {
    this.calls.push({ method: "stop", args: [agentId] });
    const a = this.agents.get(agentId);
    if (a) a.status = "idle";
  }

  result(a: FakeAgent, over: Record<string, unknown> = {}) {
    const status =
      a.scenario === "needs_user" || a.scenario === "failed"
        ? a.scenario
        : "done";
    return {
      schemaVersion: 1,
      instructionId: a.instructionId,
      attemptId: a.attemptId,
      status,
      summaryLines: [
        "가짜 실행기 결과 " + status,
        "문서 두 개를 읽고 초안을 만들었어요",
      ],
      ...(status === "needs_user"
        ? { question: "어느 쪽을 먼저 할까요?" }
        : {}),
      verification: "not_run",
      ...over,
    };
  }

  /** Ends the agent's turn and writes what its scenario says. */
  async complete(agentId: string, over: Record<string, unknown> = {}) {
    const a = this.agents.get(agentId)!;
    const write = async (data: string) => {
      const temp = a.resultFile + ".tmp";
      await writeFile(temp, data);
      await rename(temp, a.resultFile);
    };
    switch (a.scenario) {
      case "done":
      case "needs_user":
      case "failed":
        await write(JSON.stringify(this.result(a, over)));
        break;
      case "invalid":
        await write("{not json");
        break;
      case "oversize":
        await write(
          JSON.stringify(this.result(a, { summaryLines: ["x".repeat(17000)] })),
        );
        break;
      case "symlink": {
        const target = path.join(
          path.dirname(a.resultFile),
          "..",
          "elsewhere.json",
        );
        await writeFile(target, JSON.stringify(this.result(a)));
        await symlink(target, a.resultFile);
        break;
      }
      case "permission":
        a.pending = 1;
        return;
      case "hang":
        return;
      default:
        break;
    }
    a.status = a.scenario === "error" ? "error" : "idle";
  }
}

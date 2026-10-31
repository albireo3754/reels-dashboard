import { spawn, type IPty } from "node-pty";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  workPrompt,
  type WorkTerminal,
  type WorkbenchEvent,
  type StartTerminal,
  type WorkbenchState,
} from "../shared/workbench";
import {
  agentProvider,
  availableAgentProviders,
  DEFAULT_AGENT_PROVIDER,
} from "./workbench-providers";

export const PREVIEW_URL = "http://127.0.0.1:4183/?demo=1";
const startSchema = z
  .object({
    kind: z.enum(["codex", "claude", "shell", "preview", "checks"]),
    phase: z.enum(["design", "implement", "review", "fix"]).optional(),
    task: z
      .string()
      .max(16000)
      .refine((v) => !/[\x00-\x08\x0b-\x1f\x7f]/.test(v))
      .optional(),
  })
  .strict();
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function terminalCommand(input: StartTerminal): string | null {
  const value = startSchema.parse(input);
  if (value.kind === "shell") return null;
  if (value.kind === "preview")
    return "exec npm run dev -- --host 127.0.0.1 --port 4183 --strictPort";
  if (value.kind === "checks")
    return "npm run typecheck && npm run check:architecture && npm test && npm run build";
  const prompt = value.task?.trim()
    ? workPrompt(value.phase ?? "implement", value.task)
    : "";
  const args = agentProvider(value.kind).args(value.phase ?? "implement");
  return `exec ${[...args, ...(prompt ? [prompt] : [])].map(quote).join(" ")}`;
}

export async function validateWorkspace(directory: string): Promise<string> {
  const resolved = await realpath(directory);
  const pkg = JSON.parse(
    await readFile(path.join(resolved, "package.json"), "utf8"),
  );
  if (
    pkg.name !== "reels-dashboard" ||
    !pkg.scripts?.dev ||
    !pkg.scripts?.typecheck
  )
    throw new Error("Reels Dashboard 소스 폴더를 선택해주세요.");
  return resolved;
}

type Entry = {
  session: WorkTerminal;
  pty: IPty;
  output: string;
  sequence: number;
};
export class Workbench {
  private workspace: string | null = null;
  private sessions = new Map<string, Entry>();
  private closing = new Map<string, Promise<void>>();
  private pending = false;
  private disposed = false;
  constructor(
    private root: string,
    private emit: (event: WorkbenchEvent) => void,
    private spawnPty: typeof spawn = spawn,
  ) {}

  async initialize(candidate?: string) {
    try {
      const saved = z
        .object({ workspace: z.string() })
        .parse(
          JSON.parse(
            await readFile(path.join(this.root, "workbench.json"), "utf8"),
          ),
        );
      // A moved checkout is shown as disconnected; it never launches in a different directory.
      this.workspace = await validateWorkspace(saved.workspace).catch(
        () => null,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (candidate)
        this.workspace = await validateWorkspace(candidate).catch(() => null);
    }
  }
  state(): WorkbenchState {
    return {
      workspace: this.workspace,
      sessions: [...this.sessions.values()].map((e) => ({ ...e.session })),
      previewURL: PREVIEW_URL,
      providers: availableAgentProviders(),
      defaultProvider: DEFAULT_AGENT_PROVIDER,
    };
  }
  async chooseWorkspace(directory: string) {
    if (
      this.pending ||
      [...this.sessions.values()].some((e) => e.session.state === "running")
    )
      throw new Error("실행 중인 세션을 종료한 뒤 작업 폴더를 바꿔주세요.");
    this.pending = true;
    try {
      const workspace = await validateWorkspace(directory);
      await mkdir(this.root, { recursive: true });
      const file = path.join(this.root, "workbench.json");
      await writeFile(`${file}.tmp`, JSON.stringify({ workspace }), {
        mode: 0o600,
      });
      await rename(`${file}.tmp`, file);
      this.workspace = workspace;
      this.sessions.clear();
      this.emit({ type: "changed" });
      return this.state();
    } finally {
      this.pending = false;
    }
  }
  async start(input: StartTerminal) {
    const value = startSchema.parse(input);
    // Validate provider policy before touching settings, files or a child process.
    const command = terminalCommand(value);
    if (this.disposed || this.pending)
      throw new Error("작업공간 준비가 끝난 뒤 다시 시도해주세요.");
    if (!this.workspace) throw new Error("먼저 앱 소스 폴더를 연결해주세요.");
    if (this.sessions.size >= 12)
      throw new Error(
        "종료한 세션을 목록에서 정리해주세요. 최대 12개까지 보관해요.",
      );
    if (
      [...this.sessions.values()].some(
        (e) => e.session.kind === value.kind && e.session.state === "running",
      ) &&
      ["checks", "preview"].includes(value.kind)
    )
      throw new Error(
        "같은 작업이 이미 실행 중이에요. 해당 세션을 선택해주세요.",
      );
    this.pending = true;
    try {
      const cwd = await validateWorkspace(this.workspace);
      if (this.disposed) throw new Error("작업공간이 종료됐어요.");
      const shell = "/bin/zsh";
      // Finder-launched Electron has a minimal PATH. Login profiles may add tool managers.
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([k, v]) =>
            v !== undefined &&
            !/^(CLAUDE|CODEX|ELECTRON_|NODE_OPTIONS|NODE_INSPECT|REELS_)/.test(
              k,
            ),
        ),
      ) as Record<string, string>;
      env.PATH = `${path.join(os.homedir(), ".local/bin")}:/opt/homebrew/bin:/usr/local/bin:${env.PATH || "/usr/bin:/bin"}`;
      env.TERM = "xterm-256color";
      const pty = this.spawnPty(shell, command ? ["-lc", command] : ["-l"], {
        cwd,
        env,
        cols: 100,
        rows: 28,
        name: "xterm-256color",
      });
      const id = randomUUID();
      const names = {
        shell: "터미널",
        preview: "웹 미리보기",
        checks: "검증",
      };
      const session: WorkTerminal = {
        id,
        kind: value.kind,
        title:
          value.kind === "codex" || value.kind === "claude"
            ? agentProvider(value.kind).label
            : names[value.kind],
        cwd,
        state: "running",
        startedAt: new Date().toISOString(),
      };
      const entry: Entry = { session, pty, output: "", sequence: 0 };
      this.sessions.set(id, entry);
      pty.onData((data) => {
        entry.output = (entry.output + data).slice(-256 * 1024);
        this.emit({ type: "data", id, data, sequence: ++entry.sequence });
      });
      pty.onExit(({ exitCode }) => {
        session.state = "exited";
        session.exitCode = exitCode;
        this.emit({ type: "changed" });
      });
      this.emit({ type: "changed" });
      return { ...session };
    } finally {
      this.pending = false;
    }
  }
  private get(id: string) {
    const entry = this.sessions.get(z.string().uuid().parse(id));
    if (!entry) throw new Error("세션을 찾을 수 없어요.");
    return entry;
  }
  snapshot(id: string) {
    const e = this.get(id);
    return {
      session: { ...e.session },
      output: e.output,
      sequence: e.sequence,
    };
  }
  write(id: string, data: string) {
    const e = this.get(id);
    z.string().max(65536).parse(data);
    if (e.session.state !== "running")
      throw new Error("이미 종료한 세션이에요.");
    e.pty.write(data);
  }
  resize(id: string, cols: number, rows: number) {
    z.number().int().min(2).max(500).parse(cols);
    z.number().int().min(2).max(300).parse(rows);
    const e = this.get(id);
    if (e.session.state === "running") e.pty.resize(cols, rows);
  }
  stop(id: string) {
    const e = this.get(id);
    if (e.session.state === "running") e.pty.kill();
  }
  remove(id: string) {
    if (this.get(id).session.state === "running")
      throw new Error("세션을 먼저 종료해주세요.");
    this.sessions.delete(id);
    this.emit({ type: "changed" });
  }
  close(id: string): Promise<void> {
    z.string().uuid().parse(id);
    const existing = this.closing.get(id);
    if (existing) return existing;
    const entry = this.sessions.get(id);
    // A repeated close after completion is harmless, including UI/event races.
    if (!entry) return Promise.resolve();
    const operation = (async () => {
      if (entry.session.state === "running") {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            subscription.dispose();
            reject(new Error("세션 종료를 확인하지 못했어요. 상태를 확인하고 다시 닫아주세요."));
          }, 5000);
          const subscription = entry.pty.onExit(() => {
            clearTimeout(timer);
            subscription.dispose();
            resolve();
          });
          try {
            entry.pty.kill();
          } catch (error) {
            clearTimeout(timer);
            subscription.dispose();
            reject(error);
          }
        });
      }
      // The regular exit handler runs first and records the actual exit code.
      if (entry.session.state !== "exited")
        throw new Error("세션 종료를 확인하지 못했어요.");
      if (this.sessions.get(id) === entry) {
        this.sessions.delete(id);
        this.emit({ type: "changed" });
      }
    })().finally(() => this.closing.delete(id));
    this.closing.set(id, operation);
    return operation;
  }
  dispose() {
    this.disposed = true;
    for (const e of this.sessions.values())
      if (e.session.state === "running") e.pty.kill();
  }
}

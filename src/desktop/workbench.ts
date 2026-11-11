import { writeFileAtomic } from "../shared/lib/fs";
import { spawn, type IPty } from "node-pty";
import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  HERDR_TERMINAL_KINDS,
  TERMINAL_BACKENDS,
  workPrompt,
  type TerminalBackendId,
  type TerminalKind,
  type WorkTerminal,
  type WorkbenchEvent,
  type StartTerminal,
  type WorkbenchState,
} from "../shared/workbench";
import {
  createHerdrClient,
  herdrLabel,
  herdrSessionName,
  herdrSourceTag,
  isHerdrError,
  PANE_SCRUBBED_ENV_PREFIXES,
  type HerdrClient,
} from "./herdr";
import {
  agentProvider,
  availableAgentProviders,
  DEFAULT_AGENT_PROVIDER,
} from "./workbench-providers";

export const PREVIEW_URL = "http://127.0.0.1:4183/?demo=1";

// HERDR_* would point herdr-aware tools at the pane the app was launched from.
const SCRUBBED_ENV_PREFIXES = [...PANE_SCRUBBED_ENV_PREFIXES, "HERDR_"];
export function terminalEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const env = Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) =>
        value !== undefined &&
        !SCRUBBED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)),
    ),
  ) as Record<string, string>;
  // Finder supplies neither a shell PATH nor a locale. Preserve deliberate locale
  // choices (including C), but allow Korean input when none has been configured.
  env.PATH = `${path.join(os.homedir(), ".local/bin")}:/opt/homebrew/bin:/usr/local/bin:${env.PATH || "/usr/bin:/bin"}`;
  env.TERM = "xterm-256color";
  if (![env.LANG, env.LC_ALL, env.LC_CTYPE].some((value) => value?.trim()))
    env.LC_CTYPE = "UTF-8";
  return env;
}

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


const MAX_SESSIONS = 12;
const LIVE_STATES = new Set(["running", "detached"]);
const SIZE = { cols: 100, rows: 28 };
const settingsSchema = z.object({
  workspace: z.string().optional(),
  terminalBackend: z.unknown().optional(),
});
const isBackend = (value: unknown): value is TerminalBackendId =>
  TERMINAL_BACKENDS.includes(value as TerminalBackendId);

/** REELS_TERMINAL_BACKEND=direct|herdr overrides the saved choice; any other value is ignored. */
export function terminalBackendOverride(
  env: NodeJS.ProcessEnv,
): TerminalBackendId | undefined {
  const value = env.REELS_TERMINAL_BACKEND;
  return isBackend(value) ? value : undefined;
}

function baseTitle(kind: TerminalKind) {
  const names = { shell: "터미널", preview: "웹 미리보기", checks: "검증" };
  if (kind === "codex" || kind === "claude") {
    try {
      return agentProvider(kind).label;
    } catch {
      // A restored session keeps its tool even when the provider is not offered for new sessions.
      return kind === "codex" ? "Codex" : "Claude Code";
    }
  }
  return names[kind];
}

/**
 * The tab title: "터미널", then "터미널 2", "터미널 3", … — the lowest number no listed tab
 * uses, so tabs of one kind stay distinguishable. Titles are display only; herdr labels
 * and restore ownership never read them.
 */
export function terminalTitle(kind: TerminalKind, taken: Iterable<string> = []) {
  const base = baseTitle(kind);
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

type Entry = {
  session: WorkTerminal;
  /** null for a detached or ended herdr session, or while an ended attach is being classified. */
  pty: IPty | null;
  output: string;
  sequence: number;
  cols: number;
  rows: number;
  label?: string;
  terminalId?: string;
  /** The herdr workspace was closed by stop/close. */
  ended?: boolean;
  attaching?: Promise<WorkTerminal>;
  terminating?: Promise<void>;
};

export interface WorkbenchOptions {
  /** herdr CLI client; default: the session named by REELS_HERDR_SESSION, or "default" when it is unset. */
  herdr?: HerdrClient;
  /** Where REELS_TERMINAL_BACKEND / REELS_HERDR_SESSION are read (main process env by default). */
  env?: NodeJS.ProcessEnv;
}

export class Workbench {
  private workspace: string | null = null;
  private savedWorkspace: string | undefined;
  private savedBackend: TerminalBackendId | undefined;
  private herdrInfo: { installed: boolean; version?: string } = {
    installed: false,
  };
  private readonly override: TerminalBackendId | undefined;
  private readonly herdr: HerdrClient;
  /** Why herdr is disabled for this run (a malformed REELS_HERDR_SESSION). */
  private readonly herdrError: string | undefined;
  /** The startup herdr check and restore, run after initialize returns. */
  private ready: Promise<void> = Promise.resolve();
  private checking = false;
  private sessions = new Map<string, Entry>();
  private closing = new Map<string, Promise<void>>();
  private pending = false;
  private disposed = false;
  constructor(
    private root: string,
    private emit: (event: WorkbenchEvent) => void,
    private spawnPty: typeof spawn = spawn,
    options: WorkbenchOptions = {},
  ) {
    const env = options.env ?? process.env;
    this.override = terminalBackendOverride(env);
    const requested = env.REELS_HERDR_SESSION;
    // A malformed name disables herdr instead of landing in the user's default session.
    this.herdrError =
      herdrSessionName(requested) === null
        ? `REELS_HERDR_SESSION 값 ${JSON.stringify(requested).slice(0, 80)}이(가) herdr 세션 이름 형식(영문·숫자로 시작, 영문·숫자·._- 최대 64자)에 맞지 않아 herdr를 쓰지 않고 직접 실행해요.`
        : undefined;
    this.herdr =
      options.herdr ??
      createHerdrClient({
        session: requested ?? "",
        env: terminalEnvironment(),
      });
  }

  async initialize(candidate?: string) {
    let saved: z.infer<typeof settingsSchema> | undefined;
    try {
      saved = settingsSchema.parse(
        JSON.parse(
          await readFile(path.join(this.root, "workbench.json"), "utf8"),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // An unknown saved backend falls back to the default instead of breaking the workspace.
    this.savedBackend = isBackend(saved?.terminalBackend)
      ? saved.terminalBackend
      : undefined;
    this.savedWorkspace = saved?.workspace;
    if (saved?.workspace !== undefined)
      // A moved checkout is shown as disconnected; it never launches in a different directory.
      this.workspace = await validateWorkspace(saved.workspace).catch(
        () => null,
      );
    else if (candidate)
      this.workspace = await validateWorkspace(candidate).catch(() => null);
    // herdr is checked after initialize returns, so a slow or hung herdr never delays the window.
    this.checking = true;
    this.ready = (async () => {
      await this.detectHerdr();
      await this.restore();
    })().finally(() => {
      this.checking = false;
      if (!this.disposed) this.emit({ type: "changed" });
    });
  }
  /** Resolves when the startup herdr check and restore are done; start, chooseWorkspace and setTerminalBackend wait for it. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  private async detectHerdr() {
    this.herdrInfo = await this.herdr
      .detect()
      .catch(() => ({ installed: false }));
  }
  private selectedBackend(): TerminalBackendId {
    return this.override ?? this.savedBackend ?? "herdr";
  }
  private effectiveBackend(): TerminalBackendId {
    return this.selectedBackend() === "herdr" &&
      this.herdrInfo.installed &&
      !this.herdrError
      ? "herdr"
      : "direct";
  }

  /**
   * Re-attaches herdr workspaces created for this source folder by an earlier run; never starts a
   * server. Ownership is the source tag in the label, not the pane's current cwd (a shell may cd away).
   */
  private async restore() {
    if (this.effectiveBackend() !== "herdr" || !this.workspace) return;
    const source = herdrSourceTag(this.workspace);
    try {
      if (!(await this.herdr.isServerRunning())) return;
      const list = await this.herdr.list();
      for (const found of list) {
        if (this.disposed || this.sessions.size >= MAX_SESSIONS) break;
        if (
          !HERDR_TERMINAL_KINDS.includes(found.kind) ||
          found.source !== source ||
          this.sessions.has(found.id)
        )
          continue;
        const entry: Entry = {
          session: {
            id: found.id,
            kind: found.kind,
            title: terminalTitle(found.kind, this.titles()),
            cwd: this.workspace,
            backend: "herdr",
            state: "running",
            startedAt: new Date().toISOString(),
            restored: true,
          },
          pty: null,
          output: "",
          sequence: 0,
          ...SIZE,
          label: found.label,
          terminalId: found.terminalId,
        };
        try {
          this.attach(entry);
          this.sessions.set(found.id, entry);
        } catch {
          // The workspace stays in herdr; a failed attach only skips the tab.
        }
      }
    } catch {
      // Restoration is best effort; the workspace itself stays usable.
    }
  }

  /** Titles of the listed tabs, for numbering the next one of the same kind. */
  private titles() {
    return [...this.sessions.values()].map((entry) => entry.session.title);
  }

  state(): WorkbenchState {
    return {
      workspace: this.workspace,
      sessions: [...this.sessions.values()].map((e) => ({ ...e.session })),
      previewURL: PREVIEW_URL,
      providers: availableAgentProviders(),
      defaultProvider: DEFAULT_AGENT_PROVIDER,
      terminalBackend: {
        selected: this.selectedBackend(),
        effective: this.effectiveBackend(),
        herdrInstalled: this.herdrInfo.installed,
        ...(this.herdrInfo.version
          ? { herdrVersion: this.herdrInfo.version }
          : {}),
        session: this.herdr.session,
        forcedByEnv: this.override !== undefined,
        checking: this.checking,
        ...(this.herdrError ? { error: this.herdrError } : {}),
      },
    };
  }
  private hasLiveSessions() {
    return [...this.sessions.values()].some((e) =>
      LIVE_STATES.has(e.session.state),
    );
  }
  private async saveSettings(next: {
    workspace?: string;
    terminalBackend?: TerminalBackendId;
  }) {
    await mkdir(this.root, { recursive: true });
    const workspace = next.workspace ?? this.savedWorkspace;
    const terminalBackend = next.terminalBackend ?? this.savedBackend;
    await writeFileAtomic(
      path.join(this.root, "workbench.json"),
      JSON.stringify({
        ...(workspace !== undefined ? { workspace } : {}),
        ...(terminalBackend ? { terminalBackend } : {}),
      }),
      { mode: 0o600 },
    );
    this.savedWorkspace = workspace;
    this.savedBackend = terminalBackend;
  }
  async chooseWorkspace(directory: string) {
    // Restored sessions belong to the folder being replaced, so the check must finish first.
    await this.ready;
    if (this.pending || this.hasLiveSessions())
      throw new Error("실행 중인 세션을 종료한 뒤 작업 폴더를 바꿔주세요.");
    this.pending = true;
    try {
      const workspace = await validateWorkspace(directory);
      await this.saveSettings({ workspace });
      this.workspace = workspace;
      this.sessions.clear();
      this.emit({ type: "changed" });
      return this.state();
    } finally {
      this.pending = false;
    }
  }
  async setTerminalBackend(id: TerminalBackendId) {
    const value = z.enum(["direct", "herdr"]).parse(id);
    await this.ready;
    if (this.disposed || this.pending || this.hasLiveSessions())
      throw new Error("실행 중인 세션을 종료한 뒤 터미널 백엔드를 바꿔주세요.");
    this.pending = true;
    try {
      await this.saveSettings({ terminalBackend: value });
      // herdr may have been installed since launch.
      if (value === "herdr") await this.detectHerdr();
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
    // The backend is decided only after herdr has been checked.
    await this.ready;
    if (this.disposed || this.pending)
      throw new Error("작업공간 준비가 끝난 뒤 다시 시도해주세요.");
    if (!this.workspace) throw new Error("먼저 앱 소스 폴더를 연결해주세요.");
    if (this.sessions.size >= MAX_SESSIONS)
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
    // Preview and checks need their exit code and child cleanup, so they always run direct.
    const backend: TerminalBackendId =
      HERDR_TERMINAL_KINDS.includes(value.kind) &&
      this.effectiveBackend() === "herdr"
        ? "herdr"
        : "direct";
    this.pending = true;
    try {
      const cwd = await validateWorkspace(this.workspace);
      if (this.disposed) throw new Error("작업공간이 종료됐어요.");
      const id = randomUUID();
      const session: WorkTerminal = {
        id,
        kind: value.kind,
        title: terminalTitle(value.kind, this.titles()),
        cwd,
        backend,
        state: "running",
        startedAt: new Date().toISOString(),
      };
      const entry: Entry = { session, pty: null, output: "", sequence: 0, ...SIZE };
      if (backend === "herdr") {
        const label = herdrLabel(value.kind, id, herdrSourceTag(cwd));
        let pane;
        try {
          pane = await this.herdr.ensure(label, { cwd, command });
        } catch (error) {
          // A create that timed out may still have finished on the server; never leave an unlisted workspace.
          const cleanup = await this.herdr.close(label).then(
            () => "",
            (closeError) =>
              isHerdrError(closeError, "server_not_running")
                ? ""
                : ` herdr에 남았을 수 있는 세션(${label})도 정리하지 못했어요. ${message(closeError)}`,
          );
          throw new Error(
            `herdr 세션을 시작하지 못했어요. ${message(error)}${cleanup}`,
          );
        }
        // The workspace outlives an app that quit meanwhile and is restored next launch.
        if (this.disposed) throw new Error("작업공간이 종료됐어요.");
        entry.label = label;
        entry.terminalId = pane.terminal_id;
        try {
          this.attach(entry);
        } catch (error) {
          await this.herdr.close(label).catch(() => {});
          throw error;
        }
      } else {
        const shell = "/bin/zsh";
        // Finder-launched Electron has a minimal PATH. Login profiles may add tool managers.
        const pty = this.spawnPty(shell, command ? ["-lc", command] : ["-l"], {
          cwd,
          env: terminalEnvironment(),
          ...SIZE,
          name: "xterm-256color",
        });
        entry.pty = pty;
        pty.onData((data) => this.append(entry, data));
        pty.onExit(({ exitCode }) => {
          session.state = "exited";
          session.exitCode = exitCode;
          this.emit({ type: "changed" });
        });
      }
      this.sessions.set(id, entry);
      this.emit({ type: "changed" });
      return { ...session };
    } finally {
      this.pending = false;
    }
  }
  private append(entry: Entry, data: string) {
    entry.output = (entry.output + data).slice(-256 * 1024);
    this.emit({
      type: "data",
      id: entry.session.id,
      data,
      sequence: ++entry.sequence,
    });
  }
  /** Attaches a PTY to the herdr terminal; the workspace keeps running when it ends. */
  private attach(entry: Entry) {
    const { file, args } = this.herdr.attachCommand(entry.terminalId!);
    const pty = this.spawnPty(file, args, {
      cwd: entry.session.cwd,
      env: terminalEnvironment(),
      cols: entry.cols,
      rows: entry.rows,
      name: "xterm-256color",
    });
    entry.pty = pty;
    entry.session.state = "running";
    delete entry.session.exitCode;
    pty.onData((data) => {
      if (entry.pty === pty) this.append(entry, data);
    });
    pty.onExit(() => this.attachEnded(entry, pty));
  }
  /**
   * exited only when an answering server has no such workspace; detached when it lives on (taken
   * over) or cannot be checked (server down or restarting: herdr restores labelled workspaces). No auto-reconnect.
   */
  private attachEnded(entry: Entry, pty: IPty) {
    if (entry.pty !== pty) return;
    entry.pty = null;
    if (this.disposed) return;
    void this.herdr.find(entry.label!).then(
      (pane) => {
        if (pane) entry.terminalId = pane.terminal_id;
        return pane ? "detached" : "exited";
      },
      () => "detached" as const,
    ).then((state) => {
      // A reattach, stop or close finished meanwhile.
      if (entry.pty || entry.ended || this.disposed) return;
      if (entry.session.state === "exited") return;
      entry.session.state = state;
      delete entry.session.exitCode;
      this.emit({ type: "changed" });
    });
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
    if (e.session.state === "detached")
      throw new Error("연결이 끊긴 세션이에요. 다시 연결해주세요.");
    if (e.session.state !== "running" || !e.pty)
      throw new Error("이미 종료한 세션이에요.");
    e.pty.write(data);
  }
  resize(id: string, cols: number, rows: number) {
    z.number().int().min(2).max(500).parse(cols);
    z.number().int().min(2).max(300).parse(rows);
    const e = this.get(id);
    e.cols = cols;
    e.rows = rows;
    if (e.session.state === "running" && e.pty) e.pty.resize(cols, rows);
  }
  async reattach(id: string): Promise<WorkTerminal> {
    const entry = this.get(id);
    if (entry.session.backend !== "herdr")
      throw new Error("herdr 세션만 다시 연결할 수 있어요.");
    if (this.disposed) throw new Error("작업공간이 종료됐어요.");
    if (entry.pty) return { ...entry.session };
    if (entry.session.state === "exited" || entry.ended)
      throw new Error("이미 종료한 세션이에요.");
    if (entry.attaching) return entry.attaching;
    const operation = (async () => {
      // Starts a stopped server, which restores the labelled workspace; rejects (staying detached) when it cannot.
      const pane = await this.herdr.reopen(entry.label!);
      // Quit, stop or close may have finished meanwhile; a late attach would outlive them.
      if (this.disposed) throw new Error("작업공간이 종료됐어요.");
      if (entry.ended || entry.terminating || entry.session.state === "exited")
        throw new Error("이미 종료한 세션이에요.");
      if (entry.pty) return { ...entry.session };
      if (!pane) {
        entry.session.state = "exited";
        delete entry.session.exitCode;
        this.emit({ type: "changed" });
        throw new Error("herdr 세션이 이미 종료됐어요.");
      }
      entry.terminalId = pane.terminal_id;
      this.attach(entry);
      this.emit({ type: "changed" });
      return { ...entry.session };
    })().finally(() => {
      entry.attaching = undefined;
    });
    entry.attaching = operation;
    return operation;
  }
  /** Ends a herdr session for real: closes its workspace, then drops the attach PTY. */
  private terminate(entry: Entry): Promise<void> {
    if (entry.terminating) return entry.terminating;
    const operation = (async () => {
      // exited means an answering server already reported the workspace gone.
      if (entry.ended || entry.session.state === "exited") return;
      try {
        await this.herdr.close(entry.label!);
      } catch (error) {
        // A stopped server would restore the workspace, so the tab is not marked as ended.
        throw new Error(
          isHerdrError(error, "server_not_running")
            ? "herdr 서버가 꺼져 있어 세션을 종료하지 못했어요. 다시 연결한 뒤 종료해주세요."
            : `herdr 세션을 종료하지 못했어요. ${message(error)}`,
        );
      }
      entry.ended = true;
      const pty = entry.pty;
      entry.pty = null;
      entry.session.state = "exited";
      delete entry.session.exitCode;
      try {
        pty?.kill();
      } catch {
        // The attach client usually ends by itself once its terminal is gone.
      }
      this.emit({ type: "changed" });
    })().finally(() => {
      entry.terminating = undefined;
    });
    entry.terminating = operation;
    return operation;
  }
  stop(id: string): void | Promise<void> {
    const e = this.get(id);
    if (e.session.backend === "herdr") return this.terminate(e);
    if (e.session.state === "running") e.pty?.kill();
  }
  remove(id: string) {
    if (LIVE_STATES.has(this.get(id).session.state))
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
      if (entry.session.backend === "herdr") await this.terminate(entry);
      else if (entry.session.state === "running") {
        const pty = entry.pty!;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            subscription.dispose();
            reject(
              new Error(
                "세션 종료를 확인하지 못했어요. 상태를 확인하고 다시 닫아주세요.",
              ),
            );
          }, 5000);
          const subscription = pty.onExit(() => {
            clearTimeout(timer);
            subscription.dispose();
            resolve();
          });
          try {
            pty.kill();
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
  /** App quit: direct processes end; herdr sessions only lose their attach PTY and are restored next launch. */
  dispose() {
    this.disposed = true;
    for (const e of this.sessions.values()) {
      const pty = e.pty;
      if (!pty) continue;
      if (e.session.backend === "herdr") {
        e.pty = null;
        e.session.state = "detached";
        try {
          pty.kill();
        } catch {
          // Nothing else to release; the workspace is left running on purpose.
        }
      } else if (e.session.state === "running") pty.kill();
    }
  }
}

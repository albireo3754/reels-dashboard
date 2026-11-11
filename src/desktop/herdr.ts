import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import type { TerminalKind } from "../shared/workbench";

/**
 * herdr CLI client for the development workspace terminal (no Electron dependency).
 * Sessions live in herdr workspaces labelled `reels-dashboard:<kind>:<uuid>:<source>`, where
 * <source> identifies the source folder they were created for (see herdrSourceTag); only those
 * labels are listed or closed, so the user's other workspaces are never touched.
 * Structure follows Workdesk's herdr backend (src/backend/herdr.ts), not its source.
 */

/** Runs the herdr binary with `args` (killed after timeoutMs); resolves stdout, rejects with HerdrCommandError. */
export type HerdrRun = (args: string[], timeoutMs: number) => Promise<string>;

export const HERDR_DEFAULT_SESSION = "default";
export const HERDR_LABEL_PREFIX = "reels-dashboard:";
export const HERDR_COMMAND_VARIABLE = "REELS_WORKBENCH_COMMAND";
const SERVER_POLL_MS = 100;
const SERVER_WAIT_MS = 5_000;
/** Calls that change the server (create, run, close). */
const RUN_TIMEOUT_MS = 15_000;
/** Read-only calls (--version, lists): short, so a hung server cannot stall startup or a status check. */
const QUERY_TIMEOUT_MS = 4_000;
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_TAG = /^[0-9a-f]{12}$/;
/**
 * Variables removed before an agent command starts in a pane. A pane inherits the env of the herdr
 * server, which may have been started from a Claude Code or Codex terminal, not the app's filtered env.
 */
export const PANE_SCRUBBED_ENV_PREFIXES = [
  "CLAUDE",
  "CODEX",
  "ELECTRON_",
  "NODE_OPTIONS",
  "NODE_INSPECT",
  "REELS_",
] as const;
const LABEL_KINDS = ["shell", "codex", "claude", "preview", "checks"] as const;

export class HerdrCommandError extends Error {
  /** herdr's JSON error code from stderr (e.g. `server_not_running`), if any. */
  readonly code?: string;
  constructor(
    readonly args: string[],
    readonly stderr: string,
    cause?: unknown,
  ) {
    const detail = stderr.trim() || (cause instanceof Error ? cause.message : "");
    super(`herdr ${args.slice(0, 4).join(" ")} 실패: ${detail}`.slice(0, 2000));
    this.code = /"code"\s*:\s*"([a-z_]+)"/.exec(stderr)?.[1];
  }
}

export const isHerdrError = (error: unknown, code: string) =>
  error instanceof HerdrCommandError
    ? error.code === code
    : String((error as Error)?.message ?? error).includes(code);

/**
 * The session to use: the user's default session only when no name was given; the name itself when valid;
 * null when a name was given but is malformed (never silently the default session).
 */
export function herdrSessionName(value: string | undefined): string | null {
  if (value === undefined || value === "") return HERDR_DEFAULT_SESSION;
  return SESSION_NAME.test(value) ? value : null;
}

/** Identifies a source folder in labels: the first 12 hex chars of sha256(realpath). Pass a realpath. */
export const herdrSourceTag = (realWorkspace: string) =>
  createHash("sha256").update(realWorkspace).digest("hex").slice(0, 12);

export const herdrLabel = (kind: TerminalKind, id: string, source: string) =>
  `${HERDR_LABEL_PREFIX}${kind}:${id}:${source}`;

/** Only `reels-dashboard:<kind>:<uuid>:<12 hex>` parses; anything else is not the app's workspace. */
export function parseHerdrLabel(
  label: unknown,
): { kind: TerminalKind; id: string; source: string } | null {
  if (typeof label !== "string" || !label.startsWith(HERDR_LABEL_PREFIX))
    return null;
  const [kind, id, source, ...rest] = label
    .slice(HERDR_LABEL_PREFIX.length)
    .split(":");
  if (
    rest.length ||
    !LABEL_KINDS.includes(kind as never) ||
    !UUID.test(id ?? "") ||
    !SOURCE_TAG.test(source ?? "")
  )
    return null;
  return { kind: kind as TerminalKind, id, source };
}

/**
 * The pane line that replaces the workspace shell with the command held in env. Every exported
 * variable matching PANE_SCRUBBED_ENV_PREFIXES (the command variable included) is removed first;
 * the command variable is expanded before `env` runs. Names are restricted to [A-Za-z0-9_], so a
 * multi-line value can at most add a harmless `-u` for a name that is not set.
 */
export const herdrRunLine = () =>
  // The leading space keeps the line out of shell history. `-uNAME` is one word per line, so zsh, bash and sh split it alike.
  ` exec env $(command env | command sed -E -n 's/^((${PANE_SCRUBBED_ENV_PREFIXES.join("|")})[A-Za-z0-9_]*)=.*/-u\\1/p') "$SHELL" -c "$${HERDR_COMMAND_VARIABLE}"`;

/** The first executable `name` on env.PATH (absolute), or null. */
export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
): string | null {
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

export interface HerdrPane {
  pane_id: string;
  terminal_id: string;
  cwd?: string;
  foreground_cwd?: string;
}
export interface HerdrSessionInfo {
  label: string;
  kind: TerminalKind;
  id: string;
  /** herdrSourceTag of the source folder the workspace was created for (not the pane's current cwd). */
  source: string;
  workspaceId: string;
  terminalId: string;
}
export interface HerdrAttach {
  file: string;
  args: string[];
}
export interface HerdrClient {
  /** The session name; for a malformed name every session call is refused. */
  readonly session: string;
  /** Re-resolves the binary and reads `herdr --version`. */
  detect(): Promise<{ installed: boolean; version?: string }>;
  /** True only when the session's server answers; never starts it. */
  isServerRunning(): Promise<boolean>;
  /** The labelled pane, creating its workspace (and starting the server) if needed. Serialized with close. */
  ensure(label: string, input: { cwd: string; command?: string | null }): Promise<HerdrPane>;
  /**
   * The labelled pane, or undefined when the answering server has no such workspace. Never starts
   * the server; rejects (server_not_running included) when the server cannot answer, because a
   * stopped server restores its labelled workspaces when it starts again.
   */
  find(label: string): Promise<HerdrPane | undefined>;
  /** Like find, but starts the server first when it is down (it restores labelled workspaces). Never creates one. Serialized with ensure/close. */
  reopen(label: string): Promise<HerdrPane | undefined>;
  /** Closes every workspace with this exact label. Rejects with server_not_running when the server is down. Serialized with ensure. */
  close(label: string): Promise<void>;
  /** Workspaces with the Reels label prefix, with their root pane. Never starts the server. */
  list(): Promise<HerdrSessionInfo[]>;
  attachCommand(terminalId: string): HerdrAttach;
}

/** Runs the herdr binary directly with env (whose PATH was already corrected for Finder launches). */
export function herdrRunner(
  binary: () => string,
  env: NodeJS.ProcessEnv,
): HerdrRun {
  return (args, timeoutMs) =>
    new Promise((resolve, reject) =>
      execFile(
        binary(),
        args,
        { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) =>
          error
            ? reject(new HerdrCommandError(args, String(stderr ?? ""), error))
            : resolve(String(stdout).trim()),
      ),
    );
}

/** Starts the session's headless server detached; like a tmux server it outlives the app. */
export function startHerdrServer(
  binary: string,
  session: string,
  env: NodeJS.ProcessEnv,
) {
  spawn(binary, ["--session", session, "server"], {
    detached: true,
    stdio: "ignore",
    env,
  }).unref();
}

export interface HerdrClientOptions {
  session: string;
  /** Environment for every herdr process; HERDR_* is removed so `--session` alone picks the target. */
  env: NodeJS.ProcessEnv;
  run?: HerdrRun;
  startServer?: () => void;
  sleep?: (ms: number) => Promise<void>;
  /** Overrides PATH lookup (tests). */
  binary?: string | null;
}

export function createHerdrClient(options: HerdrClientOptions): HerdrClient {
  const valid = herdrSessionName(options.session);
  const session = valid ?? options.session;
  const env = Object.fromEntries(
    Object.entries(options.env).filter(([key]) => !key.startsWith("HERDR_")),
  ) as NodeJS.ProcessEnv;
  let binary: string | null =
    options.binary !== undefined ? options.binary : findExecutable("herdr", env);
  const executable = () => binary ?? "herdr";
  const run = options.run ?? herdrRunner(executable, env);
  const startServer =
    options.startServer ??
    (() => valid && startHerdrServer(executable(), valid, env));
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // `--session` is always explicit: without it an inherited HERDR_SOCKET_PATH picks the server.
  // A malformed name never reaches herdr, so it cannot fall back to the default session.
  const herdr = (args: string[], timeoutMs = RUN_TIMEOUT_MS) =>
    valid
      ? run(["--session", valid, ...args], timeoutMs)
      : Promise.reject(
          new Error(`herdr 세션 이름이 올바르지 않아요: ${JSON.stringify(options.session).slice(0, 80)}`),
        );
  const result = async (args: string[], timeoutMs = QUERY_TIMEOUT_MS) => {
    const parsed = JSON.parse(await herdr(args, timeoutMs));
    if (!parsed || typeof parsed !== "object" || !("result" in parsed))
      throw new Error(`herdr ${args.slice(0, 2).join(" ")} 응답을 읽지 못했어요.`);
    return parsed.result;
  };
  const workspaces = async (): Promise<
    { workspace_id: string; label?: string }[]
  > => {
    const list = (await result(["workspace", "list"]))?.workspaces;
    return Array.isArray(list)
      ? list.filter((w) => typeof w?.workspace_id === "string")
      : [];
  };
  const named = async (label: string) =>
    (await workspaces()).filter((w) => w.label === label);
  const rootPane = async (workspaceId: string): Promise<HerdrPane | undefined> => {
    const panes = (await result(["pane", "list", "--workspace", workspaceId]))
      ?.panes;
    const pane = Array.isArray(panes) ? panes[0] : undefined;
    return typeof pane?.pane_id === "string" &&
      typeof pane?.terminal_id === "string"
      ? pane
      : undefined;
  };
  const paneOf = async (label: string) => {
    const [w] = await named(label);
    if (!w) return undefined;
    try {
      return await rootPane(w.workspace_id);
    } catch (error) {
      if (isHerdrError(error, "workspace_not_found")) return undefined;
      throw error;
    }
  };
  const isServerRunning = async () => {
    try {
      await workspaces();
      return true;
    } catch {
      return false;
    }
  };
  /** Starts the server unless it answers, then waits until it does. */
  const serve = async () => {
    try {
      return void (await workspaces());
    } catch (error) {
      if (!isHerdrError(error, "server_not_running")) throw error;
    }
    startServer();
    for (let waited = 0; ; waited += SERVER_POLL_MS) {
      await sleep(SERVER_POLL_MS);
      try {
        return void (await workspaces());
      } catch (error) {
        if (waited + SERVER_POLL_MS >= SERVER_WAIT_MS) throw error;
      }
    }
  };
  const create = async (
    label: string,
    { cwd, command }: { cwd: string; command?: string | null },
  ): Promise<HerdrPane> => {
    // The command travels in env, so the typed line stays short and fixed whatever the command holds.
    const extra = command
      ? ["--env", `${HERDR_COMMAND_VARIABLE}=${command}`]
      : [];
    const created = await result(
      ["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus", ...extra],
      RUN_TIMEOUT_MS,
    );
    const pane = created?.root_pane;
    if (typeof pane?.pane_id !== "string" || typeof pane?.terminal_id !== "string")
      throw new Error("herdr workspace 생성 응답을 읽지 못했어요.");
    if (command) {
      try {
        await herdr(["pane", "run", pane.pane_id, herdrRunLine()]);
      } catch (error) {
        // A workspace whose command never started is not a session the user asked for.
        const workspaceId = created?.workspace?.workspace_id;
        if (typeof workspaceId === "string")
          await herdr(["workspace", "close", workspaceId]).catch(() => {});
        throw error;
      }
    }
    return pane;
  };

  let queue: Promise<unknown> = Promise.resolve();
  /** Runs after every earlier ensure/close, so a close sees a create already under way. */
  const serial = <T>(f: () => Promise<T>) => {
    const p = queue.then(f);
    queue = p.then(
      () => {},
      () => {},
    );
    return p;
  };

  return {
    session,
    async detect() {
      binary =
        options.binary !== undefined ? options.binary : findExecutable("herdr", env);
      if (!binary) return { installed: false };
      try {
        const output = await run(["--version"], QUERY_TIMEOUT_MS);
        const version = /(\d+\.\d+\.\d+[\w.-]*)/.exec(output)?.[1];
        return { installed: true, ...(version ? { version } : {}) };
      } catch {
        return { installed: false };
      }
    },
    isServerRunning,
    ensure: (label, input) =>
      serial(async () => {
        await serve();
        return (await paneOf(label)) ?? (await create(label, input));
      }),
    find: (label) => paneOf(label),
    reopen: (label) =>
      serial(async () => {
        await serve();
        return paneOf(label);
      }),
    close: (label) =>
      serial(async () => {
        for (const w of await named(label)) {
          try {
            await herdr(["workspace", "close", w.workspace_id]);
          } catch (error) {
            if (!isHerdrError(error, "workspace_not_found")) throw error;
          }
        }
      }),
    async list() {
      let all: { workspace_id: string; label?: string }[];
      try {
        all = await workspaces();
      } catch (error) {
        if (isHerdrError(error, "server_not_running")) return [];
        throw error;
      }
      const sessions: HerdrSessionInfo[] = [];
      for (const w of all) {
        const parsed = parseHerdrLabel(w.label);
        if (!parsed) continue;
        let pane: HerdrPane | undefined;
        try {
          pane = await rootPane(w.workspace_id);
        } catch (error) {
          if (isHerdrError(error, "workspace_not_found")) continue;
          throw error;
        }
        if (!pane) continue;
        sessions.push({
          label: w.label!,
          ...parsed,
          workspaceId: w.workspace_id,
          terminalId: pane.terminal_id,
        });
      }
      return sessions;
    },
    attachCommand: (terminalId) => {
      if (!valid) throw new Error("herdr 세션 이름이 올바르지 않아요.");
      return {
        file: executable(),
        args: ["--session", valid, "terminal", "attach", terminalId, "--takeover"],
      };
    },
  };
}

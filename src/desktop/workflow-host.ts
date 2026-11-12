import { errorMessage } from "../shared/lib/errors";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startWorkflowServer } from "../app/workflow/server";
import {
  NEWER_WORKFLOW_SERVER_MESSAGE,
  STALE_WORKFLOW_SERVER_MESSAGE,
  WORKFLOW_PROTOCOL_VERSION,
  workflowAction,
  type WorkflowHostStatus,
} from "../shared/workflow";

export const DEFAULT_WORKFLOW_PORT = 4318;
export const defaultWorkflowRoot = () =>
  path.join(os.homedir(), ".local/share/reels-dashboard/workflows");

/** What answers on the workflow port before the app decides to start its own server. */
export type WorkflowProbe =
  | "none"
  | "compatible"
  | "stale"
  | "foreign"
  | "unresponsive";

/**
 * A probe with details: `root` is the realpath of the data dir a compatible server
 * uses; `newer` marks a server whose protocol is ahead of this build.
 */
export interface WorkflowProbeResult {
  kind: WorkflowProbe;
  root?: string;
  newer?: boolean;
}

/** The parts of `startWorkflowServer`'s handle the desktop host needs. */
export interface WorkflowServerHandle {
  url: string;
  close(): Promise<void>;
  runningJobs?(): number;
}

type CapabilitiesServer = { protocol?: unknown; actions?: unknown; root?: unknown };
const capabilitiesServer = (capabilities: unknown) =>
  (capabilities as { server?: CapabilitiesServer } | null)?.server;

/**
 * A server is compatible when it speaks this build's protocol version, serves every
 * action this build can send, and reports its data root.
 */
export function workflowCapabilitiesCompatible(capabilities: unknown) {
  const server = capabilitiesServer(capabilities);
  const actions = server?.actions;
  return (
    server?.protocol === WORKFLOW_PROTOCOL_VERSION &&
    typeof server.root === "string" &&
    Array.isArray(actions) &&
    workflowAction.options.every((action) => actions.includes(action))
  );
}

/** A request that never reached any server, so it is safe to retry elsewhere. */
const connectionRefused = (error: unknown) => {
  const cause = (error as { cause?: { code?: string } } | undefined)?.cause;
  return cause?.code === "ECONNREFUSED";
};

export async function probeWorkflowServer(
  url: string,
  timeoutMs = 1500,
): Promise<WorkflowProbeResult> {
  let response: Response;
  try {
    response = await fetch(new URL("/api/workflows/capabilities", url), {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { kind: connectionRefused(error) ? "none" : "unresponsive" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "foreign" };
  }
  if (!response.ok || typeof body !== "object" || body === null)
    return { kind: "foreign" };
  // Every workflow server version reports `sdk`; only new ones list their actions.
  if (!("sdk" in body)) return { kind: "foreign" };
  const server = capabilitiesServer(body);
  if (workflowCapabilitiesCompatible(body))
    return { kind: "compatible", root: server!.root as string };
  const protocol = server?.protocol;
  return typeof protocol === "number" && protocol > WORKFLOW_PROTOCOL_VERSION
    ? { kind: "stale", newer: true }
    : { kind: "stale" };
}

const asProbeResult = (found: WorkflowProbe | WorkflowProbeResult): WorkflowProbeResult =>
  typeof found === "string" ? { kind: found } : found;

/**
 * Canonical data-dir identity, comparable with the server's `realpath(root)`. A dir
 * that does not exist yet resolves through its nearest existing ancestor.
 */
export async function workflowRootIdentity(root: string) {
  let dir = path.resolve(root);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(dir), ...rest);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return path.resolve(root);
      rest.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

const ownerLockConflict = (message: string) => /already has a running server/.test(message);
const portInUse = (message: string) => /EADDRINUSE/.test(message);
/** Re-probe schedule (~2 s) after losing a simultaneous-start race. */
const RACE_PROBE_DELAYS_MS = [200, 300, 500, 500, 500];

/**
 * Apps launched from Finder/Dock get launchd's minimal PATH, so `codex` installed by
 * Homebrew/npm is not found. Prepend the usual user install dirs that exist.
 * Node's spawn resolves a bare command with `options.env.PATH`, which the Codex SDK
 * receives via `codexEnvironment(sdkEnv)`.
 */
export function guiCodexEnvironment(
  env: NodeJS.ProcessEnv,
  exists: (dir: string) => boolean = existsSync,
  home = os.homedir(),
): NodeJS.ProcessEnv {
  if (env.REELS_CODEX_BIN) return env;
  const current = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extra = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".local/bin"),
    path.join(home, ".npm-global/bin"),
    path.join(home, ".volta/bin"),
    path.join(home, ".bun/bin"),
  ].filter((dir) => !current.includes(dir) && exists(dir));
  if (!extra.length) return env;
  return { ...env, PATH: [...extra, ...current].join(path.delimiter) };
}

export interface WorkflowHostOptions {
  env?: NodeJS.ProcessEnv;
  root?: string;
  webRoot: string;
  openForm?: (formId: string) => Promise<unknown>;
  /** Injected probes may answer a bare kind; a compatible one without `root` skips the data-dir check. */
  probe?: (url: string) => Promise<WorkflowProbe | WorkflowProbeResult>;
  start?: (options: {
    root: string;
    port: number;
    webRoot: string;
    embedded: true;
    sdkEnv: NodeJS.ProcessEnv;
    openForm?: (formId: string) => Promise<unknown>;
  }) => Promise<WorkflowServerHandle>;
  now?: () => number;
  /** Delays between re-probes after a lost startup race (tests pass zeros). */
  raceProbeDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Owns the desktop app's connection to the workflow server.
 *
 * - `REELS_WORKFLOW_URL` set at launch: external, never starts a server.
 * - Otherwise probe `REELS_WORKFLOW_PORT` (default 4318; 0 = ephemeral, no probe):
 *   nothing there -> start in-process (embedded); a compatible server on the same
 *   data dir -> reuse it (shared); a server with another protocol version -> stale,
 *   the user must stop it; another data dir or a start failure -> error. Losing a
 *   simultaneous-start race re-probes briefly and shares the winner.
 *
 * `start()` publishes the resolved URL in `env.REELS_WORKFLOW_URL`, which every
 * main-process consumer (workflowRequest, the in-process canonical editor proxy,
 * input-form windows) reads per request, so call it before they make requests.
 */
export class DesktopWorkflowHost {
  private readonly env: NodeJS.ProcessEnv;
  private readonly external: boolean;
  private readonly port: number;
  private readonly root: string;
  private handle?: WorkflowServerHandle;
  private current: WorkflowHostStatus;
  private lastAdopt = Number.NEGATIVE_INFINITY;
  private adopting?: Promise<boolean>;
  private disposed = false;
  /** The last embed() lost a race and its status describes the winning server. */
  private raceWinnerSeen = false;

  constructor(private options: WorkflowHostOptions) {
    this.env = options.env ?? process.env;
    this.external = Boolean(this.env.REELS_WORKFLOW_URL);
    const port = Number(this.env.REELS_WORKFLOW_PORT ?? DEFAULT_WORKFLOW_PORT);
    this.port = Number.isInteger(port) && port >= 0 && port < 65536 ? port : DEFAULT_WORKFLOW_PORT;
    this.root = options.root ?? this.env.REELS_WORKFLOW_DATA ?? defaultWorkflowRoot();
    this.current = this.external
      ? { state: "external", url: this.env.REELS_WORKFLOW_URL! }
      : { state: "error", url: this.portUrl(), message: "워크플로 서버를 아직 준비하지 않았어요." };
  }

  private portUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  status(): WorkflowHostStatus {
    return { ...this.current };
  }

  runningJobs() {
    return this.handle?.runningJobs?.() ?? 0;
  }

  async start(): Promise<WorkflowHostStatus> {
    if (this.external) return this.status();
    // Publish the expected URL first so early consumers never fall back to a hard-coded port.
    this.env.REELS_WORKFLOW_URL = this.portUrl();
    if (this.port !== 0) {
      const { status } = await this.inspect();
      if (status) return this.set(status);
    }
    return this.embed();
  }

  /** Probes the port; `status` is undefined when nothing listens there. */
  private async inspect(): Promise<{ found: WorkflowProbeResult; status?: WorkflowHostStatus }> {
    const found = asProbeResult(await (this.options.probe ?? probeWorkflowServer)(this.portUrl()));
    const url = this.portUrl();
    switch (found.kind) {
      case "none":
        return { found };
      case "compatible": {
        if (found.root !== undefined) {
          const mine = await workflowRootIdentity(this.root);
          if (found.root !== mine)
            return {
              found,
              status: {
                state: "error",
                url,
                message: `포트 ${this.port}의 워크플로 서버는 다른 데이터 폴더(${found.root})를 사용 중이에요. 이 앱의 데이터 폴더는 ${mine}이에요. 그 서버를 종료하거나 REELS_WORKFLOW_PORT·REELS_WORKFLOW_DATA를 맞춘 뒤 앱을 다시 시작해주세요.`,
              },
            };
        }
        return { found, status: { state: "shared", url } };
      }
      case "stale":
        return {
          found,
          status: {
            state: "stale",
            url,
            message: found.newer ? NEWER_WORKFLOW_SERVER_MESSAGE : STALE_WORKFLOW_SERVER_MESSAGE,
          },
        };
      case "foreign":
        return {
          found,
          status: {
            state: "error",
            url,
            message: `포트 ${this.port}을 워크플로 서버가 아닌 다른 프로그램이 사용 중이에요. 그 프로그램을 종료하거나 REELS_WORKFLOW_PORT로 다른 포트를 지정한 뒤 앱을 다시 시작해주세요.`,
          },
        };
      case "unresponsive":
        return {
          found,
          status: {
            state: "error",
            url,
            message: `포트 ${this.port}의 워크플로 서버가 응답하지 않아요. 따로 실행한 서버를 확인한 뒤 앱을 다시 시작해주세요.`,
          },
        };
    }
  }

  /**
   * Another instance won a simultaneous start (owner lock or port). Wait briefly for
   * it to listen and share it, so `ensure()` can still take over after it quits.
   */
  private async shareRaceWinner(): Promise<WorkflowHostStatus | undefined> {
    const sleep = this.options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (const delay of this.options.raceProbeDelaysMs ?? RACE_PROBE_DELAYS_MS) {
      await sleep(delay);
      if (this.disposed) return undefined;
      const { found, status } = await this.inspect();
      if (found.kind === "none" || found.kind === "unresponsive") continue;
      return status;
    }
    return undefined;
  }

  private set(status: WorkflowHostStatus) {
    this.current = status;
    return this.status();
  }

  private async embed(): Promise<WorkflowHostStatus> {
    this.raceWinnerSeen = false;
    try {
      const start = this.options.start ?? startWorkflowServer;
      const handle = await start({
        root: this.root,
        port: this.port,
        webRoot: this.options.webRoot,
        embedded: true,
        sdkEnv: guiCodexEnvironment(this.env),
        ...(this.options.openForm ? { openForm: this.options.openForm } : {}),
      });
      if (this.disposed) {
        await handle.close();
        return this.status();
      }
      this.handle = handle;
      this.env.REELS_WORKFLOW_URL = handle.url;
      return this.set({ state: "embedded", url: handle.url });
    } catch (error) {
      const message = errorMessage(error);
      if (this.port !== 0 && (ownerLockConflict(message) || portInUse(message))) {
        const winner = await this.shareRaceWinner();
        if (winner) {
          this.raceWinnerSeen = true;
          return this.set(winner);
        }
      }
      return this.set({
        state: "error",
        url: this.env.REELS_WORKFLOW_URL ?? this.portUrl(),
        message: ownerLockConflict(message)
          ? "다른 워크플로 서버가 같은 데이터 폴더를 사용 중이에요. 그 서버를 종료한 뒤 앱을 다시 시작해주세요."
          : portInUse(message)
            ? `포트 ${this.port}을 이미 사용 중이에요. 다른 앱이나 서버를 확인한 뒤 앱을 다시 시작해주세요.`
            : `워크플로 서버를 시작하지 못했어요: ${message.slice(0, 300)}`,
      });
    }
  }

  /**
   * After the owner of a shared server quits, take over its port once per 5s.
   * Returns true when a server was (re)started and the caller may retry.
   */
  async ensure(): Promise<boolean> {
    if (this.disposed || this.external || this.handle || this.current.state !== "shared")
      return false;
    if (this.adopting) return this.adopting;
    const now = (this.options.now ?? Date.now)();
    if (now - this.lastAdopt < 5000) return false;
    this.lastAdopt = now;
    this.adopting = (async () => {
      const { found, status: seen } = await this.inspect();
      if (seen) {
        if (seen.state === "shared") return true;
        // A different-version or different-data server took the port: say so and stop
        // adopting. Transient answers (unresponsive, foreign) keep the shared state.
        if (found.kind === "stale" || found.kind === "compatible") this.set(seen);
        return false;
      }
      const status = await this.embed();
      if (status.state === "embedded") return true;
      // Lost the takeover race: share the winner (and retry there), or keep its
      // stale/other-data status. Otherwise stay shared and try again later.
      if (this.raceWinnerSeen) return status.state === "shared";
      this.current = { state: "shared", url: this.portUrl(), message: status.message };
      return false;
    })().finally(() => {
      this.adopting = undefined;
    });
    return this.adopting;
  }

  /**
   * Runs a main-process workflow request; when a shared server vanished, adopt the
   * port and retry once (a refused connection never reached a server).
   */
  async request<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (connectionRefused(error) && (await this.ensure())) return call();
      throw error;
    }
  }

  async dispose() {
    this.disposed = true;
    const handle = this.handle;
    this.handle = undefined;
    await handle?.close();
  }
}

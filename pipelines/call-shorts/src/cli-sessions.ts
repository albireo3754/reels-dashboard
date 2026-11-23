import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { Config } from "./config.js";
import { ConfigError } from "./errors.js";

/**
 * 로컬 `claude` / `codex` CLI 세션을 어떻게 실행할지 한 곳에서 정합니다.
 * 이 모듈은 providers.ts 를 import 하지 않습니다(어댑터가 여기를 씁니다).
 */

/** CLI 세션으로 처리하는 텍스트 단계. 기획은 claude, 대본은 codex 세션을 씁니다. */
export type TextRole = "planner" | "formatter";

export const TEXT_ROLE_LABELS: Record<TextRole, string> = {
  planner: "기획 (claude)",
  formatter: "대본 (codex)",
};

/**
 * 자식 CLI 에 넘기지 않는 이름들. 부모 프로세스의 API 키가 CLI 안에서 종량 과금으로 새는 것을 막습니다.
 * (CODEX_HOME·CLAUDE_CONFIG_DIR 은 자격 증명이 아니라 CLI 가 로그인을 찾는 위치라서 넘깁니다.)
 */
export const CLI_SCRUBBED_ENV_PREFIXES = ["CLAUDE", "CODEX", "ANTHROPIC", "OPENAI", "GEMINI"] as const;

/** 세션이 아니라 CLI 자체가 로그인을 찾는 위치. 값에는 키가 없습니다. */
export const CLI_LOGIN_ENV_NAMES = ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"] as const;

const BASE_ENV_NAMES = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "SHELL",
  "TERM",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
  "no_proxy",
] as const;

/** codex 가 대화형 로컬 채널 브릿지를 띄우지 않게 합니다(레포의 다른 codex 호출과 같은 처리). */
export const CODEX_ENV = { CODEX_LOCAL_CHANNEL_DISABLED: "1" } as const;

/** 앱을 Finder/launchd 에서 띄워도 CLI 를 찾도록 PATH 뒤에 붙입니다(레포의 다른 CLI 호출과 같은 처리). */
const CLI_PATH_FALLBACK = ["/opt/homebrew/bin", "/usr/local/bin"] as const;

/** 탐색과 자식 env 가 같은 위치를 봐야 주석대로 동작합니다. `~/.local/bin` 은 Claude Code 공식 설치 경로입니다. */
function fallbackDirs(env: NodeJS.ProcessEnv): string[] {
  return [...CLI_PATH_FALLBACK, path.join(env.HOME || homedir(), ".local", "bin")];
}

/** 자식 출력 상한(`execFile` 시절과 같은 8MB). 넘으면 그룹을 끊고 오류로 돌려줍니다. */
const CLI_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/** 타임아웃 SIGTERM 뒤 SIGKILL 까지의 유예. */
const CLI_KILL_GRACE_MS = 2_000;

/** 그룹을 끊은 뒤 `close` 가 오지 않을 때(파이프를 쥔 채 그룹을 벗어난 손자) 기다리는 시간. */
const CLI_CLOSE_WAIT_MS = 1_000;

export interface CliRun {
  file: string;
  args: string[];
  stdin: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs: number;
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  error?: string;
}

export type CliRunner = (run: CliRun) => Promise<CliResult>;

/**
 * 부모 env 에서 CLI 가 필요로 하는 값만 골라 넘깁니다. 화이트리스트 밖의 `*_API_KEY`,
 * `CLAUDE_*` 세션 변수, `CODEX_*` 자격 증명은 애초에 복사되지 않습니다.
 */
export function cliEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [...BASE_ENV_NAMES, ...CLI_LOGIN_ENV_NAMES]) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of fallbackDirs(env)) if (!dirs.includes(dir)) dirs.push(dir);
  env.PATH = dirs.join(path.delimiter);
  for (const name of Object.keys(env)) {
    if ((CLI_LOGIN_ENV_NAMES as readonly string[]).includes(name)) continue;
    if (CLI_SCRUBBED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) delete env[name];
  }
  return env;
}

/**
 * PATH(절대경로 디렉터리만)에서 실행 가능한 `name` 을 찾습니다. 절대경로를 주면 그 파일을 검사합니다.
 * 디렉터리는 X_OK 가 통과해도 실행 파일이 아니므로 정규 파일인지 함께 확인하고,
 * 자식 env 와 같은 폴백 디렉터리까지 탐색합니다.
 */
export function findCliBinary(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const executableFile = (candidate: string) => {
    try {
      if (!statSync(candidate).isFile()) return false;
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (name.includes(path.sep)) return executableFile(name) ? name : null;
  const dirs = [...(env.PATH ?? "").split(path.delimiter), ...fallbackDirs(env)];
  for (const dir of dirs) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    if (executableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * detached 로 띄운 CLI 프로세스 그룹들. 자식은 새 세션이라 터미널 전경 그룹이 아니고,
 * 부모가 Ctrl-C 로 끝나도 그 신호를 받지 못합니다. 그래서 여기서 함께 정리합니다.
 */
const liveCliGroups = new Set<number>();
const PARENT_EXIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function signalCliGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // 이미 끝났거나 그룹이 없습니다(ESRCH).
  }
}

const onParentExit: NodeJS.SignalsListener = (signal) => {
  for (const pid of liveCliGroups) signalCliGroup(pid, signal);
  liveCliGroups.clear();
  for (const name of PARENT_EXIT_SIGNALS) process.removeListener(name, onParentExit);
  // 리스너를 붙이면 Node 가 스스로는 죽지 않으므로, 남은 리스너가 없으면 기본 종료로 돌려 놓습니다.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
};

function trackCliGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  if (liveCliGroups.size === 0) for (const name of PARENT_EXIT_SIGNALS) process.on(name, onParentExit);
  liveCliGroups.add(pid);
}

function untrackCliGroup(pid: number | undefined): void {
  if (pid === undefined || !liveCliGroups.delete(pid)) return;
  if (liveCliGroups.size === 0) for (const name of PARENT_EXIT_SIGNALS) process.removeListener(name, onParentExit);
}

/**
 * 자식 CLI 를 한 번 실행하고 결과를 그대로 돌려줍니다(예외를 던지지 않음).
 * 프롬프트는 argv 가 아니라 stdin 으로 넣어 통화 전사문이 프로세스 목록에 남지 않게 합니다.
 *
 * POSIX 에서는 자식을 새 프로세스 그룹의 리더로 띄웁니다(detached). `codex` 처럼 손자 프로세스를
 * 두는 CLI 를 타임아웃에 끊을 때 직계 자식만 죽이면 손자가 고아로 남고, 그 손자가 stdout 파이프를
 * 쥐고 있으면 호출 자체가 끝나지 않습니다. 그래서 타임아웃에는 그룹 전체에 SIGTERM,
 * 유예 뒤 SIGKILL 을 보냅니다(Windows 는 그룹 신호가 없어 직계 자식만 끊습니다).
 */
export const runCliProcess: CliRunner = (run) =>
  new Promise((resolve) => {
    const group = process.platform !== "win32";
    const child = spawn(run.file, run.args, {
      cwd: run.cwd,
      env: run.env,
      detached: group,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (group) trackCliGroup(child.pid);

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timedOut = false;
    let overflowed = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let closeTimer: NodeJS.Timeout | undefined;

    const stop = (signal: NodeJS.Signals) => {
      if (group && child.pid !== undefined) signalCliGroup(child.pid, signal);
      else child.kill(signal);
    };

    const finish = (result: CliResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(graceTimer);
      clearTimeout(closeTimer);
      if (group) untrackCliGroup(child.pid);
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
      resolve(result);
    };

    const timeoutResult = (): CliResult => ({
      code: null,
      stdout,
      stderr,
      timedOut: true,
      error: `CLI 가 ${run.timeoutMs}ms 안에 끝나지 않았습니다(프로세스 그룹 종료).`,
    });

    const collect = (stream: "stdout" | "stderr") => (chunk: string) => {
      if (overflowed) return;
      outputBytes += Buffer.byteLength(chunk);
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
      if (outputBytes > CLI_MAX_BUFFER_BYTES) {
        overflowed = true;
        stdout = stdout.slice(0, CLI_MAX_BUFFER_BYTES);
        stderr = stderr.slice(0, CLI_MAX_BUFFER_BYTES);
        stop("SIGKILL");
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", collect("stdout"));
    child.stderr?.on("data", collect("stderr"));

    child.on("error", (error) => finish({ code: null, stdout, stderr, error: error.message }));

    child.on("close", (code, signal) => {
      if (overflowed) {
        return finish({
          code,
          stdout,
          stderr,
          error: `CLI 출력이 ${CLI_MAX_BUFFER_BYTES / 1024 / 1024}MB 를 넘어 중단했습니다.`,
        });
      }
      if (timedOut) return finish(timeoutResult());
      if (code === 0) return finish({ code: 0, stdout, stderr });
      finish({
        code,
        stdout,
        stderr,
        error: code === null ? `CLI 가 시그널 ${signal ?? "없음"} 로 끝났습니다.` : `CLI 가 종료 코드 ${code} 로 끝났습니다.`,
      });
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      stop("SIGTERM");
      graceTimer = setTimeout(() => {
        stop("SIGKILL");
        // 그룹을 벗어난 손자가 파이프를 쥐고 있으면 close 가 오지 않습니다.
        closeTimer = setTimeout(() => finish(timeoutResult()), CLI_CLOSE_WAIT_MS);
      }, CLI_KILL_GRACE_MS);
    }, run.timeoutMs);

    // CLI 가 stdin 을 읽기 전에 끝나면 EPIPE 가 프로세스를 죽입니다. 실패는 종료 코드가 알려 주므로 무시합니다.
    child.stdin?.on("error", () => {});
    child.stdin?.end(run.stdin);
  });

export interface RouteDeps {
  env?: NodeJS.ProcessEnv;
}

export interface TextRoute {
  role: TextRole;
  backend: "cli" | "api";
  /** claude-cli · codex-cli · anthropic · openai */
  provider: string;
  /** CLI 경로(CLI 백엔드일 때만). */
  binary: string | null;
}

interface RoleTools {
  cli: "claude" | "codex";
  api: "anthropic" | "openai";
  keyName: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY";
  cliBinName: "CLAUDE_CLI_BIN" | "CODEX_CLI_BIN";
  apiKey: (config: Config) => string | null;
  cliBin: (config: Config) => string | null;
}

const ROLE_TOOLS: Record<TextRole, RoleTools> = {
  planner: {
    cli: "claude",
    api: "anthropic",
    keyName: "ANTHROPIC_API_KEY",
    cliBinName: "CLAUDE_CLI_BIN",
    apiKey: (config) => config.anthropicApiKey,
    cliBin: (config) => config.claudeCliBin,
  },
  formatter: {
    cli: "codex",
    api: "openai",
    keyName: "OPENAI_API_KEY",
    cliBinName: "CODEX_CLI_BIN",
    apiKey: (config) => config.openaiApiKey,
    cliBin: (config) => config.codexCliBin,
  },
};

export const roleTools = (role: TextRole): Readonly<RoleTools> => ROLE_TOOLS[role];

export function cliBinaryFor(config: Config, role: TextRole, env: NodeJS.ProcessEnv = process.env): string | null {
  const tools = ROLE_TOOLS[role];
  return findCliBinary(tools.cliBin(config) ?? tools.cli, env);
}

/**
 * `LLM_BACKEND` 를 이 단계의 실제 백엔드로 풀어 줍니다.
 * auto: 설치된 CLI → API 키 → 실패. cli: CLI 만(키가 있어도 API 로 넘어가지 않음). api: API 키만.
 */
export function textRoute(config: Config, role: TextRole, deps: RouteDeps = {}): TextRoute {
  const tools = ROLE_TOOLS[role];
  const env = deps.env ?? process.env;
  const binary = cliBinaryFor(config, role, env);
  const hasKey = Boolean(tools.apiKey(config));
  const cliHint = binary
    ? ""
    : ` ${tools.cli} CLI 를 찾지 못했습니다 — 설치·로그인하거나 ${tools.cliBinName} 에 경로를 지정하세요.`;

  if (config.llmBackend === "api") {
    if (!hasKey) {
      throw new ConfigError(`${tools.keyName} 가 필요합니다 (LLM_BACKEND=api).`, {
        hint: "LLM_BACKEND=cli(또는 auto)로 두면 설치된 CLI 세션으로 과금 없이 실행합니다.",
      });
    }
    return { role, backend: "api", provider: tools.api, binary: null };
  }
  if (binary) return { role, backend: "cli", provider: `${tools.cli}-cli`, binary };
  if (config.llmBackend === "cli") {
    throw new ConfigError(`${TEXT_ROLE_LABELS[role]} 단계를 실행할 CLI 가 없습니다.${cliHint}`, {
      hint: `LLM_BACKEND=api 로 두고 ${tools.keyName} 를 .env 에 넣는 방법도 있습니다.`,
    });
  }
  if (hasKey) return { role, backend: "api", provider: tools.api, binary: null };
  throw new ConfigError(`${TEXT_ROLE_LABELS[role]} 단계를 실행할 CLI 도 ${tools.keyName} 도 없습니다.${cliHint}`, {
    hint: `claude/codex CLI 에 로그인하거나 .env 에 ${tools.keyName} 를 넣으세요.`,
  });
}

/**
 * doctor 용: 바이너리가 실제로 실행되는지만 2초 안에 확인합니다.
 * 로그인·사용량 문제는 `--version` 으로 드러나지 않으므로 실행 단계에서 `ProviderError` 로 알립니다.
 */
export function probeCliBinary(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: boolean; version: string; reason: string } {
  const result = spawnSync(binary, ["--version"], {
    env: cliEnvironment(env),
    timeout: 2000,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const version = (result.stdout ?? "").trim().split("\n")[0]?.trim() ?? "";
  if (result.error) {
    const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return { ok: false, version, reason: timedOut ? "2초 안에 응답 없음" : result.error.message };
  }
  if (result.status !== 0) {
    const tail = (result.stderr ?? "").trim().split("\n").pop()?.slice(0, 160) ?? "";
    return { ok: false, version, reason: `종료 코드 ${result.status ?? "없음"}${tail ? `: ${tail}` : ""}` };
  }
  return { ok: true, version, reason: "" };
}

/** doctor 용: 예외 없이 이 단계가 지금 실행 가능한지만 알려 줍니다. */
export function textRouteStatus(
  config: Config,
  role: TextRole,
  deps: RouteDeps = {},
): { route: TextRoute | null; detail: string } {
  try {
    const route = textRoute(config, role, deps);
    return {
      route,
      detail: route.backend === "cli" ? `cli · 실행 파일 발견: ${route.binary}` : `api · ${route.provider}`,
    };
  } catch (error) {
    return { route: null, detail: (error as Error).message };
  }
}

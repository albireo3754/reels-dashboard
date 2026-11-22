import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
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
  for (const dir of CLI_PATH_FALLBACK) if (!dirs.includes(dir)) dirs.push(dir);
  env.PATH = dirs.join(path.delimiter);
  for (const name of Object.keys(env)) {
    if ((CLI_LOGIN_ENV_NAMES as readonly string[]).includes(name)) continue;
    if (CLI_SCRUBBED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) delete env[name];
  }
  return env;
}

/** PATH(절대경로 디렉터리만)에서 실행 가능한 `name` 을 찾습니다. 절대경로를 주면 그 파일을 검사합니다. */
export function findCliBinary(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const executable = (candidate: string) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (name.includes(path.sep)) return executable(name) ? name : null;
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    if (executable(candidate)) return candidate;
  }
  return null;
}

/**
 * 자식 CLI 를 한 번 실행하고 결과를 그대로 돌려줍니다(예외를 던지지 않음).
 * 프롬프트는 argv 가 아니라 stdin 으로 넣어 통화 전사문이 프로세스 목록에 남지 않게 합니다.
 */
export const runCliProcess: CliRunner = (run) =>
  new Promise((resolve) => {
    const child = execFile(
      run.file,
      run.args,
      { cwd: run.cwd, env: run.env, timeout: run.timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
        resolve({
          code: typeof failure.code === "number" ? failure.code : null,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          ...(failure.killed || failure.signal ? { timedOut: true } : {}),
          error: failure.message,
        });
      },
    );
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

/** doctor 용: 예외 없이 이 단계가 지금 실행 가능한지만 알려 줍니다. */
export function textRouteStatus(
  config: Config,
  role: TextRole,
  deps: RouteDeps = {},
): { route: TextRoute | null; detail: string } {
  try {
    const route = textRoute(config, role, deps);
    return { route, detail: route.backend === "cli" ? `cli · ${route.binary}` : `api · ${route.provider}` };
  } catch (error) {
    return { route: null, detail: (error as Error).message };
  }
}

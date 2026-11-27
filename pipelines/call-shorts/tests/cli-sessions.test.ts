import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BudgetGuard } from "../src/budget.js";
import {
  cliEnvironment,
  findCliBinary,
  probeCliBinary,
  runCliProcess,
  textRoute,
  textRouteStatus,
  type CliRun,
  type CliRunner,
} from "../src/cli-sessions.js";
import { doctorReport, doctorRows } from "../src/cli.js";
import { BudgetExceededError, ConfigError, ProviderError } from "../src/errors.js";
import { validateEpisode } from "../src/episode.js";
import { resolveFfmpeg } from "../src/media.js";
import { ClaudeCliClient, CodexCliClient, createTextClient } from "../src/providers.js";
import { ScriptWriter } from "../src/scriptwriter.js";
import { localDay, StateStore } from "../src/state.js";
import { mockTranscript, saveTranscript } from "../src/transcribe.js";
import { fixtureEpisode, makeConfig, makeProject } from "./helpers.js";

/** PATH 에 두는 가짜 CLI. 존재·실행 권한만 있으면 탐색에 충분합니다. */
function fakeBins(...names: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "callshorts-bin-"));
  for (const name of names) {
    const file = path.join(dir, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  return dir;
}

function script(name: string, body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "callshorts-script-"));
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

const okRunner =
  (stdout: string): CliRunner =>
  async () => ({ code: 0, stdout, stderr: "" });

test("the CLI child env keeps login locations and drops keys and session vars", () => {
  const env = cliEnvironment({
    HOME: "/tmp/fake-home",
    PATH: "/usr/bin:/bin",
    LANG: "ko_KR.UTF-8",
    CODEX_HOME: "/tmp/fake-home/.codex",
    CLAUDE_CONFIG_DIR: "/tmp/fake-home/.claude",
    ANTHROPIC_API_KEY: "a",
    OPENAI_API_KEY: "o",
    GEMINI_API_KEY: "g",
    CODEX_API_KEY: "c",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    TERM_PROGRAM: "iTerm.app",
  });
  assert.equal(env.HOME, "/tmp/fake-home");
  assert.equal(env.CODEX_HOME, "/tmp/fake-home/.codex");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/tmp/fake-home/.claude");
  assert.equal(
    env.PATH,
    ["/usr/bin", "/bin", "/opt/homebrew/bin", "/usr/local/bin", "/tmp/fake-home/.local/bin"].join(path.delimiter),
  );
  for (const name of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "CODEX_API_KEY",
    "CLAUDE_CODE_ENTRYPOINT",
    "TERM_PROGRAM",
  ]) {
    assert.equal(env[name], undefined, name);
  }
});

test("a CLI binary is found only when it is executable on PATH", () => {
  const bins = fakeBins("claude");
  const plain = path.join(bins, "codex");
  writeFileSync(plain, "#!/bin/sh\n");
  assert.equal(findCliBinary("claude", { PATH: bins }), path.join(bins, "claude"));
  assert.equal(findCliBinary("codex", { PATH: bins }), null, "실행 권한 없는 파일은 CLI 가 아닙니다");
  assert.equal(findCliBinary("claude", { PATH: `relative-dir${path.delimiter}${bins}` }), path.join(bins, "claude"));
  assert.equal(findCliBinary(plain, {}), null);
  assert.equal(findCliBinary("claude", { PATH: "/does/not/exist" }), null);
});

test("a directory on PATH is not mistaken for a CLI binary", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "callshorts-dironly-"));
  mkdirSync(path.join(dir, "claude"));
  assert.equal(findCliBinary("claude", { PATH: dir, HOME: dir }), null, "디렉터리는 실행 파일이 아닙니다");
});

test("binary search and child env share the same fallback dirs", () => {
  const home = mkdtempSync(path.join(tmpdir(), "callshorts-home-"));
  const localBin = path.join(home, ".local", "bin");
  mkdirSync(localBin, { recursive: true });
  writeFileSync(path.join(localBin, "claude"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(localBin, "claude"), 0o755);
  const env = { HOME: home, PATH: "/usr/bin:/bin" };

  assert.equal(findCliBinary("claude", env), path.join(localBin, "claude"), "자식 env 가 보는 PATH 로 탐색해야 합니다");
  assert.ok(cliEnvironment(env).PATH!.split(path.delimiter).includes(localBin));
  assert.equal(cliEnvironment(env).PATH!.split(path.delimiter).at(-1), localBin);
});

test("a CLI that exits before reading a large prompt reports a provider error instead of crashing", async () => {
  const refusing = script("refuses-claude", "exit 1");
  const client = new ClaudeCliClient(makeConfig(), { binary: refusing, runner: runCliProcess });
  const prompt = "여친 통화 전사문 ".repeat(12000);
  assert.ok(prompt.length >= 60_000);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      () => client.complete({ prompt }),
      (error: Error) => error instanceof ProviderError && /종료 코드 1/.test(error.message),
    );
  }
});

test("probeCliBinary tells a working binary from one that fails to run", () => {
  assert.equal(probeCliBinary(script("working-claude", "exit 0"), { HOME: tmpdir() }).ok, true);
  const broken = probeCliBinary(script("broken-claude", "echo 'not logged in' >&2; exit 2"), { HOME: tmpdir() });
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /종료 코드 2.*not logged in/);
  assert.equal(probeCliBinary(path.join(tmpdir(), "no-such-claude"), { HOME: tmpdir() }).ok, false);
});

test("the claude adapter parses the JSON result and keeps the prompt off argv", async () => {
  const runs: CliRun[] = [];
  const client = new ClaudeCliClient(makeConfig(), {
    binary: "/opt/claude",
    runner: async (run) => {
      runs.push(run);
      return {
        code: 0,
        stdout: JSON.stringify({ type: "result", subtype: "success", result: '```json\n{"ok":true}\n```' }),
        stderr: "",
      };
    },
  });
  const text = await client.complete({ prompt: "여친 통화 전사문", system: "훅 카피라이터", schema: { type: "object" } });

  assert.equal(text, '{"ok":true}');
  assert.equal(client.billable, false);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].file, "/opt/claude");
  assert.deepEqual(runs[0].args, ["-p", "--output-format", "json", "--strict-mcp-config"]);
  assert.ok(!runs[0].args.some((arg) => arg.includes("여친 통화")), "전사문은 argv 에 남지 않아야 합니다");
  assert.match(runs[0].stdin, /\[시스템\]\n훅 카피라이터/);
  assert.match(runs[0].stdin, /여친 통화 전사문/);
  assert.match(runs[0].stdin, /\[출력 JSON 스키마\]/);
  assert.equal(runs[0].env.ANTHROPIC_API_KEY, undefined);
});

test("the claude adapter passes a model only when one is configured", async () => {
  const runs: CliRun[] = [];
  const client = new ClaudeCliClient(makeConfig({ CLAUDE_CLI_MODEL: "sonnet" }), {
    binary: "/opt/claude",
    runner: async (run) => {
      runs.push(run);
      return { code: 0, stdout: JSON.stringify({ subtype: "success", result: "ok" }), stderr: "" };
    },
  });
  assert.equal(await client.complete({ prompt: "p" }), "ok");
  assert.deepEqual(runs[0].args.slice(-2), ["--model", "sonnet"]);
});

test("the claude adapter reports exit codes, is_error and non-JSON output", async () => {
  const config = makeConfig();
  const failing = new ClaudeCliClient(config, {
    binary: "/opt/claude",
    runner: async () => ({ code: 2, stdout: "", stderr: "not logged in" }),
  });
  await assert.rejects(
    () => failing.complete({ prompt: "p" }),
    (error: Error) => error instanceof ProviderError && /종료 코드 2/.test(error.message) && /not logged in/.test(error.message),
  );

  const reported = new ClaudeCliClient(config, {
    binary: "/opt/claude",
    runner: okRunner(JSON.stringify({ subtype: "success", is_error: true, result: "usage limit" })),
  });
  await assert.rejects(() => reported.complete({ prompt: "p" }), /실패를 보고했습니다: usage limit/);

  const garbage = new ClaudeCliClient(config, { binary: "/opt/claude", runner: okRunner("not json") });
  await assert.rejects(() => garbage.complete({ prompt: "p" }), /JSON 이 아닙니다/);

  const empty = new ClaudeCliClient(config, {
    binary: "/opt/claude",
    runner: okRunner(JSON.stringify({ subtype: "success", result: "  " })),
  });
  await assert.rejects(() => empty.complete({ prompt: "p" }), /result 문자열이 없습니다/);
});

test("the codex adapter enforces the schema file and reads the final result", async () => {
  const runs: CliRun[] = [];
  let schemaFile = "";
  const client = new CodexCliClient(makeConfig(), {
    binary: "/opt/codex",
    runner: async (run) => {
      runs.push(run);
      schemaFile = run.args[run.args.indexOf("--output-schema") + 1];
      assert.ok(existsSync(schemaFile), "스키마 파일을 먼저 써야 합니다");
      writeFileSync(run.args[run.args.indexOf("-o") + 1], '{"episodeId":"EP01"}');
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const text = await client.complete({ prompt: "대본 지시", system: "편집자", schema: { type: "object" } });

  assert.equal(text, '{"episodeId":"EP01"}');
  assert.equal(client.billable, false);
  const args = runs[0].args;
  assert.deepEqual(args.slice(0, 2), ["--no-daemon", "exec"]);
  for (const flag of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--json"]) {
    assert.ok(args.includes(flag), flag);
  }
  assert.ok(args.includes("--output-schema"));
  assert.ok(!args.some((arg) => arg.includes("대본 지시")), "지시문은 argv 에 남지 않아야 합니다");
  assert.match(runs[0].stdin, /대본 지시/);
  assert.equal(runs[0].env.OPENAI_API_KEY, undefined);
  assert.equal(runs[0].env.CODEX_LOCAL_CHANNEL_DISABLED, "1");
  assert.ok(!existsSync(path.dirname(schemaFile)), "임시 스키마 폴더는 지워져야 합니다");
});

test("the codex adapter falls back to the last agent message", async () => {
  const stdout = [
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "첫 답" } }),
    "not json",
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "| 훅 | 심리축 |" } }),
  ].join("\n");
  const client = new CodexCliClient(makeConfig(), {
    binary: "/opt/codex",
    runner: async (run) => {
      assert.ok(!run.args.includes("--output-schema"));
      return { code: 0, stdout, stderr: "" };
    },
  });
  assert.equal(await client.complete({ prompt: "훅" }), "| 훅 | 심리축 |");
});

test("a missing binary and a timeout surface as provider errors", async () => {
  const missing = new ClaudeCliClient(makeConfig(), { binary: "/nonexistent/claude", runner: runCliProcess });
  await assert.rejects(() => missing.complete({ prompt: "p" }), /claude CLI 종료 코드 없음/);

  const slow = script("slow-claude", "sleep 3");
  const timed = new ClaudeCliClient(makeConfig({ LLM_CLI_TIMEOUT_SEC: "0.2" }), { binary: slow, runner: runCliProcess });
  await assert.rejects(() => timed.complete({ prompt: "p" }), /0.2초 안에 끝나지 않았습니다/);
});

test("runCliProcess passes stdin and returns stdout of a normal exit", async () => {
  const echo = script("echo-claude", "cat");
  const result = await runCliProcess({ file: echo, args: [], stdin: "안녕", env: process.env, cwd: tmpdir(), timeoutMs: 5_000 });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "안녕");
  assert.equal(result.timedOut, undefined);
  assert.equal(result.error, undefined);
});

test("a timeout kills the grandchildren the CLI started", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "callshorts-tree-"));
  // 손자 프로세스가 살아 있는 동안 계속 늘어나는 파일 — 프로세스 표(ps)가 없는 환경에서도 확인됩니다.
  const ticks = path.join(dir, "ticks.log");
  const tree = script("tree-claude", [`( while :; do echo tick >> "${ticks}"; sleep 0.1; done ) &`, "wait"].join("\n"));

  const result = await runCliProcess({ file: tree, args: [], stdin: "", env: process.env, cwd: dir, timeoutMs: 600 });
  assert.equal(result.timedOut, true);

  const before = readFileSync(ticks, "utf8").length;
  assert.ok(before > 0, "검사 전에 손자 프로세스가 돌고 있어야 합니다");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(readFileSync(ticks, "utf8").length, before, "타임아웃 뒤 손자 프로세스가 남아 있으면 안 됩니다");
});

test("a CLI that ignores SIGTERM is killed after the grace period", async () => {
  const stubborn = script("stubborn-claude", ["trap '' TERM", "while :; do sleep 1; done"].join("\n"));
  const started = Date.now();
  const result = await runCliProcess({ file: stubborn, args: [], stdin: "", env: process.env, cwd: tmpdir(), timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started >= 2_000, "SIGTERM 유예를 기다린 뒤 SIGKILL 해야 합니다");
  assert.ok(Date.now() - started < 10_000, "유예를 넘겨 오래 매달리면 안 됩니다");
});

test("output over the buffer limit stops the child instead of growing memory", async () => {
  const noisy = script("noisy-claude", "head -c 9000000 /dev/zero | tr '\\0' 'a'");
  const result = await runCliProcess({ file: noisy, args: [], stdin: "", env: process.env, cwd: tmpdir(), timeoutMs: 10_000 });
  assert.equal(result.timedOut, undefined, "출력 초과를 타임아웃으로 보고하면 안 됩니다");
  assert.ok(result.code !== 0);
  assert.match(result.error ?? "", /8MB/);
  assert.ok(result.stdout.length <= 8 * 1024 * 1024);
});

test("LLM_BACKEND decides between the CLI session and the REST API", () => {
  const bins = fakeBins("claude", "codex");
  const env = { PATH: bins };
  const cli = makeConfig({ LLM_BACKEND: "cli" });
  assert.deepEqual(
    { backend: textRoute(cli, "planner", { env }).backend, binary: textRoute(cli, "planner", { env }).binary },
    { backend: "cli", binary: path.join(bins, "claude") },
  );
  assert.equal(textRoute(cli, "formatter", { env }).provider, "codex-cli");
  assert.throws(() => textRoute(cli, "planner", { env: { PATH: "/does/not/exist" } }), ConfigError);

  const configured = makeConfig({ CLAUDE_CLI_BIN: path.join(bins, "claude") });
  assert.equal(textRoute(configured, "planner", { env: { PATH: "" } }).binary, path.join(bins, "claude"));

  const auto = makeConfig({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" });
  const empty = { env: { PATH: "/does/not/exist" } };
  assert.equal(textRoute(auto, "planner", empty).backend, "api");
  assert.equal(textRoute(auto, "planner", empty).provider, "anthropic");
  assert.throws(() => textRoute(makeConfig(), "formatter", empty), /CLI 도 OPENAI_API_KEY 도 없습니다/);

  const api = makeConfig({ LLM_BACKEND: "api", ANTHROPIC_API_KEY: "a" });
  assert.equal(textRoute(api, "planner", { env }).backend, "api");
  assert.equal(textRouteStatus(api, "formatter", { env }).route, null);
  assert.match(textRouteStatus(api, "formatter", { env }).detail, /OPENAI_API_KEY/);
});

test("createTextClient follows the resolved route", () => {
  const bins = fakeBins("claude", "codex");
  const env = { PATH: bins };
  const cli = makeConfig({ LLM_BACKEND: "cli" });
  assert.equal(createTextClient(cli, "planner", { env }).name, "claude-cli");
  assert.equal(createTextClient(cli, "formatter", { env }).name, "codex-cli");
  assert.equal(createTextClient(makeConfig({ LLM_BACKEND: "api", ANTHROPIC_API_KEY: "a" }), "planner", { env }).name, "anthropic");
});

test("the writer plans and writes on CLI sessions with no API key and no budget", async () => {
  const bins = fakeBins("claude", "codex");
  const config = makeConfig({ LLM_BACKEND: "cli", DAILY_BUDGET_USD: "0", MAX_EPISODE_USD: "0" });
  const transcript = mockTranscript();
  const project = makeProject(config.rootDir);
  saveTranscript(project, transcript);
  const payload = JSON.stringify(fixtureEpisode(transcript));
  const runs: CliRun[] = [];
  const runner: CliRunner = async (run) => {
    runs.push(run);
    if (run.file.endsWith("claude")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          subtype: "success",
          result: "| 훅 | 심리축 | 첫 프레임 | 회수 구간 |\n|---|---|---|---|\n| 충격 인용 | a | b | 1.0s |",
        }),
        stderr: "",
      };
    }
    writeFileSync(run.args[run.args.indexOf("-o") + 1], payload);
    return { code: 0, stdout: "", stderr: "" };
  };

  const store = new StateStore(config.stateFile);
  const writer = new ScriptWriter(config, store, { cli: { runner, env: { PATH: bins } } });
  const hooks = await writer.plan(project, transcript);
  assert.match(readFileSync(hooks, "utf8"), /모드: claude-cli/);

  const episode = await writer.writeEpisode(project, transcript);
  assert.deepEqual(validateEpisode(episode, transcript), []);
  assert.equal(runs.length, 2);
  assert.ok(runs[0].file.endsWith("claude"));
  assert.ok(runs[1].file.endsWith("codex"));
  assert.deepEqual(
    store.costByProvider().map(({ provider, usd }) => ({ provider, usd })),
    [
      { provider: "claude-cli", usd: 0 },
      { provider: "codex-cli", usd: 0 },
    ],
  );
  assert.equal(store.costOnDay(localDay()), 0);
});

test("CLI sessions do not consume the API budget", () => {
  const config = makeConfig({ DAILY_BUDGET_USD: "0", MAX_EPISODE_USD: "0" });
  const store = new StateStore(config.stateFile);
  const guard = new BudgetGuard(config, store);
  assert.doesNotThrow(() => guard.checkLlm("/p", false));
  assert.throws(() => guard.checkLlm("/p", true), BudgetExceededError);
  assert.equal(guard.recordLlm("claude-cli", "plan", "/p", false), 0);
  assert.equal(guard.recordLlm("anthropic", "plan", "/p", true), 0.03);
  assert.equal(store.costOnDay(localDay()), 0.03);
  assert.deepEqual(
    store.costByProvider().map(({ provider, calls }) => ({ provider, calls })),
    [
      { provider: "anthropic", calls: 1 },
      { provider: "claude-cli", calls: 1 },
    ],
  );
});

test("doctor passes on CLI sessions without API keys and names the image key", (t) => {
  const ffmpeg = resolveFfmpeg(makeConfig());
  if (!ffmpeg) return t.skip("ffmpeg 없음");
  const bins = fakeBins("claude", "codex");
  const config = makeConfig({ LLM_BACKEND: "cli", FFMPEG_BIN: ffmpeg, IMAGE_PROVIDER: "gemini" });
  const rows = doctorRows(config, { env: { PATH: bins } });

  const planner = rows.find(([, label]) => label === "기획 (claude)")!;
  assert.equal(planner[0], "OK");
  assert.match(planner[2], /^cli · 실행 확인: /);
  assert.equal(rows.find(([, label]) => label === "대본 (codex)")![0], "OK");
  assert.equal(rows.find(([, label]) => label === "anthropic key")![2], "필요 없음 (CLI 세션 사용)");
  const image = rows.find(([, label]) => label === "이미지 (illustrator)")!;
  assert.equal(image[0], "WARN");
  assert.match(image[2], /GEMINI_API_KEY 없음.*PNG 를 만들 수 없습니다/);
  assert.equal(doctorReport(config, rows), 0);

  const missing = doctorRows(makeConfig({ LLM_BACKEND: "cli", FFMPEG_BIN: ffmpeg }), { env: { PATH: "" } });
  assert.equal(missing.find(([, label]) => label === "대본 (codex)")![0], "FAIL");
  assert.match(missing.find(([, label]) => label === "기획 (claude)")![2], /CLAUDE_CLI_BIN/);
});

test("doctor fails a CLI binary that exists but cannot run", () => {
  const bins = mkdtempSync(path.join(tmpdir(), "callshorts-broken-"));
  for (const name of ["claude", "codex"]) {
    const file = path.join(bins, name);
    writeFileSync(file, "#!/bin/sh\necho 'not logged in' >&2\nexit 1\n");
    chmodSync(file, 0o755);
  }
  const rows = doctorRows(makeConfig({ LLM_BACKEND: "cli", IMAGE_PROVIDER: "mock" }), { env: { PATH: bins, HOME: bins } });
  const planner = rows.find(([, label]) => label === "기획 (claude)")!;
  assert.equal(planner[0], "FAIL");
  assert.match(planner[2], /실행 파일은 있으나 실행 실패/);
  assert.match(planner[2], /종료 코드 1/);
  assert.equal(rows.find(([, label]) => label === "대본 (codex)")![0], "FAIL");
});

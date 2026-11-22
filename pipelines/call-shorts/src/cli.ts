#!/usr/bin/env node

import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { maskedConfig, ensureDirs, loadConfig, type Config } from "./config.js";
import { probeCliBinary, TEXT_ROLE_LABELS, textRouteStatus } from "./cli-sessions.js";
import { ConfigError, NeedsHumanError, PipelineError } from "./errors.js";
import { ffmpegVersion, resolveFfmpeg, resolveFfprobe, which } from "./media.js";
import { Pipeline } from "./runner.js";
import { StateStore } from "./state.js";
import { discoverAudioFiles, stuckProcessingFiles } from "./watcher.js";
import { mapSpeakers } from "./transcribe.js";
import { apiIntake } from "./api-intake.js";
import { STAGES, type RunResult, type Stage } from "./types.js";

function exitCode(results: RunResult[]): number {
  const codes = results.map((result) =>
    ({ done: 0, skipped: 0, needs_review: 3, blocked: 4, failed: 1 } as Record<string, number>)[result.status] ?? 1,
  );
  return codes.length ? Math.max(...codes) : 0;
}

function describe(result: RunResult): string {
  const icon =
    ({ done: "✅", needs_review: "🟡", blocked: "🟠", failed: "❌", skipped: "⏭️" } as Record<string, string>)[result.status] ?? "•";
  const stages = Object.entries(result.stages)
    .map(([name, status]) => `${name}:${status}`)
    .join(" ");
  const lines = [`${icon} ${result.episodeId} [${result.status}] ${result.projectDir}`];
  if (stages) lines.push(`   단계: ${stages}`);
  if (result.message) lines.push(`   ${result.message}`);
  if (result.video) lines.push(`   영상: ${result.video}`);
  if (result.meta) lines.push(`   메타: ${result.meta}`);
  return lines.join("\n");
}

/** positional `dry-run` 명령과 `--dry-run` 플래그 둘 다 실제 DRY_RUN=1 로 만듭니다. */
export function applyDryRunEnv(
  env: Record<string, string | undefined>,
  command: string,
  values: { "dry-run"?: boolean },
): Record<string, string | undefined> {
  if (values["dry-run"] || command === "dry-run") env.DRY_RUN = "1";
  return env;
}

const IMAGE_ROW_LABEL = "이미지 (illustrator)";

function imageRow(config: Config): [string, string, string] {
  const provider = config.imageProvider;
  if (provider === "mock") return ["OK", IMAGE_ROW_LABEL, "mock (PNG 대신 손그림 mock, 무료)"];
  const key = provider === "gemini" ? config.geminiApiKey : config.openaiApiKey;
  if (key) {
    const model = provider === "gemini" ? config.imageModel : config.imageModelFallback;
    return ["OK", IMAGE_ROW_LABEL, `${provider} · ${model}`];
  }
  return [
    "WARN",
    IMAGE_ROW_LABEL,
    `${provider.toUpperCase()}_API_KEY 없음 — 텍스트 CLI 로는 PNG 를 만들 수 없습니다 (IMAGE_PROVIDER=mock 으로 시험)`,
  ];
}

/** doctor 의 점검 표. `deps.env` 는 CLI 탐색에 쓰는 환경입니다(테스트 주입). */
export function doctorRows(config: Config, deps: { env?: NodeJS.ProcessEnv } = {}): Array<[string, string, string]> {
  const rows: Array<[string, string, string]> = [];
  rows.push(["OK", "node", process.version]);

  const ffmpeg = resolveFfmpeg(config);
  rows.push(ffmpeg ? ["OK", "ffmpeg", ffmpegVersion(config) ?? ffmpeg] : ["FAIL", "ffmpeg", "없음 — brew install ffmpeg (렌더 불가)"]);
  const ffprobe = resolveFfprobe(config);
  rows.push([ffprobe ? "OK" : "WARN", "ffprobe", ffprobe ?? "없음 — ffmpeg 출력으로 대체"]);
  rows.push([which("whisperx") ? "OK" : "WARN", "whisperx", which("whisperx") ?? "없음 — mock/gemini/whisper 사용"]);
  rows.push([which("whisper") ? "OK" : "WARN", "whisper", which("whisper") ?? "없음"]);

  rows.push(["OK", "LLM_BACKEND", `${config.llmBackend} (텍스트 기획·대본)`]);
  const routes = { planner: textRouteStatus(config, "planner", deps), formatter: textRouteStatus(config, "formatter", deps) };
  for (const role of ["planner", "formatter"] as const) {
    const status = routes[role];
    if (status.route?.backend !== "cli") {
      rows.push([status.route ? "OK" : "FAIL", TEXT_ROLE_LABELS[role], status.detail]);
      continue;
    }
    const binary = status.route.binary ?? "";
    const probe = probeCliBinary(binary, deps.env);
    rows.push([
      probe.ok ? "OK" : "FAIL",
      TEXT_ROLE_LABELS[role],
      probe.ok
        ? `cli · 실행 확인: ${binary}${probe.version ? ` — ${probe.version.slice(0, 60)}` : ""}`
        : `cli · 실행 파일은 있으나 실행 실패: ${binary} — ${probe.reason}`,
    ]);
  }

  const cliNote = (cli: boolean) => (cli ? "필요 없음 (CLI 세션 사용)" : "없음 (.env)");
  rows.push([
    config.anthropicApiKey || routes.planner.route?.backend === "cli" ? "OK" : "WARN",
    "anthropic key",
    config.anthropicApiKey ? "설정됨" : cliNote(routes.planner.route?.backend === "cli"),
  ]);
  rows.push([
    config.openaiApiKey || routes.formatter.route?.backend === "cli" ? "OK" : "WARN",
    "openai key",
    config.openaiApiKey ? "설정됨" : cliNote(routes.formatter.route?.backend === "cli"),
  ]);
  rows.push([
    config.geminiApiKey ? "OK" : "WARN",
    "gemini key",
    config.geminiApiKey ? "설정됨" : config.imageProvider === "gemini" || config.transcribeBackend === "gemini" ? "없음 (.env) — 아래 이미지/전사 안내 참고" : "없음 (필요 없음)",
  ]);
  rows.push(imageRow(config));

  try {
    const created = ensureDirs(config);
    rows.push(["OK", "폴더", `inbox=${config.inboxDir} (새로 만든 폴더 ${created.length}개)`]);
  } catch (error) {
    rows.push(["FAIL", "폴더", (error as Error).message]);
  }

  const store = new StateStore(config.stateFile);
  const summary = store.summary();
  rows.push(["OK", "state", `${config.stateFile} · files=${JSON.stringify(summary.files)} · 오늘 $${summary.costTodayUsd}`]);

  const pending = discoverAudioFiles(config.inboxDir, config.allowedExtensions);
  rows.push(["OK", "inbox 파일", `${pending.length}개 처리 대기`]);
  return rows;
}

export function doctorReport(config: Config, rows: Array<[string, string, string]>): number {
  const width = Math.max(...rows.map(([, label]) => label.length)) + 1;
  console.log(`call-shorts-pipeline (TS) — ${maskedConfig(config)}`);
  for (const [level, label, detail] of rows) console.log(`  [${level.padEnd(4)}] ${label.padEnd(width)} ${detail}`);
  const failures = rows.filter(([level]) => level === "FAIL");
  if (failures.length) {
    console.log(`\n${failures.length}개 문제를 고친 뒤 다시 실행하세요.`);
    return 2;
  }
  const imageWarned = rows.some(([level, label]) => level === "WARN" && label === IMAGE_ROW_LABEL);
  if (imageWarned) {
    console.log("\n텍스트 기획·대본은 준비됐습니다. 이미지 단계는 GEMINI_API_KEY 또는 OPENAI_API_KEY 를 넣거나 IMAGE_PROVIDER=mock 으로 시험하세요.");
    return 0;
  }
  console.log("\n준비됐습니다. `npm run call-shorts -- dry-run --render`로 한 편을 끝까지 시험해 보세요.");
  return 0;
}

function doctor(config: Config): number {
  return doctorReport(config, doctorRows(config));
}

function status(config: Config, asJson: boolean): number {
  const store = new StateStore(config.stateFile);
  const processing = store.listFiles(1000).filter((record) => record.status === "processing");
  const stuck = stuckProcessingFiles(store);
  const describe = (record: (typeof processing)[number]) => ({
    sha256: record.sha256,
    sourcePath: record.sourcePath,
    projectDir: record.projectDir,
    updatedAt: record.updatedAt,
  });
  const payload = {
    summary: store.summary(),
    recentFiles: store.listFiles(10),
    processingFiles: processing.map(describe),
    stuckProcessing: stuck.map(describe),
    costByDay: store.costByDay(14),
    costByProvider: store.costByProvider(),
    inboxPending: discoverAudioFiles(config.inboxDir, config.allowedExtensions),
  };
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }
  const summary = payload.summary;
  console.log(`에피소드 ${summary.episodes}편 · 오늘 $${summary.costTodayUsd.toFixed(2)} / 총 $${summary.costTotalUsd.toFixed(2)}`);
  console.log(`파일 상태: ${Object.keys(summary.files).length ? JSON.stringify(summary.files) : "없음"}`);
  if (processing.length) {
    console.log(
      `처리 중 ${processing.length}건${stuck.length ? ` (3시간 이상 고착 ${stuck.length}건)` : ""} — 중단됐다면 run-once --force 로 재시도:`,
    );
    for (const record of processing.slice(0, 5)) console.log(`  · ${record.sourcePath} (${record.updatedAt})`);
  }
  if (payload.inboxPending.length) {
    console.log(`inbox 대기 ${payload.inboxPending.length}개:`);
    for (const file of payload.inboxPending.slice(0, 5)) console.log(`  · ${file}`);
  }
  if (payload.costByDay.length) {
    console.log("\n일별 비용(USD):");
    for (const row of payload.costByDay) console.log(`  ${row.day}  $${row.usd.toFixed(3)}  (${row.calls}회)`);
  }
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        root: { type: "string" },
        verbose: { type: "boolean" },
        quiet: { type: "boolean" },
        file: { type: "string" },
        live: { type: "boolean" },
        stage: { type: "string" },
        force: { type: "boolean" },
        "dry-run": { type: "boolean" },
        render: { type: "boolean" },
        limit: { type: "string" },
        interval: { type: "string" },
        project: { type: "string" },
        a: { type: "string" },
        b: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean" },
      },
    });
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }

  const values = parsed.values;
  const command = parsed.positionals[0] ?? "help";
  if (values.help || command === "help") {
    printHelp();
    return 0;
  }

  if (command === "api-intake") {
    if (!values.file || parsed.positionals.length !== 1 || Object.keys(values).some(k => !["file", "live"].includes(k))) {
      console.error("사용법: call-shorts api-intake --file /absolute/recording.m4a --live");
      return 2;
    }
    try {
      const result = await apiIntake(values.file, values.live === true);
      console.log(JSON.stringify(result));
      return 3; // artifacts ready; human review is still pending
    } catch (error) {
      console.error(error instanceof PipelineError ? error.message : "로컬 전사/검수 작업을 완료하지 못했습니다.");
      return error instanceof PipelineError ? error.exitCode : 1;
    }
  }

  const env: Record<string, string | undefined> = { ...process.env };
  if (values.root) env.PIPELINE_ROOT = values.root.startsWith("~") ? path.join(homedir(), values.root.slice(1)) : values.root;
  applyDryRunEnv(env, command, values);

  let config: Config;
  try {
    config = loadConfig({ env });
  } catch (error) {
    console.error(`설정 오류: ${(error as Error).message}`);
    return 2;
  }

  try {
    if (command === "doctor") return doctor(config);
    if (command === "status") return status(config, Boolean(values.json));
    if (command === "map-speakers") {
      if (!values.project) throw new PipelineError("--project 가 필요합니다.");
      const store = new StateStore(config.stateFile);
      const transcript = mapSpeakers(values.project, values.a ?? "GF", values.b ?? "BF", store);
      console.log(`화자 매핑 저장: ${JSON.stringify(transcript.speakerMap)}`);
      console.log(`이어서 실행: npm run call-shorts -- resume --project ${values.project} --stage plan`);
      return 0;
    }

    const stage = values.stage as Stage | undefined;
    if (stage && !STAGES.includes(stage)) throw new PipelineError(`알 수 없는 단계입니다: ${stage}`);

    const pipeline = new Pipeline(config, undefined, {
      executeRender: !config.dryRun || Boolean(values.render),
    });

    if (command === "run-once" || command === "dry-run") {
      const results = await pipeline.runOnce({
        file: values.file,
        startStage: stage,
        force: Boolean(values.force),
        limit: values.limit ? Number(values.limit) : 1,
      });
      if (!results.length) {
        const processing = pipeline.store.listFiles(1000).filter((record) => record.status === "processing");
        console.log("처리할 새 통화가 없습니다.");
        if (processing.length) console.log(`처리 중 ${processing.length}건 — 중단됐다면 run-once --force 로 재시도하세요.`);
        return 0;
      }
      for (const result of results) console.log(describe(result));
      return exitCode(results);
    }

    if (command === "watch") {
      const { watchForever } = await import("./watcher.js");
      // watch 는 오래 떠 있으므로 시작할 때 락을 잡아 launchd 의 run-once 와 겹치지 않게 합니다.
      await pipeline.runExclusive("watch", async () => {
        await watchForever(config, pipeline.store, async (item) => {
          const result = await pipeline.runFile(item.path, { sha256: item.sha256, force: Boolean(values.force) });
          console.log(describe(result));
        }, { intervalSec: values.interval ? Number(values.interval) : undefined, force: Boolean(values.force) });
      });
      return 0;
    }

    if (command === "resume") {
      if (!values.project) throw new PipelineError("--project 가 필요합니다.");
      const result = await pipeline.resume(values.project, stage, Boolean(values.force));
      console.log(describe(result));
      return exitCode([result]);
    }

    printHelp();
    return 1;
  } catch (error) {
    if (error instanceof NeedsHumanError) {
      console.error(`사람 확인 필요: ${error.message}`);
      if (error.hint) console.error(`힌트: ${error.hint}`);
      if (error.action) console.error(`다음 명령: ${error.action}`);
      return 3;
    }
    if (error instanceof ConfigError) {
      console.error(`설정 오류: ${error.message}`);
      return 2;
    }
    if (error instanceof PipelineError) {
      console.error(`실패: ${error.message}`);
      if (error.hint) console.error(`힌트: ${error.hint}`);
      return error.exitCode;
    }
    console.error((error as Error).stack ?? String(error));
    return 1;
  }
}

function printHelp(): void {
  console.log(`통화 녹음 → 손그림 9:16 숏폼 파이프라인

  npm run call-shorts -- run-once [--file <경로>] [--stage <단계>] [--force] [--limit N]
  npm run call-shorts -- watch [--interval 초]
  npm run call-shorts -- dry-run [--file <경로>] [--render]
  npm run call-shorts -- api-intake --file <로컬 절대경로> --live
  npm run call-shorts -- doctor
  npm run call-shorts -- status [--json]
  npm run call-shorts -- resume --project <EP폴더> [--stage <단계>] [--force]
  npm run call-shorts -- map-speakers --project <EP폴더> --a GF --b BF

공통: --root <폴더>  (기본: iCloud Drive/여친탐구생활)
단계: ${STAGES.join(" | ")}`);
}

/** 테스트에서 임시 루트를 쓸 때. */
export function tempRootConfig(root: string): Config {
  return loadConfig({ env: { ...process.env, PIPELINE_ROOT: root }, useDotenv: false });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => {
    process.exitCode = code;
  });
}

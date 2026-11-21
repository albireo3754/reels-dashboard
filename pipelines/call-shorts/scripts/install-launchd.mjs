#!/usr/bin/env node
/**
 * launchd 등록 — launchd/com.firyoon.callshorts.plist.template 을 실제 값으로 채워
 * ~/Library/LaunchAgents 에 설치하고 bootstrap 합니다. (대화형 질문 없음)
 *
 *   node pipelines/call-shorts/scripts/install-launchd.mjs [--root <iCloud폴더>] [--dry-run] [--uninstall]
 *
 * - 매일 07:30 (StartCalendarInterval)
 * - inbox 폴더에 파일이 생기면 (WatchPaths)
 * - 로그: <root>/logs/launchd.out.log, launchd.err.log
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(PIPELINE_DIR, "..", "..");
const TEMPLATE = path.join(PIPELINE_DIR, "launchd", "com.firyoon.callshorts.plist.template");
const LABEL = "com.firyoon.callshorts";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const dryRun = process.argv.includes("--dry-run");
const uninstall = process.argv.includes("--uninstall");
const root = arg("--root", process.env.PIPELINE_ROOT ?? path.join(homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs", "여친탐구생활"));
const agentPath = path.join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

function run(command, args, options = {}) {
  try {
    const output = execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
    return { ok: true, output: output ?? "" };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? ""}`.trim() };
  }
}

if (process.platform !== "darwin") {
  console.error("launchd는 macOS 전용입니다. 맥에서 실행하세요.");
  process.exit(1);
}

if (uninstall) {
  if (!dryRun) {
    run("launchctl", ["bootout", `gui/${process.getuid()}`, agentPath]);
    if (existsSync(agentPath)) unlinkSync(agentPath);
  }
  console.log(`제거${dryRun ? "(예정)" : ""}: ${agentPath}`);
  process.exit(0);
}

if (!existsSync(TEMPLATE)) {
  console.error(`템플릿이 없습니다: ${TEMPLATE}`);
  process.exit(1);
}

const nodePath = process.execPath;
const fill = readFileSync(TEMPLATE, "utf8")
  .replaceAll("__REPO__", REPO_ROOT)
  .replaceAll("__PIPELINE_DIR__", PIPELINE_DIR)
  .replaceAll("__NODE__", nodePath)
  .replaceAll("__ROOT__", root)
  .replaceAll("__HOME__", homedir())
  .replaceAll("__PATH__", `${path.dirname(nodePath)}:/opt/homebrew/bin:/usr/local/bin:${homedir()}/.local/bin:/usr/bin:/bin`);

if (dryRun) {
  console.log(fill);
  process.exit(0);
}

mkdirSync(path.join(root, "logs"), { recursive: true });
mkdirSync(path.dirname(agentPath), { recursive: true });
writeFileSync(agentPath, fill, "utf8");

const uid = process.getuid();
run("launchctl", ["bootout", `gui/${uid}`, agentPath]);
const bootstrap = run("launchctl", ["bootstrap", `gui/${uid}`, agentPath]);
if (!bootstrap.ok) {
  console.error(`launchctl bootstrap 실패: ${bootstrap.output}`);
  console.error("이미 등록되어 있다면 'launchctl bootout' 후 다시 실행하세요.");
  process.exit(1);
}
run("launchctl", ["enable", `gui/${uid}/${LABEL}`]);
run("launchctl", ["kickstart", "-k", `gui/${uid}/${LABEL}`]);

console.log(`설치 완료: ${agentPath}`);
console.log(`  label      : ${LABEL}`);
console.log(`  스케줄     : 매일 07:30 + inbox 감시`);
console.log(`  루트       : ${root}`);
console.log(`  로그       : ${path.join(root, "logs", "launchd.out.log")}`);
console.log(`상태: ${run("launchctl", ["print", `gui/${uid}/${LABEL}`]).ok ? "등록됨" : "확인 실패"}`);
console.log("해제: node pipelines/call-shorts/scripts/install-launchd.mjs --uninstall");

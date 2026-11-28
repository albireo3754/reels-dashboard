import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parse } from "../shared/blog-markup";
import type { BlogPublishChoice, BlogPublishLaunch } from "../shared/blog-publication";
import { sha256Hex } from "../shared/lib/hash";
import { LocalStore } from "../shared/lib/storage";
import { publicationOn } from "../shared/publications";
import { blogProjectsFrom } from "./blog-projects";
import { terminalEnvironment } from "./workbench";

const exec = promisify(execFile);

async function launchAgent(args: string[]) {
  try {
    const { stdout } = await exec("agent-up", args, { env: terminalEnvironment(), timeout: 30_000 });
    return JSON.parse(stdout);
  } catch (error) {
    const failure = error as { code?: string; stderr?: string; killed?: boolean };
    if (failure.code === "ENOENT") throw new Error("Herdr 실행 도구(agent-up)를 찾지 못했어요.");
    if (failure.killed) throw new Error("Herdr 실행 응답을 기다리다 시간이 지났어요. Herdr에서 발행 탭이 열렸는지 확인해주세요.");
    if (failure.stderr?.includes("Herdr 앱 창이 없다")) throw new Error("Herdr 앱을 연 뒤 다시 발행을 요청해주세요.");
    if (failure.stderr?.includes("이미 같은 이름의 hc 터미널이 있다")) {
      throw new Error("이 글의 발행 작업이 Herdr에 있어요. 기존 발행 탭에서 확인하거나 이어서 진행해주세요.");
    }
    throw new Error("Herdr에서 발행 작업 시작을 확인하지 못했어요. Herdr의 발행 탭을 확인해주세요.");
  }
}

export function createBlogPublisher(
  root: string,
  launch = launchAgent,
  blogRoot = path.join(homedir(), "Obsidian", "side", "blog"),
) {
  const publishing = new Set<string>();
  const store = new LocalStore(root);
  const skill = path.join(blogRoot, ".claude/skills/naver-smarteditor-publisher/SKILL.md");
  return async function publish(projectId: string, request: BlogPublishChoice, expected?: { canon: string; revision: string }): Promise<BlogPublishLaunch> {
    if (publishing.has(projectId)) throw new Error("이 글의 Herdr 발행 작업을 여는 중이에요.");
    publishing.add(projectId);
    try {
      const card = (await store.load()).projects.find((project) => project.id === projectId);
      if (!card) throw new Error("연결된 블로그 카드를 찾지 못했어요.");
      const publication = publicationOn(card, "blog");
      if (publication?.status === "published") throw new Error("이미 네이버 블로그에 발행한 글이에요.");
      const previousSchedule = publication?.scheduledAt;
      if (previousSchedule && (Date.parse(previousSchedule) > Date.now() || request.mode === "scheduled")) {
        throw new Error("이미 네이버 블로그 발행이 예약된 글이에요.");
      }
      if (request.mode === "scheduled" && Date.parse(request.scheduledAt) <= Date.now()) {
        throw new Error("예약 발행은 한국 시간 기준으로 앞으로의 시각을 선택해주세요.");
      }
      const { projects: [project] } = await blogProjectsFrom([card]);
      if (!project) throw new Error("프로젝트에 연결된 블로그 정본을 찾지 못했어요.");
      const canon = project.config.canon;
      const source = await readFile(canon, "utf8");
      const revision = sha256Hex(source);
      if (expected && (expected.canon !== canon || expected.revision !== revision)) {
        throw new Error("저장된 원고가 바뀌었어요. 최신 원고를 확인하고 다시 요청해주세요.");
      }
      if (!String(parse(source).metadata?.title ?? "").trim()) throw new Error("글 제목을 입력해주세요.");
      await access(skill).catch(() => { throw new Error("로컬 네이버 블로그 발행 가이드를 찾지 못했어요."); });

      const terminalName = `reels-blog-${sha256Hex(canon).slice(0, 20)}`;
      const spaceName = `블로그 발행 · ${card.title.replace(/[\x00-\x1f\x7f]/g, " ")}`;
      const label = previousSchedule ? "예약 결과 확인" : request.mode === "now" ? "즉시 발행" : "예약 발행";
      const handoffs = path.join(root, "blog-publish");
      await mkdir(handoffs, { recursive: true, mode: 0o700 });
      const handoff = path.join(handoffs, `${randomUUID()}.md`);
      const target = { projectId, canon, revision, mode: request.mode, previousSchedule,
        ...(request.mode === "scheduled" ? { scheduledAt: request.scheduledAt } : {}) };
      await writeFile(handoff, [
        `# 네이버 블로그 ${label}`,
        "사용자가 Reels Dashboard에서 아래 원고 한 건의 발행 요청을 확정했다.",
        "```json",
        JSON.stringify(target, null, 2),
        "```",
        "",
        `발행 절차는 ${JSON.stringify(skill)}과 그 안의 Aside 이관 가이드를 따른다. 기존 로컬 준비·검수·임시저장본을 확인하고 재사용한다. 네이버 화면 조작은 해당 절차대로 Aside CLI에 인계한다.`,
        "Reels Dashboard에서 카드 ID와 원고 연결, 블로그 채널 상태를 먼저 읽고 네이버에서 대상 계정과 글을 대조한다. 이미 예약되거나 공개된 글, 다른 세션의 미저장 변경이 보이면 중복 입력 없이 확인 결과를 남긴다.",
        "요청 revision은 저장된 정본의 SHA-256이다. 준비 전에 확인하고 Aside가 최종 제출하기 직전에도 다시 확인하도록 인계한다. 원고가 바뀌었으면 새 버전은 별도 발행 요청을 받는다.",
        previousSchedule
          ? "Dashboard에는 이미 지난 예약이 기록돼 있다. 이번 작업에서는 해당 예약 결과를 확인한다. 필요하면 Aside로 계정의 게시글·예약 목록을 읽고 같은 글의 공개 URL, 실제 한국 날짜, 본문을 대조한다. 공개된 글은 다시 발행하거나 수정하지 않는다. 공개 확인이 안 되면 재등록·즉시 발행 없이 보류 이유와 네이버 상태를 남긴다."
          : request.mode === "now"
          ? "대상 글의 즉시 발행만 요청한다. 발행 후 공개 페이지의 URL, 실제 한국 날짜, 본문을 대조한다."
          : "한국 시간 기준 지정한 시각으로만 예약한다. 네이버 예약 목록에서 같은 글과 정확한 시각이 확인되어야 성공이다. 기존 예약 목록을 확인할 수 있으면 이관 전에 확인한다. 예약 한도가 찼거나 지정한 시각을 선택할 수 없으면 그 자리에서 보류한다. 다른 날짜·시각 선택, 즉시 발행으로 전환, 기존 예약 변경·삭제, 자동 재시도는 하지 않는다. 날짜가 지났으면 보류한다.",
        "",
        "## 확인 및 기록",
        "- 확인한 상태를 Dashboard의 해당 프로젝트 블로그 채널에 기록한다. 실제 예약은 scheduled와 scheduledAt, 공개 확인은 published와 URL·한국 날짜를 사용한다. 보류 시 확인한 임시저장본은 draft로 기록할 수 있다. 기존 예약·공개 기록을 낮추거나 확인되지 않은 상태를 기록하지 않는다. 카드 갱신 뒤 기존 발행 기록 절차를 따른다.",
        "- 이 파일과 Herdr 대화에 결과(발행 완료·예약 완료·보류), 요청/확인 시각, 마지막으로 확인한 네이버 상태와 근거, Aside 세션 ID를 남긴다. 예약이 찼으면 화면에서 확인한 이유와 이어서 할 일을 남기고 사용자가 이 Herdr 탭에서 검토할 수 있도록 작업을 끝낸다.",
        "",
      ].join("\n"), { flag: "wx", mode: 0o600 });

      const result = await launch([
        terminalName, "--kind", "claude", "--new-workspace", spaceName,
        "--cwd", blogRoot, "--label", label, "--mcp", "reels",
        "--prompt", `Reels Dashboard에서 요청한 네이버 블로그 발행입니다. 발행 지시서 ${JSON.stringify(handoff)}를 읽고 이 작업만 수행해주세요. 결과는 지시서와 이 Herdr 탭에 남겨주세요.`,
      ]);
      if (!result?.space || typeof result?.terminal !== "string" || !result.terminal.trim() || result.prompted !== true) {
        throw new Error("Herdr에서 발행 작업 시작을 확인하지 못했어요. Herdr의 발행 탭을 확인해주세요.");
      }
      return { terminal: result.terminal, spaceName };
    } finally {
      publishing.delete(projectId);
    }
  };
}

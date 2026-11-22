import type { Config } from "./config.js";
import { BudgetExceededError } from "./errors.js";
import { localDay, type StateStore } from "./state.js";

// 토큰 실측 없이 호출 전에 예약하는 보수적 상한(USD). 실제 청구액과는 다를 수 있습니다.
export const LLM_CALL_RESERVE_USD = 0.03;

/**
 * 로컬 `claude`/`codex` CLI 세션은 구독 로그인으로 돌아 API 종량 과금이 없습니다.
 * 그래서 예약액 0으로 기록해 일일·편당 상한을 소모하지 않고, `status` 의 호출 수에만 남깁니다.
 */
export const CLI_SESSION_CALL_USD = 0;

export class BudgetGuard {
  constructor(
    private readonly config: Config,
    private readonly store: StateStore,
  ) {}

  checkDaily(upcomingUsd: number): void {
    const spent = this.store.costOnDay(localDay());
    if (spent + upcomingUsd > this.config.dailyBudgetUsd + 1e-9) {
      throw new BudgetExceededError(
        `오늘 지출 $${spent.toFixed(2)} + 예상 $${upcomingUsd.toFixed(2)} > 일일 상한 $${this.config.dailyBudgetUsd.toFixed(2)}`,
        { hint: ".env DAILY_BUDGET_USD를 올리거나 내일 다시 실행하세요." },
      );
    }
  }

  checkEpisode(projectDir: string | null, upcomingUsd: number): void {
    if (!projectDir) return;
    const spent = this.store.projectCost(projectDir);
    if (spent + upcomingUsd > this.config.maxEpisodeUsd + 1e-9) {
      throw new BudgetExceededError(
        `이 에피소드 지출 $${spent.toFixed(2)} + 예상 $${upcomingUsd.toFixed(2)} > 상한 $${this.config.maxEpisodeUsd.toFixed(2)}`,
        { hint: projectDir },
      );
    }
  }

  checkImage(projectDir: string, upcomingUsd: number): void {
    const spent = this.store.projectStageCost(projectDir, "illustrate");
    if (spent + upcomingUsd > this.config.maxImageUsd + 1e-9) {
      throw new BudgetExceededError(
        `이미지 지출 $${spent.toFixed(2)} + 예상 $${upcomingUsd.toFixed(2)} > 이미지 상한 $${this.config.maxImageUsd.toFixed(2)}`,
        { hint: "이미지 수를 줄이거나 MAX_IMAGE_USD를 조정하세요." },
      );
    }
  }

  checkAll(projectDir: string | null, upcomingUsd: number, imageCall = false): void {
    this.checkDaily(upcomingUsd);
    this.checkEpisode(projectDir, upcomingUsd);
    if (imageCall && projectDir) this.checkImage(projectDir, upcomingUsd);
  }

  /** `billable=false`(CLI 세션)면 상한을 보지 않습니다 — 지출이 0이기 때문입니다. */
  checkLlm(projectDir: string | null, billable = true): void {
    if (!billable) return;
    this.checkAll(projectDir, LLM_CALL_RESERVE_USD);
  }

  record(input: { usd: number; provider: string; stage: string; projectDir?: string | null; note?: string }): void {
    if (!(input.usd > 0)) return;
    this.store.addCost(input);
  }

  recordLlm(provider: string, stage: string, projectDir: string | null, billable = true): number {
    if (!billable) {
      this.store.addCost({ usd: CLI_SESSION_CALL_USD, provider, stage, projectDir, note: "cli-session" });
      return CLI_SESSION_CALL_USD;
    }
    this.record({ usd: LLM_CALL_RESERVE_USD, provider, stage, projectDir });
    return LLM_CALL_RESERVE_USD;
  }

  statusLine(): string {
    const spent = this.store.costOnDay(localDay());
    return `오늘 $${spent.toFixed(2)}/$${this.config.dailyBudgetUsd.toFixed(2)} · 이미지 상한 $${this.config.maxImageUsd.toFixed(2)}/편`;
  }
}

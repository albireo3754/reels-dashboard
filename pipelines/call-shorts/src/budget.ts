import type { Config } from "./config.js";
import { BudgetExceededError } from "./errors.js";
import { localDay, type StateStore } from "./state.js";

// 토큰 실측 없이 호출 전에 예약하는 보수적 상한(USD). 실제 청구액과는 다를 수 있습니다.
export const LLM_CALL_RESERVE_USD = 0.03;

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

  checkLlm(projectDir: string | null): void {
    this.checkAll(projectDir, LLM_CALL_RESERVE_USD);
  }

  record(input: { usd: number; provider: string; stage: string; projectDir?: string | null; note?: string }): void {
    if (!(input.usd > 0)) return;
    this.store.addCost(input);
  }

  recordLlm(provider: string, stage: string, projectDir: string | null, note = ""): number {
    this.record({ usd: LLM_CALL_RESERVE_USD, provider, stage, projectDir, note });
    return LLM_CALL_RESERVE_USD;
  }

  statusLine(): string {
    const spent = this.store.costOnDay(localDay());
    return `오늘 $${spent.toFixed(2)}/$${this.config.dailyBudgetUsd.toFixed(2)} · 이미지 상한 $${this.config.maxImageUsd.toFixed(2)}/편`;
  }
}

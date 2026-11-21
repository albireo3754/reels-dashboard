/** 예산 가드 — 하루 / 한 편 / 이미지 상한을 넘으면 멈춥니다(가드레일 6). */

import type { Config } from "./config.js";
import { BudgetExceededError } from "./errors.js";
import type { StateStore } from "./state.js";
import { localDay } from "./state.js";

export const LLM_CALL_USD: Record<string, number> = { anthropic: 0.02, openai: 0.03 };

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

  record(input: { usd: number; provider: string; stage: string; projectDir?: string | null; note?: string }): void {
    if (!(input.usd > 0)) return;
    this.store.addCost(input);
  }

  recordLlm(provider: string, stage: string, projectDir: string | null, note = ""): number {
    const usd = LLM_CALL_USD[provider.split(":")[0]] ?? 0.03;
    this.record({ usd, provider, stage, projectDir, note });
    return usd;
  }

  statusLine(): string {
    const spent = this.store.costOnDay(localDay());
    return `오늘 $${spent.toFixed(2)}/$${this.config.dailyBudgetUsd.toFixed(2)} · 이미지 상한 $${this.config.maxImageUsd.toFixed(2)}/편`;
  }
}

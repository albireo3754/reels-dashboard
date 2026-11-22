export class PipelineError extends Error {
  readonly exitCode: number = 1;
  readonly status: string = "failed";
  readonly hint?: string;

  constructor(message: string, options: { hint?: string } = {}) {
    super(message);
    this.name = "PipelineError";
    this.hint = options.hint;
  }
}

export class ConfigError extends PipelineError {
  override readonly exitCode = 2;
  override readonly status = "failed";
}

/** 잘못된 인자값 — 저장하기 전에 멈추고 사용법을 알려 줍니다. */
export class UsageError extends PipelineError {
  override readonly exitCode = 2;
  override readonly status = "failed";
}

export class NeedsHumanError extends PipelineError {
  override readonly exitCode = 3;
  override readonly status = "needs_review";
  readonly action?: string;

  constructor(message: string, options: { hint?: string; action?: string } = {}) {
    super(message, options);
    this.name = "NeedsHumanError";
    this.action = options.action;
  }
}

export class BudgetExceededError extends PipelineError {
  override readonly exitCode = 4;
  override readonly status = "blocked";
}

export class TranscribeError extends PipelineError {
  override readonly status = "failed";
}

export class RenderError extends PipelineError {
  override readonly status = "failed";
}

export class ProviderError extends PipelineError {
  override readonly status = "failed";
}

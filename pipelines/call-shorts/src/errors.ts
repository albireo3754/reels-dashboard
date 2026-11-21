/** 파이프라인 예외 — '멈추고 보고' 세 경우를 타입으로 구분합니다. */

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

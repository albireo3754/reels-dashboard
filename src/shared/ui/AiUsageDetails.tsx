import type { AiObservation } from "../ai-observation";
import "./sdk-progress.css";
const number = (value: number | null | undefined) =>
  value == null ? "확인 불가" : value.toLocaleString();
const sum = (values: (number | null | undefined)[]) =>
  values.some((v) => v == null)
    ? null
    : values.reduce<number>((total, v) => total + (v ?? 0), 0);

/** 접힌 한 줄 요약(모델 · 토큰 · 비용). 펼치면 시도별 상세와 기록 근거. */
function usageSummary(observation: AiObservation): string {
  const attempts = observation.attempts;
  if (!attempts.length) return "기록 없음";
  const models = [...new Set(attempts.flatMap((a) => a.runtimeModels))];
  const input = sum(attempts.map((a) => a.usage?.input));
  const output = sum(attempts.map((a) => a.usage?.output));
  const estimated = attempts.filter((a) => a.cost.status === "estimated");
  const cost = attempts.every((a) => a.cost.status === "not-applicable")
    ? "API 비용 없음"
    : estimated.length === attempts.length
      ? `약 $${estimated.reduce((t, a) => t + (a.cost.usd ?? 0), 0).toFixed(4)}`
      : "비용 확인 불가";
  return [
    models.join(", ") || "모델 확인 불가",
    `입력 ${number(input)} · 출력 ${number(output)} 토큰`,
    cost,
    attempts.length > 1 ? `시도 ${attempts.length}회` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function AiUsageDetails({
  observation,
}: {
  observation: AiObservation;
}) {
  return (
    <details className="ai-usage" aria-label="모델·사용량·예상 비용">
      <summary>
        <span className="ai-usage-label">사용량</span>
        <span className="ai-usage-summary">{usageSummary(observation)}</span>
      </summary>
      {observation.attempts.map((attempt) => (
        <article key={attempt.id} className="ai-usage-attempt">
          <strong>
            시도 {attempt.ordinal} ·{" "}
            {attempt.auth === "api-key" ? "API 키" : "Codex 로그인"}
          </strong>
          <p>
            {attempt.agent} · {attempt.role} · {attempt.status}
            {attempt.durationMs !== null &&
              ` · ${(attempt.durationMs / 1000).toFixed(1)}초`}
          </p>
          <p>
            실행 모델: {attempt.runtimeModels.join(", ") || "확인 불가"}
            {attempt.runtimeReasoning && ` / 추론 ${attempt.runtimeReasoning}`}
          </p>
          <p>
            입력 {number(attempt.usage?.input)} · 출력{" "}
            {number(attempt.usage?.output)} 토큰
            <br />
            <small>
              입력 중 캐시 {number(attempt.usage?.cachedInput)} · 출력 중 추론{" "}
              {number(attempt.usage?.reasoningOutput)}
            </small>
          </p>
          <p>
            {attempt.cost.status === "not-applicable"
              ? "Codex 로그인 사용 · API 비용 산정 대상 아님"
              : attempt.cost.status === "estimated"
                ? `예상 API 비용 $${attempt.cost.usd!.toFixed(8)} (청구액 아님)`
                : "예상 API 비용: 확인 불가"}
          </p>
          <details>
            <summary>기록 근거</summary>
            <p>
              요청 모델: {attempt.requestedModel ?? "Codex 기본 설정"}
              <br />
              응답 모델: {attempt.responseModel ?? "미제공"}
              <br />
              모델 근거: {attempt.modelSource ?? "미수신"}
              <br />
              실행 버전: {attempt.runtimeVersion ?? "미수신"}
            </p>
            <p>
              지침 해시: {attempt.instructionHash}
              <br />
              스레드: {attempt.threadId ?? "미수신"}
              <br />
              Trace: {attempt.traceId ?? "없음"}
            </p>
            {attempt.cost.rateId && (
              <p>
                단가: {attempt.cost.rateId} · {attempt.cost.rateValidFrom} ~{" "}
                {attempt.cost.rateValidUntil}
                <br />
                {attempt.cost.rateSource}
                {attempt.cost.usdPerMillion && (
                  <>
                    <br />
                    USD/백만 토큰: 입력 {attempt.cost.usdPerMillion.input} ·
                    캐시 {attempt.cost.usdPerMillion.cachedInput} · 출력{" "}
                    {attempt.cost.usdPerMillion.output}
                  </>
                )}
              </p>
            )}
            {attempt.cost.reason && <p>비용 판정: {attempt.cost.reason}</p>}
            {attempt.warnings.length > 0 && (
              <p>관측 제한: {attempt.warnings.join(", ")}</p>
            )}
          </details>
        </article>
      ))}
    </details>
  );
}

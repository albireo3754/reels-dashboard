import type { SdkJob } from "../workflow";
import { AiUsageDetails } from "./AiUsageDetails";
import { ConversationFeed } from "./ConversationFeed";
import { Dot, type Tone } from "./primitives";
import "./sdk-progress.css";

const labels: Record<SdkJob["status"], string> = {
  running: "실행 중",
  completed: "완료",
  failed: "실패",
  cancelled: "중지됨",
  interrupted: "서버 재시작으로 중단됨",
};
const tones: Record<SdkJob["status"], Tone | "success"> = {
  running: "primary",
  completed: "neutral",
  failed: "danger",
  cancelled: "neutral",
  interrupted: "warning",
};

/** Codex 실행 상태 한 줄(상태 점 · 상태 · 인증 경로 · 중지) + 접힌 진행 기록·사용량. */
export function SdkProgress({
  job,
  onStop,
}: {
  job?: SdkJob;
  onStop: (id: string) => void;
}) {
  if (!job) return null;
  return (
    <section
      className="sdk-progress"
      aria-label="Codex 실행 상태"
      data-status={job.status}
    >
      <div className="sdk-progress-line">
        <Dot tone={tones[job.status]} />
        <strong>Codex · {labels[job.status]}</strong>
        <span className="sdk-progress-auth">
          {job.authModes
            .map((mode) => (mode === "api-key" ? "API 키" : "Codex 로그인"))
            .join(" → ") || "시작 준비 중"}
        </span>
        {job.status === "running" && (
          <button className="small" onClick={() => onStop(job.id)}>
            Codex 실행 중지
          </button>
        )}
      </div>
      {job.error && (
        <p role="alert" className="sdk-progress-error">
          {job.error}
        </p>
      )}
      <details className="sdk-progress-details">
        <summary>진행 기록</summary>
        <ConversationFeed
          label="Codex 진행 기록"
          messages={job.events.map((event, i) => ({
            id: `${job.id}:${i}`,
            sender: "codex",
            senderLabel: "Codex",
            avatar: "C",
            at: event.at,
            body: event.message,
          }))}
        />
      </details>
      {job.observation && <AiUsageDetails observation={job.observation} />}
      {!job.observation && job.usage && (
        <p className="sdk-progress-usage">
          입력 {job.usage.input_tokens} · 출력 {job.usage.output_tokens} 토큰
        </p>
      )}
    </section>
  );
}

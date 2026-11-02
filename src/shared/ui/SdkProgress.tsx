import type { SdkJob } from "../workflow";
import { AiUsageDetails } from "./AiUsageDetails";
import { ConversationFeed } from "./ConversationFeed";
export function SdkProgress({
  job,
  onStop,
}: {
  job?: SdkJob;
  onStop: (id: string) => void;
}) {
  if (!job) return null;
  const labels = {
    running: "실행 중",
    completed: "완료",
    failed: "실패",
    cancelled: "중지됨",
    interrupted: "서버 재시작으로 중단됨",
  };
  return (
    <section
      aria-label="Codex 실행 상태"
      style={{
        border: "1px solid #cbd9d1",
        borderRadius: 10,
        padding: 14,
        margin: "12px 0",
      }}
    >
      <strong>Codex · {labels[job.status]}</strong>
      <p>
        {job.authModes
          .map((mode) => (mode === "api-key" ? "API 키" : "Codex 로그인"))
          .join(" → ") || "시작 준비 중"}
      </p>
      {job.status === "running" && (
        <button onClick={() => onStop(job.id)}>Codex 실행 중지</button>
      )}
      {job.error && <p role="alert">{job.error}</p>}
      <details>
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
        <small>
          입력 {job.usage.input_tokens} · 출력 {job.usage.output_tokens} 토큰
        </small>
      )}
    </section>
  );
}

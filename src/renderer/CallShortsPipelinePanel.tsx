import { useEffect, useState } from "react";
import type { CallShortsPipelineBridge, CallShortsSnapshot, NotesRecordingStatus } from "../shared/call-shorts";

import { CallShortsReferences } from "./CallShortsReferences";

const statusLabels: Record<string, string> = {
  processing: "처리 중", done: "제작 완료", failed: "실패", needs_review: "검토 대기",
  blocked: "진행 차단", skipped: "건너뜀",
};
const notesLabels: Record<NotesRecordingStatus, string> = {
  waiting: "Mac 메모에 통화 녹음 폴더가 나타나기를 기다리고 있어요.",
  connected: "메모에 동기화된 통화 녹음을 자동으로 가져와요.",
  pending: "일부 녹음을 아직 가져올 수 없어요. 다음 확인 때 다시 시도해요.",
  denied: "Mac 시스템 설정 → 개인정보 보호 및 보안 → 자동화에서 Reels Dashboard의 메모 접근을 허용하세요.",
  error: "Mac 메모를 읽을 수 없어요. 메모가 열리는지 확인해 주세요.",
};

export function CallShortsPipelinePanel({ bridge }: { bridge: CallShortsPipelineBridge }) {
  const [snapshot, setSnapshot] = useState<CallShortsSnapshot>();
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let mounted = true;
    let timer: number;
    async function refresh() {
      setBusy(true);
      try {
        const result = await bridge.status();
        if (mounted) { setSnapshot(result); setError(""); }
      } catch {
        if (mounted) setError("쇼츠 입력 폴더 또는 처리 기록을 읽을 수 없어요.");
      } finally {
        if (mounted) {
          setBusy(false);
          timer = window.setTimeout(refresh, 60_000);
        }
      }
    }
    void refresh();
    return () => { mounted = false; window.clearTimeout(timer); };
  }, [bridge, attempt]);
  return <>
    <CallShortsReferences />
    <section className="pipeline-panel" aria-label="녹음 쇼츠 파이프라인">
    <h2>통화 녹음 → 유튜브 쇼츠</h2>
    <p>녹음 소스 · Apple 메모 › 통화 녹음</p>
    {snapshot && <>
      <p role="status">{notesLabels[snapshot.notes]}</p>
      <p>쇼츠 입력 폴더 · 녹음 {snapshot.inboxCount ?? 0}개</p>
      <details><summary>입력 폴더 위치</summary><p>{snapshot.inbox}</p></details>
      <h3>최근 처리 기록</h3>
      {snapshot.recent.length ? <ul>{snapshot.recent.map((file, index) =>
        <li key={index}>{file.name} · {statusLabels[file.status] ?? file.status}</li>)}</ul> : <p>아직 처리 기록이 없어요.</p>}
    </>}
    {error && <p role="alert">{error}</p>}
    <button type="button" className="secondary" onClick={() => setAttempt(n => n + 1)} disabled={busy}>{busy ? "확인 중…" : "현황 새로고침"}</button>
  </section></>;
}

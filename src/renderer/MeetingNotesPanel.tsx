import { useCallback, useEffect, useState } from "react";
import type { MeetingCredit, MeetingNotesBridge, MeetingResult } from "../shared/meeting-notes";
import "./meeting-notes.css";

const labels = { openai: "OpenAI", claude: "Claude", "codex-session": "Codex 세션" };
const providers = ["openai", "claude"] as const;
const money = (value: number) => new Intl.NumberFormat("ko-KR", { style: "currency", currency: "USD" }).format(value);

function CreditRing({ credit, provider }: { credit?: MeetingCredit; provider: MeetingCredit["provider"] }) {
  const total = credit?.totalUsd, remaining = credit?.remainingUsd;
  const percent = total && remaining !== undefined ? Math.max(0, Math.min(100, remaining / total * 100)) : null;
  const caption = percent === null ? "잔액 확인 안 됨" :
    `${credit?.status === "estimated" ? "로컬 추정" : "입력한 잔액"} · ${money(remaining!)} / ${money(total!)}`;
  return (
    <span className="meeting-credit" title={`${labels[provider]} · ${caption}${credit?.observedAt ? " · " + new Date(credit.observedAt).toLocaleString() : ""}`}>
      <svg viewBox="0 0 36 36" width="34" height="34" aria-hidden="true">
        <circle cx="18" cy="18" r="15" stroke="currentColor" opacity=".21" strokeWidth="3" fill="none" />
        {percent !== null && <circle cx="18" cy="18" r="15" pathLength="100" stroke="currentColor" strokeWidth="3"
          fill="none" strokeDasharray={`${percent} 100`} transform="rotate(-90 18 18)" />}
        <text x="18" y="21" textAnchor="middle">{percent === null ? "?" : Math.floor(percent)}</text>
      </svg>
      <span><strong>{labels[provider]}</strong><small>{caption}{!credit?.enabled && " · 호출 꺼짐"}</small></span>
    </span>
  );
}

export function useMeetingCredits(bridge?: MeetingNotesBridge) {
  const [credits, setCredits] = useState<MeetingCredit[]>([]);
  const load = useCallback(async () => {
    if (!bridge) return;
    try { setCredits(await bridge.credits()); } catch { setCredits([]); }
  }, [bridge]);
  useEffect(() => {
    if (!bridge) return;
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [bridge, load]);
  return { credits, load };
}

export function SidebarCredits({ credits }: { credits: MeetingCredit[] }) {
  return <section className="sidebar-credits" aria-label="API 크레딧 잔액">
    {providers.map(provider => <CreditRing key={provider} provider={provider} credit={credits.find(item => item.provider === provider)} />)}
  </section>;
}

export function MeetingNotesPanel({ bridge, credits, load }: { bridge: MeetingNotesBridge } & ReturnType<typeof useMeetingCredits>) {
  const [context, setContext] = useState("");
  const [transcript, setTranscript] = useState("");
  const [result, setResult] = useState<MeetingResult>();
  const [consent, setConsent] = useState(false);
  const [allowCodexSession, setAllowCodexSession] = useState(false);
  const [busy, setBusy] = useState<"audio" | "text" | null>(null);
  const [error, setError] = useState("");
  async function run(kind: "audio" | "text") {
    if (busy || !consent) return;
    setBusy(kind);
    setError("");
    try {
      if (kind === "audio") {
        const response = await bridge.transcribe(context);
        if (response) { setTranscript(response.text); setResult(undefined); }
      } else {
        setResult(undefined);
        setResult(await bridge.summarize({ context, transcript, allowCodexSession }));
      }
    } catch (e) {
      setError((e instanceof Error ? e.message : "처리에 실패했어요.").replace(/^Error invoking remote method '[^']+': Error: /, ""));
    } finally { setBusy(null); await load(); }
  }
  const openaiEnabled = credits.some(item => item.provider === "openai" && item.enabled);
  const notesEnabled = credits.some(item => item.enabled) || allowCodexSession;
  return (
    <details className="meeting-panel">
      <summary>
        <span className="meeting-panel-title">전사·회의록</span>
      </summary>
      <div className="meeting-panel-body">
        <p>음성은 OpenAI로만 전사해요. 기록은 OpenAI → Claude 순서로 시도하며, 잔액이 확인되지 않거나 10% 선을 넘을 요청은 건너뛰어요.</p>
        <label>회의 맥락·용어 <input value={context} maxLength={4000} onChange={event => setContext(event.target.value)} disabled={!!busy} /></label>
        <label>전사 원문 <textarea value={transcript} rows={5} placeholder="전사된 텍스트를 붙여넣거나 음성 파일을 선택하세요" onChange={event => setTranscript(event.target.value)} disabled={!!busy} /></label>
        {transcript.length > 48_000 && <p role="status">요약하려면 전사 원문을 48,000자 이하로 나눠주세요.</p>}
        <label className="meeting-check"><input type="checkbox" checked={consent} disabled={!!busy} onChange={event => setConsent(event.target.checked)} />
          선택한 음성 또는 입력한 텍스트를 해당 AI 제공자에게 보내는 데 동의해요.
        </label>
        <label className="meeting-check"><input type="checkbox" checked={allowCodexSession} disabled={!!busy} onChange={event => setAllowCodexSession(event.target.checked)} />
          API로 회의록을 만들 수 없으면 기존 Codex 구독 세션 사용
        </label>
        <div className="meeting-actions">
          <button type="button" className="secondary" disabled={!!busy || !consent || !openaiEnabled} onClick={() => void run("audio")}>음성 선택·전사</button>
          <button type="button" className="primary" disabled={!!busy || !consent || !notesEnabled || !transcript.trim() || transcript.length > 48_000} onClick={() => void run("text")}>회의록 만들기</button>
          <button type="button" className="secondary" disabled={!!busy} onClick={() => void load()}>잔액 표시 새로고침</button>
        </div>
        {busy && <p role="status">{busy === "audio" ? "음성 파일 전사 중…" : "회의록 작성 중…"}</p>}
        {error && <p role="alert">{error}</p>}
        {result && <label>회의록 · {labels[result.provider]}<textarea readOnly rows={9} value={result.text} /></label>}
      </div>
    </details>
  );
}

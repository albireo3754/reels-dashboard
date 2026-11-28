import { useState } from "react";
import { callNotesPrefix, type CallNoteRecording, type CallNotesTranscription, type RecentCallNotesBridge } from "../shared/call-shorts";
import "./call-shorts-notes.css";

const displayDate = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Seoul" });

export function CallShortsPanel({ bridge }: { bridge: RecentCallNotesBridge }) {
  const [prefix, setPrefix] = useState(callNotesPrefix);
  const [items, setItems] = useState<CallNoteRecording[] | undefined>();
  const [results, setResults] = useState<CallNotesTranscription[]>([]);
  const [working, setWorking] = useState<"" | "preview" | "transcribe">("");
  const [error, setError] = useState("");
  async function run(work: "preview" | "transcribe") {
    if (working) return;
    setWorking(work);
    setError("");
    try {
      if (work === "preview") { setItems(undefined); setItems(await bridge.preview(prefix)); }
      else if (items?.length) { setResults([]); setResults(await bridge.transcribe({ prefix, ids: items.map(item => item.id) })); }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': Error: /, "")
        : "작업을 완료하지 못했어요. Mac의 메모와 로컬 전사 환경을 확인해 주세요.");
    } finally { setWorking(""); }
  }
  return (
    <section className="call-notes-panel" aria-labelledby="call-notes-title">
      <h2 id="call-notes-title">메모에서 가져오기</h2>
      <p>이 Mac에 이미 동기화된 통화 중 제목이 아래 문구로 시작하는 최근 최대 2개만 확인해요. 원본은 수정하지 않고 전사는 이 Mac에서만 처리해요.</p>
      <label>메모 제목 접두사
        <input value={prefix} placeholder="Call with " maxLength={80} disabled={!!working} onChange={event => {
          setPrefix(event.target.value); setItems(undefined); setResults([]); setError("");
        }} />
      </label>
      <div className="call-notes-actions">
        <button className="secondary" type="button" disabled={!!working || !prefix.startsWith(callNotesPrefix)}
          onClick={() => void run("preview")}>최근 녹음 확인</button>
        <button className="primary" type="button" disabled={!!working || !items?.length || items.some(item => !item.available)}
          onClick={() => void run("transcribe")}>이 녹음 가져와 전사</button>
      </div>
      {working && <p role="status">{working === "preview" ? "로컬 메모를 확인하고 있어요…" : "선택한 녹음을 이 Mac에서 전사하고 있어요…"}</p>}
      {!!items && (items.length
        ? <ol aria-label="확인한 최근 녹음">{items.map(item => <li key={item.id}>
            {displayDate.format(new Date(item.createdAt))} (한국 시간) · {item.available ? "가져올 수 있음" : "Mac 다운로드 대기"}
          </li>)}</ol>
        : <p>일치하는 녹음을 이 Mac의 메모에서 찾지 못했어요.</p>)}
      {error && <p role="alert">{error}</p>}
      {results.length > 0 && <>
        <p role="status">{results.length}개 전사가 완료됐어요. 시간 정보가 있는 TXT와 SRT를 로컬에 저장했어요. 화자는 지정하지 않았어요.</p>
        <ul>{results.map(result => <li key={result.name}>{result.name} · TXT / SRT</li>)}</ul>
        <button className="secondary" type="button" onClick={() => void bridge.reveal().catch(() => setError("로컬 전사 폴더를 열 수 없어요."))}>Finder에서 전사 폴더 열기</button>
      </>}
    </section>
  );
}

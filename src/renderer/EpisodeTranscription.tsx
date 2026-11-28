import { useState } from "react";
import type { Project } from "../shared/contracts";
import { isEpisodeVideo, type EpisodeTranscriptionBridge } from "../shared/episode-transcription";

export function EpisodeTranscription({ project, bridge }: { project: Project; bridge: EpisodeTranscriptionBridge }) {
  const sources = project.resources?.filter(r => r.role === "footage" && isEpisodeVideo(r.path)) ?? [];
  const [choice, setChoice] = useState<string>();
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const selected = choice === "" || sources.some(r => r.path === choice) ? choice : sources[0]?.path;
  async function run() {
    setWorking(true);
    setMessage("");
    try {
      const result = await bridge.run(project.id, selected || undefined);
      if (result) setMessage(`${result.reused ? "기존 전사를 연결했어요" : "전사를 마쳤어요"}. 대본과 단어 시각은 연결 자료에서 열 수 있어요.\n${result.directory}`);
    } catch (e) {
      setMessage((e instanceof Error ? e.message : "전사를 완료하지 못했어요.").replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    } finally { setWorking(false); }
  }
  return <div className="episode-transcription">
    {sources.length > 0 && <select aria-label="전사할 원본" value={selected ?? ""} disabled={working} onChange={e => setChoice(e.target.value)}>
      {sources.map(r => <option key={r.path} value={r.path}>{r.label} · {r.path.split("/").pop()}</option>)}
      <option value="">다른 원본 선택…</option>
    </select>}
    <button type="button" className="small" onClick={() => void run()} disabled={working}>
      {working ? "원본 전사 중…" : "원본 전사"}
    </button>
    {message && <small role="status">{message}</small>}
  </div>;
}

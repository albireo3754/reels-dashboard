import { useEffect, useRef, useState } from "react";
import type { CaptionCue } from "../../../shared/editor";
import {
  MAX_SUBTITLE_BYTES,
  parseSubtitleFile,
  serializeSrt,
  type SubtitleImport,
} from "../model/subtitles";
import "./subtitle-files.css";
interface Props {
  cues: CaptionCue[];
  duration: number;
  sourceName: string;
  contextKey: string;
  disabled: boolean;
  onReplace: (cues: CaptionCue[]) => void;
}
export function CaptionFileTools({
  cues,
  duration,
  sourceName,
  contextKey,
  disabled,
  onReplace,
}: Props) {
  const input = useRef<HTMLInputElement>(null);
  const context = useRef(contextKey);
  context.current = contextKey;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const generation = useRef(0);
  const [pending, setPending] = useState<{
    fileName: string;
    data: SubtitleImport;
    contextKey: string;
  } | null>(null);
  const [confirmed, setConfirmed] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [reading, setReading] = useState(false);
  useEffect(() => {
    generation.current++;
    setPending(null);
    setConfirmed(false);
    setError("");
    setReading(false);
  }, [contextKey]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  async function choose(file: File) {
    const current = ++generation.current,
      expected = context.current;
    setReading(true);
    setError("");
    setNotice("");
    setPending(null);
    setConfirmed(false);
    try {
      if (file.size > MAX_SUBTITLE_BYTES)
        throw new Error("자막 파일은 1MB 이하여야 해요.");
      const bytes = await file.arrayBuffer();
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("UTF-8 형식으로 저장한 자막 파일을 선택해주세요.");
      }
      const data = parseSubtitleFile(text, file.name, duration);
      if (
        current !== generation.current ||
        context.current !== expected ||
        disabledRef.current
      )
        return;
      setPending({ fileName: file.name, data, contextKey: expected });
    } catch (e) {
      if (current === generation.current)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (current === generation.current) setReading(false);
    }
  }
  function apply() {
    if (
      disabled ||
      !pending ||
      pending.contextKey !== contextKey ||
      (cues.length > 0 && !confirmed)
    )
      return;
    const count = pending.data.cues.length;
    onReplace(pending.data.cues);
    setPending(null);
    setConfirmed(false);
    setNotice(
      `${count}개 자막을 가져왔어요. 편집 설정 저장으로 보관할 수 있어요.`,
    );
  }
  function download() {
    try {
      const text = serializeSrt(cues, duration);
      const url = URL.createObjectURL(
        new Blob([text], { type: "application/x-subrip;charset=utf-8" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download =
        (sourceName.replace(/\.[^.]+$/, "") || "captions").replace(
          /[\\/<>:"|?*]/g,
          "_",
        ) + ".srt";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setError("");
      setNotice("현재 자막의 문구와 시간을 SRT로 저장했어요.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <section className="subtitle-file-tools" aria-label="자막 파일 도구">
      <div className="button-row">
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={disabled || reading}
        >
          SRT/VTT 가져오기
        </button>
        <button
          type="button"
          onClick={download}
          disabled={disabled || !cues.length}
        >
          SRT 저장
        </button>
      </div>
      <input
        ref={input}
        className="subtitle-file-input"
        aria-label="SRT/VTT 파일 선택"
        type="file"
        accept=".srt,.vtt"
        disabled={disabled || reading}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void choose(file);
        }}
      />
      <p className="muted compact">
        문구와 시간만 가져오며 현재 자막 크기·위치는 유지해요. UTF-8 평문 자막을
        지원해요.
      </p>
      {reading && <p role="status">자막 파일을 확인하고 있어요.</p>}
      {error && (
        <p className="subtitle-file-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {pending && (
        <div
          className="subtitle-import-review"
          role="region"
          aria-label="가져올 자막 검토"
        >
          <strong>
            {pending.fileName} · {pending.data.cues.length}개 자막
          </strong>
          {pending.data.ignoredNotes > 0 && (
            <p>
              VTT 주석 {pending.data.ignoredNotes}개는 자막에 포함하지 않아요.
            </p>
          )}
          <ol>
            {pending.data.cues.map((cue) => (
              <li key={cue.id}>
                <small>
                  {cue.start.toFixed(3)}–{cue.end.toFixed(3)}초
                </small>
                <p>{cue.text}</p>
              </li>
            ))}
          </ol>
          {cues.length > 0 && (
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                disabled={disabled}
              />
              기존 자막 {cues.length}개를 이 파일의 자막으로 바꿔요
            </label>
          )}
          <div className="button-row">
            <button
              type="button"
              onClick={apply}
              disabled={disabled || (cues.length > 0 && !confirmed)}
            >
              검토한 자막 적용
            </button>
            <button type="button" onClick={() => setPending(null)}>
              가져오기 취소
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

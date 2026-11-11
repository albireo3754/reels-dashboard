import { errorMessage } from "../../../shared/lib/errors";
import { useEffect, useRef, useState } from "react";
import type { CaptionCue } from "../../../shared/editor";
import {
  MAX_SUBTITLE_BYTES,
  parseSubtitleFile,
  serializeSrt,
  type SubtitleImport,
} from "../model/subtitles";
import { Button, Notice, StatusText } from "../../../shared/ui/primitives";
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
      if (current === generation.current) setError(errorMessage(e));
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
      setError(errorMessage(e));
    }
  }
  return (
    <section className="subtitle-file-tools" aria-label="자막 파일 도구">
      <div className="subtitle-file-line">
        <Button
          size="small"
          onClick={() => input.current?.click()}
          disabled={disabled || reading}
          title="문구와 시간만 가져오며 현재 자막 크기·위치는 유지해요. UTF-8 평문 자막을 지원해요."
        >
          SRT/VTT 가져오기
        </Button>
        <Button
          size="small"
          onClick={download}
          disabled={disabled || !cues.length}
          title="현재 자막의 문구와 시간을 SRT 파일로 저장해요."
        >
          SRT 저장
        </Button>
        {reading && (
          <StatusText live busy>
            자막 파일 확인 중…
          </StatusText>
        )}
        {!reading && notice && <StatusText live>{notice}</StatusText>}
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
      {error && <Notice tone="danger">{error}</Notice>}
      {pending && (
        <div
          className="subtitle-import-review"
          role="region"
          aria-label="가져올 자막 검토"
        >
          <p className="subtitle-import-title">
            <strong>{pending.fileName}</strong>
            <span className="ui-meta">
              {pending.data.cues.length}개 자막
              {pending.data.ignoredNotes > 0 &&
                ` · VTT 주석 ${pending.data.ignoredNotes}개는 자막에 포함하지 않아요.`}
            </span>
          </p>
          <ol>
            {pending.data.cues.map((cue) => (
              <li key={cue.id}>
                <span className="ui-meta">
                  {cue.start.toFixed(3)}–{cue.end.toFixed(3)}초
                </span>
                <p>{cue.text}</p>
              </li>
            ))}
          </ol>
          {cues.length > 0 && (
            <label className="ui-check">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                disabled={disabled}
              />
              기존 자막 {cues.length}개를 이 파일의 자막으로 바꿔요
            </label>
          )}
          <div className="subtitle-import-actions">
            <Button size="small" onClick={() => setPending(null)}>
              가져오기 취소
            </Button>
            <Button
              size="small"
              variant="secondary"
              onClick={apply}
              disabled={disabled || (cues.length > 0 && !confirmed)}
            >
              검토한 자막 적용
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

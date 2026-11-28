import { useState } from "react";
import { blogScheduledAt, type BlogPublishChoice, type BlogPublishLaunch } from "../../../shared/blog-publication";
import { errorMessage } from "../../../shared/lib/errors";
import { Button, Dialog, Notice, Segmented } from "../../../shared/ui/primitives";

export function BlogPublishDialog({ title, onClose, onPublish }: {
  title: string;
  onClose: () => void;
  onPublish: (choice: BlogPublishChoice) => Promise<BlogPublishLaunch>;
}) {
  const [mode, setMode] = useState<BlogPublishChoice["mode"]>("now");
  const [dateTime, setDateTime] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [launched, setLaunched] = useState<BlogPublishLaunch>();

  async function submit() {
    if (pending || launched) return;
    const scheduledAt = blogScheduledAt(dateTime);
    if (mode === "scheduled" && (!scheduledAt || Date.parse(scheduledAt) <= Date.now())) {
      setError("한국 시간 기준으로 앞으로의 날짜와 시간을 선택해주세요.");
      return;
    }
    setError("");
    setPending(true);
    try {
      setLaunched(await onPublish(mode === "scheduled" && scheduledAt ? { mode, scheduledAt } : { mode: "now" }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open title="네이버 블로그 발행" aria-label="네이버 블로그 발행"
      onClose={() => { if (!pending) onClose(); }} closeOnBackdrop={!pending}
      footer={launched ? <Button variant="primary" onClick={onClose}>닫기</Button> : <>
        <Button disabled={pending} onClick={onClose}>취소</Button>
        <Button variant="primary" type="submit" form="ce-publish-form" disabled={pending}>
          {pending ? "Herdr 여는 중…" : mode === "scheduled" ? "예약 발행 요청" : "즉시 발행 요청"}
        </Button>
      </>}>
      <form id="ce-publish-form" className="ce-publish-form" aria-busy={pending}
        onKeyDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <strong>{title || "제목 없는 글"}</strong>
        {launched ? <p role="status">Herdr의 <strong>{launched.spaceName}</strong>에서 진행 상태와 결과를 확인할 수 있어요. 터미널 {launched.terminal}</p> : <>
          <Segmented label="발행 방식" value={mode} onChange={(next) => { setMode(next); setError(""); }}
            items={[{ value: "now", label: "즉시 발행", disabled: pending }, { value: "scheduled", label: "예약 발행", disabled: pending }]} />
          {mode === "scheduled" && <label>
            발행 날짜·시간 (한국 시간)
            <input type="datetime-local" value={dateTime} disabled={pending} required
              onChange={(e) => { setDateTime(e.target.value); setError(""); }} />
          </label>}
          <p className="ui-meta">{mode === "scheduled"
            ? "지정한 시각에 예약할 수 없으면 Herdr에 이유를 남겨요."
            : "Herdr에서 작업을 열고 Aside로 네이버에 발행해요."}</p>
          {error && <Notice tone="danger">{error}</Notice>}
        </>}
      </form>
    </Dialog>
  );
}

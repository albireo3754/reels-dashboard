import { useEffect, useId, useRef, useState } from 'react';
import { workPrompt } from '../../../shared/workbench';
import { blogTerminalTask } from '../model/terminal-context';

export function BlogTerminal({ context, onStart, onOpen }: {
  context: string;
  onStart: (task: string) => Promise<void>;
  onOpen: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const requestId = useId();
  const pending = useRef(false);
  const [request, setRequest] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const task = blogTerminalTask(context, request);
  const valid = !!request.trim() && task.length <= 16000;
  useEffect(() => { setNotice(''); }, [context, request]);
  return <>
    <button onClick={onOpen}>터미널 열기</button>
    <button onClick={() => { setError(''); setNotice(''); dialog.current?.showModal(); }}>맥락과 함께 수정</button>
    <dialog ref={dialog} className="blog-terminal-dialog" aria-label="블로그 화면 수정" onCancel={event => { if (pending.current) event.preventDefault(); }}>
      <form onSubmit={async event => {
        event.preventDefault();
        if (pending.current || !valid) return;
        pending.current = true; setBusy(true); setError(''); setNotice('');
        try { await onStart(task); dialog.current?.close(); setRequest(''); }
        catch (error) { setError(String(error)); }
        finally { pending.current = false; setBusy(false); }
      }}>
        <h3>블로그 화면 수정</h3>
        <p>열린 탭의 맥락과 요청을 새 Codex 터미널에 전달해 앱 화면을 수정해요. 기존 대화에서 이어가려면 프롬프트를 복사해 붙여 넣으세요.</p>
        <label htmlFor={requestId}>수정 요청</label>
        <textarea id={requestId} autoFocus value={request} maxLength={8000} disabled={busy} onChange={event => setRequest(event.target.value)} aria-describedby={`${requestId}-keys`} onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.altKey ||
              event.ctrlKey || event.metaKey || event.nativeEvent.isComposing ||
              event.keyCode === 229) return;
          event.preventDefault();
          if (!event.repeat && !pending.current && valid) event.currentTarget.form?.requestSubmit();
        }} placeholder="이 화면에서 바꾸고 싶은 내용을 적어주세요." />
        <p id={`${requestId}-keys`}>Enter로 맥락을 넣어 Codex 열기 · Shift+Enter로 줄바꿈</p>
        <details><summary>전달할 맥락과 요청</summary><pre>{workPrompt('implement', task)}</pre></details>
        {task.length > 16000 && <p role="alert">맥락과 요청은 16,000자 이하여야 해요.</p>}
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        <button type="submit" disabled={busy || !valid}>{busy ? '여는 중…' : '맥락을 넣어 Codex 열기'}</button>
        <button type="button" disabled={busy || !valid} onClick={async () => {
          setError(''); setNotice('');
          try { await navigator.clipboard.writeText(workPrompt('implement', task)); setNotice('맥락과 요청을 복사했어요. 이어갈 세션에 붙여 넣으세요.'); }
          catch (error) { setError(`복사하지 못했어요: ${String(error)}`); }
        }}>현재 세션용 프롬프트 복사</button>
        <button type="button" disabled={busy} onClick={() => dialog.current?.close()}>닫기</button>
      </form>
    </dialog>
  </>;
}

import { useEffect, useId, useRef, useState } from 'react';
import { saveAgentPermission, savedAgentPermission, workPrompt, type AgentPermission } from '../../../shared/workbench';
import { Button, Dialog, Notice, StatusText } from '../../../shared/ui/primitives';
import { blogTerminalTask } from '../model/terminal-context';

/**
 * '맥락과 함께 수정': 현재 탭의 맥락과 요청으로 새 Codex 세션을 연다(개발 모드 전용).
 * 터미널 패널 자체는 상단 툴바의 터미널 버튼·⌘N으로 연다.
 */
export function BlogTerminal({ context, onStart }: {
  context: string;
  onStart: (task: string, permission: AgentPermission) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const formId = useId();
  const requestId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pending = useRef(false);
  const [request, setRequest] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [permission, setPermission] = useState<AgentPermission>(savedAgentPermission);
  const task = blogTerminalTask(context, request);
  const valid = !!request.trim() && task.length <= 16000;
  useEffect(() => { setNotice(''); }, [context, request]);
  // Dialog(자식)의 showModal 뒤에 실행되므로 요청 입력란으로 포커스를 옮길 수 있다.
  useEffect(() => { if (open) textarea.current?.focus(); }, [open]);
  // 실행 중에는 Esc·닫기·backdrop으로 닫지 않는다.
  const close = () => { if (!pending.current) setOpen(false); };
  return <>
    <Button onClick={() => { setError(''); setNotice(''); setOpen(true); }}>맥락과 함께 수정</Button>
    <Dialog
      open={open}
      onClose={close}
      title="블로그 화면 수정"
      aria-label="블로그 화면 수정"
      className="blog-terminal-dialog"
      footer={<>
        {notice && <StatusText live>{notice}</StatusText>}
        <Button disabled={busy || !valid} onClick={async () => {
          setError(''); setNotice('');
          try { await navigator.clipboard.writeText(workPrompt('implement', task)); setNotice('맥락과 요청을 복사했어요. 이어갈 세션에 붙여 넣으세요.'); }
          catch (error) { setError(`복사하지 못했어요: ${String(error)}`); }
        }}>현재 세션용 프롬프트 복사</Button>
        <Button variant="primary" type="submit" form={formId} disabled={busy || !valid}>{busy ? '여는 중…' : '맥락을 넣어 Codex 열기'}</Button>
      </>}
    >
      <form id={formId} onSubmit={async event => {
        event.preventDefault();
        if (pending.current || !valid) return;
        pending.current = true; setBusy(true); setError(''); setNotice('');
        try { await onStart(task, permission); setOpen(false); setRequest(''); }
        catch (error) { setError(String(error)); }
        finally { pending.current = false; setBusy(false); }
      }}>
        <p className="ui-meta blog-terminal-lead" id={`${requestId}-keys`}>열린 탭의 맥락과 요청으로 새 Codex 터미널을 열어요 · Enter 열기 · Shift+Enter 줄바꿈</p>
        <label htmlFor={requestId}>수정 요청</label>
        <textarea id={requestId} ref={textarea} value={request} maxLength={8000} disabled={busy} onChange={event => setRequest(event.target.value)} aria-describedby={`${requestId}-keys`} onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.altKey ||
              event.ctrlKey || event.metaKey || event.nativeEvent.isComposing ||
              event.keyCode === 229) return;
          event.preventDefault();
          if (!event.repeat && !pending.current && valid) event.currentTarget.form?.requestSubmit();
        }} placeholder="이 화면에서 바꾸고 싶은 내용을 적어주세요." />
        <label className="blog-terminal-permission">
          <input type="checkbox" checked={permission === 'bypass'} disabled={busy} onChange={event => {
            const next: AgentPermission = event.target.checked ? 'bypass' : 'ask';
            setPermission(next); saveAgentPermission(next);
          }} />
          승인 없이 실행 (YOLO) <span className="ui-meta">샌드박스와 승인 요청 없이 Codex가 바로 수정·실행해요</span>
        </label>
        <details><summary>전달할 맥락과 요청</summary><pre>{workPrompt('implement', task)}</pre></details>
        {task.length > 16000 && <Notice tone="danger">맥락과 요청은 16,000자 이하여야 해요.</Notice>}
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    </Dialog>
  </>;
}

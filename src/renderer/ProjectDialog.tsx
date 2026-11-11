import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { Project, Stage } from "../shared/contracts";
import { stageLabels } from "./pages";
import { Icon } from "./ui";

/**
 * Content record form. A native modal <dialog> provides the focus trap, inert
 * background and Escape handling; Escape and backdrop clicks are ignored while
 * a save is in progress so the form cannot vanish mid-request.
 */
export function ProjectDialog({
  project,
  onChange,
  onCancel,
  onSave,
  busy,
  error,
  children,
}: {
  project: Project;
  onChange: (project: Project) => void;
  onCancel: () => void;
  onSave: () => void;
  busy: boolean;
  error?: string;
  children?: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (!element.open) element.showModal();
    title.current?.focus();
    return () => {
      element.close();
      // Return focus to whatever opened the form (a card, toolbar search result or "새 콘텐츠").
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  const set = <K extends keyof Project>(key: K, value: Project[K]) =>
    onChange({ ...project, [key]: value });
  return (
    <dialog
      ref={dialog}
      className="ui-dialog project-dialog"
      aria-labelledby="project-title"
      data-modal-form=""
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onClick={(event) => {
        if (event.target === dialog.current && !busy) onCancel();
      }}
    >
      <form
        className="project-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) onSave();
        }}
      >
        <header className="ui-dialog-header">
          <h2 id="project-title">콘텐츠 기록</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="콘텐츠 기록 닫기"
            title="닫기 (Esc)"
            onClick={onCancel}
            disabled={busy}
          >
            <Icon name="close" />
          </button>
        </header>
        <div className="ui-dialog-body">
          <label>
            콘텐츠 제목
            <input
              ref={title}
              value={project.title}
              onChange={(e) => set("title", e.target.value)}
              disabled={busy}
            />
          </label>
          {error && (
            <p className="ui-notice" data-tone="danger" role="alert">
              {error}
            </p>
          )}
          <div className="form-grid">
            <label>
              콘텐츠 날짜
              <input
                type="date"
                value={project.date}
                onChange={(e) => set("date", e.target.value)}
                disabled={busy}
              />
            </label>
            <label>
              진행 단계
              <select
                value={project.stage}
                onChange={(e) => set("stage", e.target.value as Stage)}
                disabled={busy}
              >
                {Object.entries(stageLabels).map(([key, name]) => (
                  <option value={key} key={key}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            다음 할 일
            <textarea
              value={project.nextAction}
              onChange={(e) => set("nextAction", e.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            게시 링크
            <input
              type="url"
              value={project.publicURL}
              onChange={(e) => set("publicURL", e.target.value)}
              placeholder="https://"
              disabled={busy}
            />
          </label>
          <label
            className="ui-check project-share"
            title="공유를 켠 콘텐츠의 요약만 내보내기와 Sites 동기화에 포함돼요."
          >
            <input
              type="checkbox"
              checked={project.shared}
              onChange={(e) => set("shared", e.target.checked)}
              disabled={busy}
            />
            모바일에 공유
          </label>
          {children}
        </div>
        <footer className="ui-dialog-footer">
          <button type="button" onClick={onCancel} disabled={busy}>
            취소
          </button>
          <button type="submit" className="primary" disabled={busy}>
            저장
          </button>
        </footer>
      </form>
    </dialog>
  );
}

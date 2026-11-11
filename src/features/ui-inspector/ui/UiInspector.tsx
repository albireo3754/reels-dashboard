import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatKey } from "../../../shared/keymap";
import {
  ShortcutHint,
  useKeymap,
  useShortcut,
} from "../../../shared/ui/shortcuts";
import {
  feedbackPrompt,
  inspectTarget,
  type InspectionTarget,
} from "../model/inspect";
import { CloseIcon } from "../../../shared/ui/primitives";
import "./inspector.css";

export function UiInspector({
  onClose,
  onFeedback,
}: {
  onClose: () => void;
  onFeedback: (text: string) => void;
}) {
  const [hovered, setHovered] = useState<Element | null>(null);
  const [bounds, setBounds] = useState<DOMRect | null>(null);
  const [selected, setSelected] = useState<InspectionTarget | null>(null);
  const [comment, setComment] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const exitButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(document.activeElement);
  // One inspect session = one mount. Escape can reach both the exitInspect
  // shortcut and the modal dialog's cancel event, so close at most once.
  const closed = useRef(false);
  const close = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    onClose();
  }, [onClose]);
  // The submit handler is synchronous; this marks a sent comment until the
  // cleared value commits, so a second Enter in the same tick is ignored.
  const submitting = useRef(false);
  useLayoutEffect(() => {
    submitting.current = false;
  }, [comment]);
  // Mounted only while inspecting, so registration is the liveness. The
  // provider's capture listener runs before the document listeners below and
  // stops propagation, which keeps App and editor Escape handlers from firing.
  useShortcut("exitInspect", close);
  const exitKey = formatKey(useKeymap().exitInspect[0]);
  useEffect(() => {
    document.documentElement.classList.add("reels-inspecting");
    return () => document.documentElement.classList.remove("reels-inspecting");
  }, []);
  useEffect(() => {
    // Native shortcuts also arrive while a preview iframe owns keyboard focus.
    // Bring Escape and activation keys back to this document for inspection.
    exitButton.current?.focus();
    return () => {
      const element = restoreFocus.current;
      if (element instanceof HTMLElement && element.isConnected)
        element.focus();
    };
  }, []);
  useEffect(() => {
    if (!hovered || selected) {
      setBounds(null);
      return;
    }
    const refresh = () =>
      setBounds(hovered.isConnected ? hovered.getBoundingClientRect() : null);
    refresh();
    window.addEventListener("resize", refresh);
    window.addEventListener("scroll", refresh, true);
    return () => {
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", refresh, true);
    };
  }, [hovered, selected]);
  useEffect(() => {
    if (selected) dialog.current?.showModal();
  }, [selected]);
  useEffect(() => {
    const own = (target: EventTarget | null) =>
      target instanceof Element &&
      Boolean(target.closest('[data-ui-inspector], [aria-label="화면 검사"]'));
    const move = (event: PointerEvent) => {
      if (!selected)
        setHovered(
          event.target instanceof Element && !own(event.target)
            ? event.target
            : null,
        );
    };
    const suppress = (event: Event) => {
      if (own(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const choose = (event: MouseEvent) => {
      if (own(event.target)) return;
      suppress(event);
      if (!selected && event.target instanceof Element)
        setSelected(inspectTarget(event.target));
    };
    const key = (event: KeyboardEvent) => {
      if (!own(event.target) && (event.key === "Enter" || event.key === " "))
        suppress(event);
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerdown", suppress, true);
    document.addEventListener("mousedown", suppress, true);
    document.addEventListener("click", choose, true);
    document.addEventListener("dblclick", suppress, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerdown", suppress, true);
      document.removeEventListener("mousedown", suppress, true);
      document.removeEventListener("click", choose, true);
      document.removeEventListener("dblclick", suppress, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [selected]);
  return (
    <>
      {!selected && (
        <div className="ui-inspector-banner" data-ui-inspector role="status">
          <span>수정할 화면 요소를 선택하세요.</span>
          <button ref={exitButton} className="small" onClick={close}>
            검사 끝내기 · {exitKey}
            <ShortcutHint action="exitInspect" className="end" />
          </button>
        </div>
      )}
      {bounds && (
        <div
          aria-hidden="true"
          className="ui-inspector-outline"
          style={{
            left: bounds.left,
            top: bounds.top,
            width: bounds.width,
            height: bounds.height,
          }}
        />
      )}
      <dialog
        ref={dialog}
        className="ui-dialog ui-inspector-dialog"
        data-ui-inspector
        aria-labelledby="ui-inspector-title"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
      >
        <form
          className="ui-inspector-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (submitting.current || !selected || !comment.trim()) return;
            submitting.current = true;
            onFeedback(feedbackPrompt(selected, comment));
            setComment("");
          }}
        >
          <header className="ui-dialog-header">
            <h2 id="ui-inspector-title">화면 수정 요청</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="화면 검사 닫기"
              title="닫기"
              onClick={close}
            >
              <CloseIcon />
            </button>
          </header>
          <div className="ui-dialog-body">
            <p className="ui-meta">
              선택한 요소 <code>&lt;{selected?.tag}&gt;</code>
            </p>
            <ul
              className="ui-inspector-sources"
              aria-label="선택 요소 코드 위치"
            >
              {selected?.sources.map((source) => (
                <li key={source}>
                  <code>{source}</code>
                </li>
              ))}
            </ul>
            {!selected?.sources.length && (
              <p className="ui-meta">이 요소의 코드 위치를 확인하지 못했어요.</p>
            )}
            <label className="ui-inspector-comment">
              수정할 내용
              <textarea
                autoFocus
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key !== "Enter" ||
                    event.shiftKey ||
                    event.nativeEvent.isComposing ||
                    event.keyCode === 229
                  )
                    return;
                  event.preventDefault();
                  if (!submitting.current) event.currentTarget.form?.requestSubmit();
                }}
                maxLength={6000}
                rows={5}
                placeholder="어떻게 바꾸고 싶은지 적어주세요. Enter 보내기 · Shift+Enter 줄바꿈"
              />
            </label>
          </div>
          <footer className="ui-dialog-footer">
            <span
              className="ui-meta"
              title="개선 요청에 추가한 뒤 Codex 시작 버튼으로 실행할 수 있어요. 화면의 입력값과 본문은 자동으로 포함하지 않아요."
            >
              화면 입력값과 본문은 포함하지 않아요.
            </span>
            <button type="button" onClick={close}>
              취소
            </button>
            <button
              className="primary"
              type="submit"
              disabled={!comment.trim()}
            >
              개선 요청에 추가
            </button>
          </footer>
        </form>
      </dialog>
    </>
  );
}

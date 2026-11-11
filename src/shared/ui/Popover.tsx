import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { cx, HelpIcon, MoreIcon } from "./primitives";

/*
 * 공용 팝오버와 ⋯ 메뉴. 모든 화면이 같은 모양·키보드 동작을 쓰도록 여기 하나만 둔다.
 * - 위치: 트리거 기준 position:fixed. 아래 공간이 모자라면 위로 뒤집는다(터미널 탭바 등).
 * - 닫기: Esc(트리거로 포커스 복귀), 바깥 pointerdown, Tab으로 벗어남, 항목 선택.
 * - 접근성: 트리거 aria-haspopup·aria-expanded·aria-controls, 메뉴 role=menu, 항목 role=menuitem.
 * 스타일: components.css의 .ui-popover / .ui-menu / .ui-menu-item.
 */

export type Placement = "bottom-start" | "bottom-end";

const GAP = 4;
const EDGE = 8;

function usePlacement(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
  placement: Placement,
) {
  const [style, setStyle] = useState<CSSProperties>({});
  const [measured, setMeasured] = useState(false);
  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const t = trigger.getBoundingClientRect();
    const { width, height } = panel.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const below = vh - t.bottom - GAP - EDGE;
    const above = t.top - GAP - EDGE;
    const up = height > below && above > below;
    let left = placement === "bottom-end" ? t.right - width : t.left;
    left = Math.max(EDGE, Math.min(left, vw - width - EDGE));
    setStyle(
      up
        ? { left, bottom: vh - t.top + GAP, maxHeight: above }
        : { left, top: t.bottom + GAP, maxHeight: below },
    );
    setMeasured(true);
  }, [placement, triggerRef, panelRef]);
  useLayoutEffect(() => {
    if (!open) {
      setMeasured(false);
      return;
    }
    place();
  }, [open, place]);
  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", place);
    // 스크롤 컨테이너 안에서도 트리거를 따라가게 capture로 듣는다.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);
  return { style, measured };
}

function useDismiss(
  open: boolean,
  rootRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
  close: (restoreFocus: boolean) => void,
) {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, rootRef, panelRef, close]);
}

type TriggerProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onClick" | "aria-haspopup" | "aria-expanded" | "aria-controls" | "children"
> & { [key: `data-${string}`]: string | undefined };

/* ---------- Popover (도움말 `?`, 작은 설정 등) ---------- */

/**
 * 비모달 팝오버(role=dialog). 기본 트리거는 `?` 아이콘 버튼.
 * <Popover label="단축키 도움말">…내용…</Popover>
 */
export function Popover({
  label,
  trigger,
  triggerClassName,
  triggerProps,
  placement = "bottom-end",
  className,
  children,
  open: controlledOpen,
  onOpenChange,
}: {
  /** 트리거 aria-label·title이자 팝오버 접근 이름. */
  label: string;
  /** 트리거 안쪽 내용. 없으면 `?` 아이콘. 글자가 있으면 텍스트 버튼이 된다. */
  trigger?: ReactNode;
  triggerClassName?: string;
  triggerProps?: TriggerProps;
  placement?: Placement;
  className?: string;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [innerOpen, setInnerOpen] = useState(false);
  const open = controlledOpen ?? innerOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) setInnerOpen(next);
      onOpenChange?.(next);
    },
    [controlledOpen, onOpenChange],
  );
  const id = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(
    (restoreFocus: boolean) => {
      setOpen(false);
      if (restoreFocus) triggerRef.current?.focus();
    },
    [setOpen],
  );
  useDismiss(open, rootRef, panelRef, close);
  const { style, measured } = usePlacement(
    open,
    triggerRef,
    panelRef,
    placement,
  );
  const iconOnly = trigger === undefined;
  return (
    <span className="ui-popover-root" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        title={label}
        aria-label={iconOnly ? label : undefined}
        {...triggerProps}
        className={cx(
          iconOnly && "icon-button",
          "ui-menu-trigger",
          triggerClassName,
          triggerProps?.className,
        )}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        {trigger ?? <HelpIcon />}
      </button>
      {open && (
        <div
          id={id}
          ref={panelRef}
          role="dialog"
          aria-label={label}
          className={cx("ui-popover", className)}
          data-measuring={measured ? undefined : ""}
          style={style}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close(true);
            }
          }}
        >
          {children}
        </div>
      )}
    </span>
  );
}

/* ---------- Menu (⋯) ---------- */

export type MenuAction = {
  /** 항목 접근 이름이자 표시 문구. */
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  /** 오른쪽 회색 힌트(단축키 등). */
  hint?: string;
  disabled?: boolean;
  /** 체크 표시(role=menuitemcheckbox). undefined면 일반 항목. */
  checked?: boolean;
  tone?: "danger";
  title?: string;
  /** data-testid 등 테스트 식별자. */
  testId?: string;
};
export type MenuEntry =
  | MenuAction
  | { separator: true }
  | { heading: string };

const isAction = (entry: MenuEntry): entry is MenuAction =>
  "onSelect" in entry;

/**
 * ⋯ 메뉴. 기본 트리거는 MoreIcon 아이콘 버튼(label = aria-label).
 * trigger를 주면 그 내용으로 버튼을 그린다(예: <PlusIcon/>, "새 세션").
 *
 * <Menu label="더 보기" items={[{ label: "사진 넣기", onSelect: addPhoto },
 *   { separator: true }, { label: "묶음 삭제", tone: "danger", onSelect: remove }]} />
 */
export function Menu({
  label,
  items,
  menuLabel,
  trigger,
  triggerClassName,
  triggerProps,
  placement = "bottom-end",
  className,
  onOpenChange,
}: {
  /** 트리거 접근 이름(aria-label, title). */
  label: string;
  items: MenuEntry[];
  /** role=menu 접근 이름. 없으면 label. */
  menuLabel?: string;
  trigger?: ReactNode;
  triggerClassName?: string;
  triggerProps?: TriggerProps;
  placement?: Placement;
  className?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpenState] = useState(false);
  const [focusOnOpen, setFocusOnOpen] = useState<"first" | "last" | null>(
    null,
  );
  const id = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const close = useCallback(
    (restoreFocus: boolean) => {
      setOpen(false);
      if (restoreFocus) triggerRef.current?.focus();
    },
    [setOpen],
  );
  useDismiss(open, rootRef, panelRef, close);
  const { style, measured } = usePlacement(
    open,
    triggerRef,
    panelRef,
    placement,
  );
  const enabledItems = () =>
    [
      ...(panelRef.current?.querySelectorAll<HTMLElement>(
        '[role^="menuitem"]:not([aria-disabled="true"])',
      ) ?? []),
    ];
  useEffect(() => {
    if (!open || !measured || !focusOnOpen) return;
    const list = enabledItems();
    (focusOnOpen === "last" ? list.at(-1) : list[0])?.focus();
    setFocusOnOpen(null);
  }, [open, measured, focusOnOpen]);

  const openWith = (focus: "first" | "last") => {
    setFocusOnOpen(focus);
    setOpen(true);
  };
  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      return close(true);
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openWith(event.key === "ArrowUp" ? "last" : "first");
    }
  };
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = enabledItems();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (index: number) => {
      event.preventDefault();
      list[(index + list.length) % list.length]?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        return go(at + 1);
      case "ArrowUp":
        return go(at < 0 ? list.length - 1 : at - 1);
      case "Home":
        return go(0);
      case "End":
        return go(list.length - 1);
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        return close(true);
      case "Tab":
        return close(false);
    }
  };
  const select = (item: MenuAction) => {
    if (item.disabled) return;
    close(true);
    item.onSelect();
  };
  const iconOnly = trigger === undefined;
  return (
    <span className="ui-popover-root" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        title={label}
        aria-label={label}
        {...triggerProps}
        className={cx(
          iconOnly && "icon-button",
          "ui-menu-trigger",
          triggerClassName,
          triggerProps?.className,
        )}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={(event) => {
          // 키보드(Enter/Space)로 연 경우 첫 항목에 포커스, 마우스면 메뉴만 연다.
          if (open) return close(false);
          if (event.detail === 0) openWith("first");
          else setOpen(true);
        }}
        onKeyDown={onTriggerKeyDown}
      >
        {trigger ?? <MoreIcon />}
      </button>
      {open && (
        <div
          id={id}
          ref={panelRef}
          role="menu"
          aria-label={menuLabel ?? label}
          className={cx("ui-menu", className)}
          data-measuring={measured ? undefined : ""}
          style={style}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((entry, index) => {
            if ("separator" in entry)
              return (
                <div
                  key={`s${index}`}
                  role="separator"
                  className="ui-menu-separator"
                />
              );
            if ("heading" in entry)
              return (
                <div
                  key={`h${index}`}
                  role="presentation"
                  className="ui-menu-heading"
                >
                  {entry.heading}
                </div>
              );
            if (!isAction(entry)) return null;
            const checkable = entry.checked !== undefined;
            return (
              <button
                key={`${entry.label}-${index}`}
                type="button"
                role={checkable ? "menuitemcheckbox" : "menuitem"}
                aria-checked={checkable ? entry.checked : undefined}
                aria-disabled={entry.disabled || undefined}
                tabIndex={-1}
                title={entry.title}
                data-testid={entry.testId}
                data-tone={entry.tone}
                className="ui-menu-item"
                onClick={() => select(entry)}
              >
                {checkable && (
                  <span className="ui-menu-item-check" aria-hidden="true">
                    {entry.checked ? "✓" : ""}
                  </span>
                )}
                {entry.icon}
                <span className="ui-menu-item-label">{entry.label}</span>
                {entry.hint && (
                  <span className="ui-menu-item-hint">{entry.hint}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}

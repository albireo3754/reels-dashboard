import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type DialogHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";

/*
 * Shared UI primitives. 스타일 정본은 components.css / tokens.css 이고,
 * 이 래퍼는 같은 클래스 조합을 일관되게 쓰도록 돕는다. 팝오버·⋯ 메뉴는 ./Popover.
 * 사용법: docs/design-system.md
 */

export const cx = (...names: (string | false | null | undefined)[]) =>
  names.filter(Boolean).join(" ") || undefined;

/** quiet(기본, 투명) · secondary(hairline) · primary(채움, 화면당 1개) · danger(채움). */
export type ButtonVariant = "quiet" | "secondary" | "primary" | "danger";
/** small 24px · medium 28px(기본) · large 32px(입력 옆에 둘 때). */
export type ButtonSize = "small" | "medium" | "large";

export function Button({
  variant = "quiet",
  size = "medium",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      type={type}
      className={cx(
        variant !== "quiet" && variant,
        size !== "medium" && size,
        className,
      )}
      {...props}
    />
  );
}

/**
 * 28px 정사각 아이콘 버튼. label이 aria-label과 title(툴팁)이 된다.
 * 토글이면 pressed를 넘긴다(aria-pressed → 선택 배경).
 */
export function IconButton({
  label,
  title,
  pressed,
  size = "medium",
  className,
  type = "button",
  children,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & {
  label: string;
  pressed?: boolean;
  size?: ButtonSize;
}) {
  return (
    <button
      type={type}
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed}
      className={cx("icon-button", size !== "medium" && size, className)}
      {...props}
    >
      {children}
    </button>
  );
}

/** 무테 섹션. 예전 이름 호환으로 `.panel` 클래스를 함께 단다. */
export function Card({
  as: Tag = "section",
  className,
  ...props
}: HTMLAttributes<HTMLElement> & { as?: "section" | "div" | "article" }) {
  return <Tag className={cx("panel", className)} {...props} />;
}

/** 무테 섹션. divided면 위쪽 hairline. */
export function Section({
  as: Tag = "section",
  divided,
  className,
  ...props
}: HTMLAttributes<HTMLElement> & {
  as?: "section" | "div" | "article";
  divided?: boolean;
}) {
  return (
    <Tag
      className={cx("ui-section", className)}
      data-divided={divided ? "" : undefined}
      {...props}
    />
  );
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  actions,
  level = 2,
}: {
  /** @deprecated eyebrow는 화면에 보이지 않는다(.ui-eyebrow { display: none }). */
  eyebrow?: ReactNode;
  title: ReactNode;
  /** 한 줄 회색 메타. 설명 문단은 쓰지 않는다. */
  description?: ReactNode;
  actions?: ReactNode;
  level?: 2 | 3;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <header className="ui-section-header">
      <div>
        {eyebrow && <span className="ui-eyebrow">{eyebrow}</span>}
        <Heading>{title}</Heading>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="ui-actions">{actions}</div>}
    </header>
  );
}

/** 한 줄 상단 바. divided면 아래 hairline. 사이 여백은 <Spacer />. */
export function Toolbar({
  divided,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { divided?: boolean }) {
  return (
    <div
      className={cx("ui-toolbar", className)}
      data-divided={divided ? "" : undefined}
      {...props}
    />
  );
}

export function Spacer() {
  return <span className="ui-spacer" aria-hidden="true" />;
}

export type Tone = "neutral" | "primary" | "warning" | "danger";

export function Badge({
  tone = "neutral",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cx("ui-badge", className)}
      data-tone={tone === "neutral" ? undefined : tone}
      {...props}
    />
  );
}

/** 6px 상태 점. 변경 있음·실행 중처럼 상태가 있을 때만 그린다. */
export function Dot({
  tone = "neutral",
  label,
  className,
}: {
  tone?: Tone | "success";
  /** 있으면 title과 접근 이름이 된다. 없으면 장식(aria-hidden). */
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={cx("ui-dot", className)}
      data-tone={tone === "neutral" ? undefined : tone}
      title={label}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

/**
 * 한 줄 알림. info·warning은 배경 없는 텍스트, danger만 옅은 배경 + role=alert.
 */
export function Notice({
  tone = "info",
  icon,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLParagraphElement> & {
  tone?: "info" | "warning" | "danger";
  icon?: ReactNode;
}) {
  return (
    <p
      role={tone === "danger" ? "alert" : undefined}
      className={cx("ui-notice", className)}
      data-tone={tone}
      {...props}
    >
      {icon}
      {icon ? <span>{children}</span> : children}
    </p>
  );
}

/**
 * "저장됨 · 14:02" 같은 조용한 상태 한 줄. live면 role=status로 변화가 읽힌다.
 * busy면 작은 스피너를 앞에 붙인다.
 */
export function StatusText({
  tone = "neutral",
  live,
  busy,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  tone?: "neutral" | "warning" | "danger";
  live?: boolean;
  busy?: boolean;
}) {
  return (
    <span
      role={live ? "status" : undefined}
      className={cx("ui-status", className)}
      data-tone={tone === "neutral" ? undefined : tone}
      {...props}
    >
      {busy && <span className="ui-spinner" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  actions,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  /** 한 줄. */
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("ui-empty", className)}>
      {icon && <div className="ui-empty-icon">{icon}</div>}
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {actions && <div className="ui-actions">{actions}</div>}
    </div>
  );
}

export function FieldHelp(props: HTMLAttributes<HTMLSpanElement>) {
  return <span {...props} className={cx("field-help", props.className)} />;
}

/* ---------- Tabs / Segmented ---------- */

export type TabItem<T extends string = string> = {
  value: T;
  label: ReactNode;
  /** 접근 이름이 label과 달라야 할 때. */
  ariaLabel?: string;
  title?: string;
  /** 연결된 tabpanel id(aria-controls). */
  controls?: string;
  /** 탭 button id. 테스트·aria-labelledby가 참조할 때. */
  id?: string;
  disabled?: boolean;
};

const moveFocus = (
  event: KeyboardEvent<HTMLElement>,
  selector: string,
): HTMLElement | undefined => {
  const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(selector),
  ].filter((el) => !(el as HTMLButtonElement).disabled);
  if (!items.length) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (at + (event.key === "ArrowRight" ? 1 : -1) + items.length) %
          items.length;
  event.preventDefault();
  items[next].focus();
  return items[next];
};

/**
 * 텍스트 탭(role=tablist). 선택 탭만 tabIndex 0(roving), ←→/Home/End로 이동하며 바로 선택한다.
 * 탭 패널은 화면이 그린다(role=tabpanel, aria-labelledby=item.id).
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  size,
  className,
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** tablist 접근 이름. */
  label: string;
  size?: "small";
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cx("ui-tabs", className)}
      data-size={size}
      onKeyDown={(event) => {
        const el = moveFocus(event, '[role="tab"]');
        const next = items.find((item) => el?.dataset.value === item.value);
        if (next) onChange(next.value);
      }}
    >
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          id={item.id}
          data-value={item.value}
          aria-selected={item.value === value}
          aria-controls={item.controls}
          aria-label={item.ariaLabel}
          title={item.title}
          disabled={item.disabled}
          tabIndex={item.value === value ? 0 : -1}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 세그먼트(role=group + aria-pressed). 탭과 같은 모양이며 패널이 없는 보기 전환에 쓴다.
 */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
  label,
  size,
  className,
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  size?: "small";
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cx("ui-segmented", className)}
      data-size={size}
    >
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          id={item.id}
          aria-pressed={item.value === value}
          aria-label={item.ariaLabel}
          title={item.title}
          disabled={item.disabled}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Dialog ---------- */

/**
 * native <dialog> 모달. open 상태를 부모가 쥐고, Esc·닫기 버튼·backdrop 클릭은 모두 onClose로 알린다
 * (native cancel은 막아서 상태와 화면이 어긋나지 않게 한다).
 * 나머지 props(aria-label, data-* 등)는 <dialog>에 그대로 붙는다.
 */
export function Dialog({
  open,
  onClose,
  title,
  footer,
  size,
  closeLabel = "닫기",
  closeOnBackdrop = true,
  className,
  children,
  ...props
}: Omit<DialogHTMLAttributes<HTMLDialogElement>, "open" | "title"> & {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** 오른쪽 정렬 버튼 줄. 주 버튼(.primary)은 마지막 하나. */
  footer?: ReactNode;
  size?: "small" | "large";
  closeLabel?: string;
  closeOnBackdrop?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={cx("ui-dialog", className)}
      data-size={size}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (closeOnBackdrop && event.target === ref.current) onClose();
      }}
      {...props}
    >
      {open && (
        <>
          {title !== undefined && (
            <header className="ui-dialog-header">
              <h2>{title}</h2>
              <IconButton label={closeLabel} onClick={onClose}>
                <CloseIcon />
              </IconButton>
            </header>
          )}
          <div className="ui-dialog-body">{children}</div>
          {footer && <footer className="ui-dialog-footer">{footer}</footer>}
        </>
      )}
    </dialog>
  );
}

/* ---------- Icons used by shared primitives ---------- */

const iconProps = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function CloseIcon() {
  return (
    <svg {...iconProps}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function MoreIcon() {
  return (
    <svg {...iconProps} fill="currentColor" stroke="none">
      <circle cx="3.5" cy="8" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="12.5" cy="8" r="1.25" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg {...iconProps}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function ChevronDownIcon() {
  return (
    <svg {...iconProps}>
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

export function HelpIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.4 6.3a1.7 1.7 0 0 1 3.2.7c0 1.1-1.6 1.4-1.6 2.4M8 11.4v.1" />
    </svg>
  );
}

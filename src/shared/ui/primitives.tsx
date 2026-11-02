import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode,
} from "react";

/*
 * Shared UI primitives. 스타일 정본은 components.css / tokens.css 이고,
 * 이 래퍼는 같은 클래스 조합을 일관되게 쓰도록 돕는다.
 */

const cx = (...names: (string | false | null | undefined)[]) =>
  names.filter(Boolean).join(" ") || undefined;

export type ButtonVariant = "secondary" | "primary" | "danger" | "quiet";
export type ButtonSize = "small" | "medium" | "large";

export function Button({
  variant = "secondary",
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
        variant !== "secondary" && variant,
        size !== "medium" && size,
        className,
      )}
      {...props}
    />
  );
}

export function Card({
  as: Tag = "section",
  className,
  ...props
}: HTMLAttributes<HTMLElement> & { as?: "section" | "div" | "article" }) {
  return <Tag className={cx("panel", className)} {...props} />;
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  actions,
  level = 2,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
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

export function Notice({
  tone = "info",
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement> & {
  tone?: "info" | "warning" | "danger";
}) {
  return (
    <p
      role={tone === "danger" ? "alert" : undefined}
      className={cx("ui-notice", className)}
      data-tone={tone}
      {...props}
    />
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

import type { ReactNode } from "react";

export function EditorSection({
  id,
  title,
  actions,
  children,
}: {
  id: string;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className="ui-section editor-section"
      data-divided=""
      aria-labelledby={`${id}-title`}
    >
      <header className="ui-section-header">
        <h2 id={`${id}-title`}>{title}</h2>
        {actions && <div className="ui-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}
type NumberProps = {
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
};
export function NumberInput({
  label,
  value,
  onChange,
  disabled,
  min = 0,
  max = 1,
  step = 0.01,
  named = true,
}: NumberProps & { named?: boolean }) {
  return (
    <input
      className="ui-narrow"
      type="number"
      aria-label={named ? label : undefined}
      title={label}
      min={min}
      max={max}
      step={step}
      value={Number.isFinite(value) ? value : ""}
      onChange={(e) =>
        onChange(e.target.value === "" ? NaN : Number(e.target.value))
      }
      disabled={disabled}
    />
  );
}
/** 숫자 입력 한 칸. short가 있으면 짧은 글자만 보이고 접근 이름은 label 전체다. */
export function NumberField({ short, ...props }: NumberProps & { short?: string }) {
  return (
    <label className="editor-number">
      <span>{short ?? props.label}</span>
      <NumberInput {...props} named={!!short} />
    </label>
  );
}

import { useEffect, useRef, useState } from "react";
import { SE_FONT_STEPS } from "../../../shared/blog-markup";
export interface SelectionFormat {
  text: string;
  id: string;
  size: number | null;
  bold: boolean | null;
  color: string | null;
  background: string | null;
}
const colors = [
  ["기본", "#333333"],
  ["적갈색", "#a64132"],
  ["갈색", "#85613f"],
  ["하늘색", "#0096dc"],
  ["초록", "#54b800"],
];
const backgrounds = [
  ["노랑", "#fff8b2"],
  ["살구", "#ffe3c8"],
  ["연회색", "#e2e2e2"],
];
export function FormattingToolbar({
  selection,
  disabled,
  onFormat,
}: {
  selection?: SelectionFormat;
  disabled: boolean;
  onFormat: (command: string, value?: string) => void;
}) {
  const [palette, setPalette] = useState<"color" | "background" | null>(null);
  const control = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selection?.text) setPalette(null);
  }, [selection?.text]);
  useEffect(() => {
    if (!palette) return;
    const close = (e: PointerEvent) => {
      if (!control.current?.contains(e.target as Node)) setPalette(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [palette]);
  // Shown only while a phrase (not the title) is selected; the host keeps the frame
  // selection by preventing mousedown on every control (select excepted: it only reads it).
  const shown = !!selection?.text && selection.id !== "$title";
  const active = shown && !disabled;
  if (!shown) return null;
  return (
    <div className="ce-format" role="group" aria-label="선택 구절 서식">
      <label className="ce-size">
        <span className="ui-sr-only">글자 크기</span>
        <select
          aria-label="글자 크기"
          disabled={!active}
          value={selection?.size ?? ""}
          title="선택한 구절의 글자 크기"
          onChange={(e) => onFormat("size", e.target.value)}
        >
          <option value="">혼합</option>
          {SE_FONT_STEPS.map((n) => (
            <option key={n} value={n}>
              {n}px
            </option>
          ))}
          {selection?.size &&
            !SE_FONT_STEPS.includes(selection.size as never) && (
              <option value={selection.size}>{selection.size}px</option>
            )}
        </select>
      </label>
      <button
        className="icon-button"
        title="굵게 · 선택한 구절에 적용"
        aria-label="굵게"
        aria-pressed={selection?.bold === true}
        disabled={!active}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onFormat("bold")}
      >
        <b>B</b>
      </button>
      <div
        ref={control}
        className="ce-color-control"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setPalette(null);
          }
        }}
      >
        <button
          className="ce-color-button"
          title="글자색 선택"
          aria-label="글자색"
          aria-expanded={palette === "color"}
          disabled={!active}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setPalette(palette === "color" ? null : "color")}
        >
          <span
            className="ce-ink"
            style={{ borderBottomColor: selection?.color ?? "#333333" }}
          >
            가
          </span>
          <span className="ce-caret" aria-hidden="true">▾</span>
        </button>
        <button
          className="ce-color-button"
          title="배경색 선택"
          aria-label="배경색"
          aria-expanded={palette === "background"}
          disabled={!active}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() =>
            setPalette(palette === "background" ? null : "background")
          }
        >
          <mark
            className={selection?.background ? undefined : "is-empty"}
            style={{ background: selection?.background ?? "transparent" }}
          >
            가
          </mark>
          <span className="ce-caret" aria-hidden="true">▾</span>
        </button>
        {palette && (
          <div
            className="ce-palette"
            role="group"
            aria-label={palette === "color" ? "글자색 팔레트" : "배경색 팔레트"}
          >
            <div className="ce-palette-heading">
              <strong>{palette === "color" ? "글자색" : "배경색"}</strong>
              <button
                className="icon-button small"
                aria-label="색상 팔레트 닫기"
                onClick={() => setPalette(null)}
              >
                ×
              </button>
            </div>
            <div className="ce-swatches">
              {(palette === "color" ? colors : backgrounds).map(
                ([name, value]) => (
                  <button
                    key={value}
                    title={name}
                    aria-label={`${name} ${palette === "color" ? "글자" : "배경"}`}
                    aria-pressed={
                      (palette === "color"
                        ? selection?.color
                        : selection?.background) === value
                    }
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() =>
                      onFormat(
                        palette === "color" ? "foreColor" : "hiliteColor",
                        value,
                      )
                    }
                  >
                    <i style={{ background: value }} />
                    {name}
                  </button>
                ),
              )}
            </div>
            <label className="ce-custom-color">
              직접 선택
              <input
                type="color"
                aria-label={
                  palette === "color" ? "사용자 글자색" : "사용자 배경색"
                }
                value={
                  (palette === "color"
                    ? selection?.color
                    : selection?.background) ?? "#333333"
                }
                onChange={(e) =>
                  onFormat(
                    palette === "color" ? "foreColor" : "hiliteColor",
                    e.target.value,
                  )
                }
              />
            </label>
            {palette === "background" && (
              <button
                className="small"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onFormat("clearBackground")}
              >
                배경색만 지우기
              </button>
            )}
          </div>
        )}
      </div>
      <button
        title="선택 구절의 굵기·크기·색·배경을 기본값으로"
        aria-label="서식 지우기"
        disabled={!active}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onFormat("removeFormat")}
      >
        서식 지우기
      </button>
    </div>
  );
}

import type { EditSettings } from "../../../shared/editor";
import {
  applyEditorPreset,
  editorPresets,
  isPresetSelected,
} from "../model/presets";
import { useId, useState } from "react";
import { Tabs } from "../../../shared/ui/primitives";
import "./templates.css";

type Props = {
  settings: EditSettings;
  disabled: boolean;
  onChange: (update: (settings: EditSettings) => EditSettings) => void;
};
type Target = "video" | "cover";
const targets: { value: Target; label: string; legend: string }[] = [
  { value: "video", label: "영상", legend: "영상 템플릿" },
  { value: "cover", label: "표지·마지막 장", legend: "표지·마지막 장 템플릿" },
];
export function TemplatePanel({ settings, disabled, onChange }: Props) {
  const [target, setTarget] = useState<Target>("video");
  const id = useId();
  const current = targets.find((t) => t.value === target) ?? targets[0];
  return (
    <section className="ui-section template-panel" aria-label="편집 템플릿">
      <header className="ui-section-header">
        <h2 title="문구·자막 구간·표지 시점·배치는 유지해요. 표지 템플릿을 고르면 직접 지정한 글자 크기는 해제돼요.">
          템플릿
        </h2>
        <Tabs
          label="템플릿 종류"
          size="small"
          value={target}
          onChange={setTarget}
          items={targets.map((t) => ({
            value: t.value,
            label: t.label,
            id: `${id}-tab-${t.value}`,
            controls: `${id}-panel-${t.value}`,
          }))}
        />
      </header>
      <div
        role="tabpanel"
        id={`${id}-panel-${target}`}
        aria-labelledby={`${id}-tab-${target}`}
        title="카드는 구성 예시예요. 실제 글꼴·문구·크기는 합성 미리보기에서 확인할 수 있어요."
      >
        <fieldset disabled={disabled} className="template-group">
          <legend className="ui-sr-only">{current.legend}</legend>
          <div className="template-cards">
            {editorPresets
              .filter((p) => p.target === target)
              .map((preset) => (
                <button
                  type="button"
                  key={preset.id}
                  className="template-card"
                  aria-pressed={isPresetSelected(settings, preset)}
                  aria-label={`${preset.id}번 ${preset.title}`}
                  title={preset.note}
                  onClick={() => onChange((s) => applyEditorPreset(s, preset))}
                >
                  <span
                    className={`template-sample sample-${preset.id}`}
                    aria-hidden="true"
                  >
                    {preset.id !== "6" && (
                      <span className="sample-pin">📍 장소명</span>
                    )}
                    {preset.target === "video" &&
                      preset.material !== "none" && (
                        <span className="sample-description">함께 걷는 길</span>
                      )}
                    {preset.target === "cover" && (
                      <span className="sample-hook">
                        {preset.id === "6" ? (
                          <>
                            더 보고 싶다면
                            <br />
                            팔로우해 주세요!
                          </>
                        ) : (
                          <>
                            함께 걷는
                            <br />
                            가을 산책
                          </>
                        )}
                        <small>@your_account</small>
                      </span>
                    )}
                  </span>
                  <span className="template-card-title">
                    {preset.id}. {preset.title}
                  </span>
                </button>
              ))}
          </div>
        </fieldset>
      </div>
      <details className="template-adjustments">
        <summary title="이동값 0은 현재 기본·수동 배치 그대로예요. 양수는 오른쪽·아래, 음수는 왼쪽·위로 움직이며 안전영역을 넘으면 미리보기에서 알려줘요. 장소 핀 크기와 자막 크기·위치는 아래 각 편집 영역에서 조절해요.">
          템플릿 세부 조정
        </summary>
        <div className="template-adjustment-grid">
          <fieldset
            disabled={disabled}
            title="핀과 설명을 함께 이동해요. 본문 자막은 그대로예요."
          >
            <legend>영상 · 장소 안내 묶음 이동</legend>
            <Offset
              label="영상 장소 묶음 가로 이동 (%)"
              short="가로"
              value={settings.place.offsetX}
              onChange={(v) =>
                onChange((s) => ({ ...s, place: { ...s.place, offsetX: v } }))
              }
            />
            <Offset
              label="영상 장소 묶음 세로 이동 (%)"
              short="세로"
              value={settings.place.offsetY}
              onChange={(v) =>
                onChange((s) => ({ ...s, place: { ...s.place, offsetY: v } }))
              }
            />
          </fieldset>
          <fieldset
            disabled={disabled}
            title="왼쪽 정렬을 유지하고 표지 장소 핀은 그대로 둬요."
          >
            <legend>표지 · 훅과 서명 이동</legend>
            <Offset
              label="표지 훅 묶음 가로 이동 (%)"
              short="가로"
              value={settings.cover.hookOffsetX}
              onChange={(v) =>
                onChange((s) => ({
                  ...s,
                  cover: { ...s.cover, hookOffsetX: v },
                }))
              }
            />
            <Offset
              label="표지 훅 묶음 세로 이동 (%)"
              short="세로"
              value={settings.cover.hookOffsetY}
              onChange={(v) =>
                onChange((s) => ({
                  ...s,
                  cover: { ...s.cover, hookOffsetY: v },
                }))
              }
            />
          </fieldset>
          <fieldset
            disabled={disabled || settings.cover.template === "rosy-follow"}
            title={
              settings.cover.template === "rosy-follow"
                ? "팔로우 마지막 장에는 장소 핀을 표시하지 않아요."
                : "표지의 장소 핀만 옮겨요. 영상 배치와 별개예요."
            }
          >
            <legend>표지 · 장소 핀 이동</legend>
            <Offset
              label="표지 장소 핀 가로 이동 (%)"
              short="가로"
              value={settings.cover.placeOffsetX}
              onChange={(v) =>
                onChange((s) => ({
                  ...s,
                  cover: { ...s.cover, placeOffsetX: v },
                }))
              }
            />
            <Offset
              label="표지 장소 핀 세로 이동 (%)"
              short="세로"
              value={settings.cover.placeOffsetY}
              onChange={(v) =>
                onChange((s) => ({
                  ...s,
                  cover: { ...s.cover, placeOffsetY: v },
                }))
              }
            />
          </fieldset>
          <fieldset
            disabled={disabled}
            title="2160px 영상폭 기준이에요. 두 줄에 같은 크기를 적용해요."
          >
            <legend>표지 · 글자 크기</legend>
            <label className="ui-check">
              <input
                type="checkbox"
                checked={settings.cover.hookSize !== undefined}
                onChange={(e) =>
                  onChange((s) => {
                    const { hookSize: _, ...cover } = s.cover;
                    return {
                      ...s,
                      cover: e.target.checked
                        ? { ...cover, hookSize: 165 }
                        : cover,
                    };
                  })
                }
              />
              표지 글자 크기 직접 지정
            </label>
            <label className="template-offset">
              <span>크기 (px)</span>
              <input
                className="ui-narrow"
                aria-label="표지 글자 크기 (px)"
                type="number"
                min={1}
                max={185}
                step={1}
                disabled={settings.cover.hookSize === undefined}
                value={settings.cover.hookSize ?? ""}
                placeholder="자동"
                title="비워 두면 템플릿에서 결정해요."
                onChange={(e) =>
                  onChange((s) => ({
                    ...s,
                    cover: { ...s.cover, hookSize: Number(e.target.value) },
                  }))
                }
              />
            </label>
          </fieldset>
        </div>
      </details>
    </section>
  );
}
function Offset({
  label,
  short,
  value,
  onChange,
}: {
  label: string;
  short: string;
  value?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="template-offset">
      <span>{short}</span>
      <input
        className="ui-narrow"
        aria-label={label}
        title={label}
        type="number"
        min={-100}
        max={100}
        step={0.5}
        value={Number(((value ?? 0) * 100).toFixed(4))}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
    </label>
  );
}

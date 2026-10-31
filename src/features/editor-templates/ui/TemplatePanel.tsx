import type { EditSettings } from "../../../shared/editor";
import {
  applyEditorPreset,
  editorPresets,
  isPresetSelected,
} from "../model/presets";
import "./templates.css";

type Props = {
  settings: EditSettings;
  disabled: boolean;
  onChange: (update: (settings: EditSettings) => EditSettings) => void;
};
export function TemplatePanel({ settings, disabled, onChange }: Props) {
  return (
    <section className="panel template-panel" aria-label="편집 템플릿">
      <div className="section-heading">
        <div>
          <span className="eyebrow">TEMPLATES</span>
          <h2>템플릿 선택과 조정</h2>
        </div>
        <span className="editor-badge">프리셋 1–6</span>
      </div>
      <p className="muted compact">
        영상과 표지 구성을 각각 골라요. 문구·자막 구간·표지 시점·배치는
        유지하며, 표지 프리셋을 고르면 직접 지정한 글자 크기는 해제돼요.
      </p>
      <div className="template-catalog">
        {(["video", "cover"] as const).map((target) => (
          <fieldset key={target} disabled={disabled} className="template-group">
            <legend>
              {target === "video" ? "영상 템플릿" : "표지·마지막 장 템플릿"}
            </legend>
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
                    onClick={() =>
                      onChange((s) => applyEditorPreset(s, preset))
                    }
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
                          <span className="sample-description">
                            함께 걷는 길
                          </span>
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
                    <strong>
                      {preset.id}. {preset.title}
                    </strong>
                    <small>{preset.note}</small>
                  </button>
                ))}
            </div>
          </fieldset>
        ))}
      </div>
      <p className="muted compact">
        카드는 구성 예시예요. 실제 글꼴·문구·크기는 합성 미리보기에서 확인할 수
        있어요.
      </p>
      <details className="template-adjustments">
        <summary>템플릿 세부 조정</summary>
        <div className="template-adjustment-grid">
          <fieldset disabled={disabled}>
            <legend>영상 · 장소 안내 묶음 이동</legend>
            <p>핀과 설명을 함께 이동해요. 본문 자막은 그대로예요.</p>
            <Offset
              label="영상 장소 묶음 가로 이동 (%)"
              value={settings.place.offsetX}
              onChange={(v) =>
                onChange((s) => ({ ...s, place: { ...s.place, offsetX: v } }))
              }
            />
            <Offset
              label="영상 장소 묶음 세로 이동 (%)"
              value={settings.place.offsetY}
              onChange={(v) =>
                onChange((s) => ({ ...s, place: { ...s.place, offsetY: v } }))
              }
            />
          </fieldset>
          <fieldset disabled={disabled}>
            <legend>표지 · 훅과 서명 이동</legend>
            <p>왼쪽 정렬을 유지하고 표지 장소 핀은 그대로 둬요.</p>
            <Offset
              label="표지 훅 묶음 가로 이동 (%)"
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
          >
            <legend>표지 · 장소 핀 이동</legend>
            <p>
              {settings.cover.template === "rosy-follow"
                ? "팔로우 마지막 장에는 장소 핀을 표시하지 않아요."
                : "표지의 장소 핀만 옮겨요. 영상 배치와 별개예요."}
            </p>
            <Offset
              label="표지 장소 핀 가로 이동 (%)"
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
              value={settings.cover.placeOffsetY}
              onChange={(v) =>
                onChange((s) => ({
                  ...s,
                  cover: { ...s.cover, placeOffsetY: v },
                }))
              }
            />
          </fieldset>
          <fieldset disabled={disabled}>
            <legend>표지 · 글자 크기</legend>
            <p>2160px 영상폭 기준이에요. 두 줄에 같은 크기를 적용해요.</p>
            <label className="checkbox-row">
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
            <label>
              표지 글자 크기 (px)
              <input
                type="number"
                min={1}
                max={185}
                step={1}
                disabled={settings.cover.hookSize === undefined}
                value={settings.cover.hookSize ?? ""}
                placeholder="템플릿에서 결정"
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
        <p className="muted compact">
          이동값 0은 현재 기본·수동 배치 그대로예요. 양수는 오른쪽·아래, 음수는
          왼쪽·위로 움직이며 안전영역을 넘으면 미리보기에서 알려줘요. 장소 핀
          크기와 자막 크기·위치는 아래 각 편집 영역에서 조절해요.
        </p>
      </details>
    </section>
  );
}
function Offset({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      {label}
      <input
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

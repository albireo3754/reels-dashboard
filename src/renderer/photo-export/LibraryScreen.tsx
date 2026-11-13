import type { ReactNode } from "react";
import type { Asset, DashboardBridge, Status } from "../../shared/contracts";
import { Section, SectionHeader } from "../../shared/ui/primitives";
import { Empty, Icon } from "../ui";
import { readableTime, type Choice } from "./shared";
import type { PhotoExportActions, PhotoExportState } from "./usePhotoExport";

/** 촬영 보관함 화면(데스크톱). 상태와 핸들러는 App의 usePhotoExport에서 받는다. */
export function LibraryScreen({
  photo,
  actions,
  connection,
  status,
  busy,
  canIndex,
  editorRendering,
  run,
  bridge,
}: {
  photo: PhotoExportState;
  actions: PhotoExportActions;
  connection: ReactNode;
  status: Status | null;
  busy: string;
  canIndex: boolean;
  editorRendering: boolean;
  run: (name: string, fn: () => Promise<void>) => Promise<void>;
  bridge: DashboardBridge;
}) {
  const {
    date,
    setDate,
    level,
    groups,
    setGroups,
    detail,
    choices,
    setChoices,
    inspection,
    images,
    evidencePage,
    reviewedPages,
    label,
    setLabel,
    confidence,
    setConfidence,
    unknowns,
    setUnknowns,
    validated,
    destination,
    setDestination,
    setPlan,
    setReviewed,
    setMoveConfirmed,
  } = photo;
  const {
    editPhotosVideo,
    invalidate,
    clearSelection,
    sync,
    changeLevel,
    selectGroup,
    inspect,
    saveDecision,
    validate,
    importDecision,
    createPlan,
  } = actions;
  const counts = detail
    ? {
        included: detail.assets.filter((a) => choices[a.id] === "included")
          .length,
        excluded: detail.assets.filter((a) => choices[a.id] === "excluded")
          .length,
        undecided: detail.assets.filter(
          (a) => !choices[a.id] || choices[a.id] === "undecided",
        ).length,
      }
    : null;
  return (
    <>
      {connection}
      {status?.permission === "limited" && (
        <p className="inline-warning">
          일부 사진만 허용되어 있어요. 목록에 없는 촬영본은 Photos 접근
          범위를 확인해주세요.
        </p>
      )}
      {status &&
        ["denied", "restricted"].includes(status.permission) && (
          <p className="inline-warning">
            시스템 설정 → 개인정보 보호 및 보안 → 사진에서 접근 권한을
            확인해주세요.
          </p>
        )}
      <div className="library-controls">
        <input
          aria-label="촬영 날짜"
          title="촬영 날짜"
          className="ui-inline"
          type="date"
          value={date}
          onChange={(e) => {
            setDate(e.target.value);
            setGroups(null);
            clearSelection();
          }}
          disabled={!!busy}
        />
        <select
          aria-label="그룹 크기"
          title="그룹 크기"
          className="ui-inline"
          value={level}
          onChange={(e) =>
            changeLevel(e.target.value as "fine" | "coarse")
          }
          disabled={!!busy}
        >
          <option value="fine">장면별로 자세히</option>
          <option value="coarse">방문 단위로 넓게</option>
        </select>
        <button
          className={`${groups ? "secondary" : "primary"} large`}
          onClick={sync}
          disabled={!!busy || !canIndex || !date}
        >
          날짜 색인
        </button>
      </div>
      {!groups ? (
        <Empty title="촬영한 날짜부터 골라주세요.">
          날짜를 색인하면 시간과 위치로 묶인 촬영 그룹이 보여요.
        </Empty>
      ) : !groups.groups.length ? (
        <Empty title="이 날짜에는 촬영본이 없어요.">
          다른 날짜를 선택하거나 Photos 접근 범위를 확인해주세요.
        </Empty>
      ) : (
        <div className="library-layout">
          <section className="group-list" aria-label="촬영 그룹">
            <h2 className="group-list-heading">
              촬영 그룹 <span>{groups.groups.length}개</span>
            </h2>
            {groups.groups.map((g) => (
              <button
                key={g.id}
                className={`ui-row group-item ${detail?.group.id === g.id ? "selected" : ""}`}
                aria-label={`그룹 ${g.localDate} · ${g.assetIDs.length}개`}
                aria-current={detail?.group.id === g.id ? "true" : undefined}
                onClick={() => selectGroup(g.id)}
                disabled={!!busy}
              >
                <span className="group-icon">
                  <Icon name="library" />
                </span>
                <span>
                  <strong>{g.localDate}</strong>
                  <small>
                    {g.assetIDs.length}개 장면 ·{" "}
                    {g.level === "fine" ? "장면별" : "방문별"} ·{" "}
                    {readableTime(g.start)}
                  </small>
                  {g.warnings.length > 0 && (
                    <small className="warning-text">
                      {g.warnings.join(" · ")}
                    </small>
                  )}
                </span>
              </button>
            ))}
          </section>
          <div className="group-content">
            {!detail ? (
              <Empty title="어떤 그룹을 살펴볼까요?">
                왼쪽에서 그룹을 고르면 장면과 분류 작업이 열려요.
              </Empty>
            ) : (
              <>
                <Section>
                  <SectionHeader
                    title={`${detail.group.localDate}의 장면들`}
                    description={`${detail.assets.length}개 · ${readableTime(detail.group.start)}부터`}
                    actions={
                      <button
                        className="secondary"
                        title="페이지당 최대 12개, 동영상은 포스터 이미지로 보여줘요."
                        onClick={() => inspect(1)}
                        disabled={!!busy}
                      >
                        미리보기 만들기
                      </button>
                    }
                  />
                  {detail.group.warnings.map((w) => (
                    <p className="inline-warning" key={w}>
                      {w}
                    </p>
                  ))}
                  {inspection && (
                    <>
                      <div className="evidence-summary">
                        <span>
                          미리보기 {evidencePage} /{" "}
                          {Math.max(
                            1,
                            Math.ceil(detail.assets.length / 12),
                          )}
                          페이지
                        </span>
                        <span>
                          열어본 페이지 {reviewedPages.length}개
                        </span>
                      </div>
                      {inspection.packet.warnings.map((w) => (
                        <p className="inline-warning" key={w}>
                          {w}
                        </p>
                      ))}
                      <div className="evidence-grid">
                        {inspection.packet.samples.map((sample) => (
                          <figure key={sample.id}>
                            <img
                              src={images[sample.assetID]}
                              alt={`${detail.assets.find((a) => a.id === sample.assetID)?.publicFilename || sample.assetID} 미리보기`}
                            />
                            <figcaption>
                              <strong>
                                {detail.assets.find(
                                  (a) => a.id === sample.assetID,
                                )?.publicFilename || sample.assetID}
                              </strong>
                              {sample.kind === "videoFrame" && (
                                <small>동영상 포스터</small>
                              )}
                              {sample.ocr.map((o, i) => (
                                <p className="ocr" key={i}>
                                  {o.text}
                                </p>
                              ))}
                              {sample.privacyFlags.map((f) => (
                                <span className="privacy-tag" key={f}>
                                  {f}
                                </span>
                              ))}
                            </figcaption>
                          </figure>
                        ))}
                      </div>
                      <div className="pagination">
                        <button
                          onClick={() => inspect(evidencePage - 1)}
                          disabled={!!busy || evidencePage <= 1}
                        >
                          이전 페이지
                        </button>
                        <span>
                          {evidencePage} /{" "}
                          {Math.max(
                            1,
                            Math.ceil(detail.assets.length / 12),
                          )}
                        </span>
                        <button
                          onClick={() => inspect(evidencePage + 1)}
                          disabled={
                            !!busy ||
                            evidencePage >=
                              Math.ceil(detail.assets.length / 12)
                          }
                        >
                          다음 페이지
                        </button>
                      </div>
                    </>
                  )}
                </Section>
                <Section divided>
                  <div className="section-heading">
                    <h2>사용할 촬영본 고르기</h2>
                    <button
                      onClick={() => {
                        setChoices(
                          Object.fromEntries(
                            detail.assets.map((a) => [
                              a.id,
                              "included",
                            ]),
                          ),
                        );
                        invalidate();
                      }}
                      disabled={!!busy}
                    >
                      모두 포함
                    </button>
                  </div>
                  <div className="selection-counts">
                    <span>
                      포함 <strong>{counts?.included}</strong>
                    </span>
                    <span>
                      제외 <strong>{counts?.excluded}</strong>
                    </span>
                    <span>
                      미정 <strong>{counts?.undecided}</strong>
                    </span>
                  </div>
                  <div className="asset-list">
                    {detail.assets.map((asset) => (
                      <AssetRow
                        key={asset.id}
                        asset={asset}
                        choice={choices[asset.id] || "undecided"}
                        disabled={!!busy}
                        editingDisabled={!!busy || editorRendering}
                        onEdit={() => editPhotosVideo(asset.id)}
                        onChange={(value) => {
                          setChoices((p) => ({
                            ...p,
                            [asset.id]: value,
                          }));
                          invalidate();
                        }}
                      />
                    ))}
                  </div>
                </Section>
                <Section divided>
                  <div className="section-heading">
                    <h2>콘텐츠 분류</h2>
                    <button
                      onClick={importDecision}
                      disabled={!!busy}
                    >
                      분류 파일 불러오기
                    </button>
                  </div>
                  <div className="form-grid">
                    <label>
                      콘텐츠 이름
                      <input
                        value={label}
                        onChange={(e) => {
                          setLabel(e.target.value);
                          invalidate();
                        }}
                        placeholder="예: 도쿄의 오후 산책"
                        disabled={!!busy}
                      />
                    </label>
                    <label>
                      판단 신뢰도
                      <input
                        aria-label="판단 신뢰도"
                        type="number"
                        min="0"
                        max="1"
                        step="0.05"
                        value={confidence}
                        onChange={(e) => {
                          setConfidence(e.target.value);
                          invalidate();
                        }}
                        disabled={!!busy}
                      />
                    </label>
                    <label className="full">
                      미해결 사항
                      <textarea
                        value={unknowns}
                        onChange={(e) => {
                          setUnknowns(e.target.value);
                          invalidate();
                        }}
                        placeholder="확인이 필요한 내용이 있다면 한 줄에 하나씩 적어주세요."
                        disabled={!!busy}
                      />
                    </label>
                  </div>
                  <p className="ui-meta form-note">
                    모든 촬영본을 포함·제외로 나누고 신뢰도 0.8 이상, 미해결
                    사항이 없을 때 내보낼 수 있어요.
                  </p>
                  <div className="button-row">
                    <button
                      className="secondary"
                      onClick={saveDecision}
                      disabled={!!busy}
                    >
                      분류 파일 저장
                    </button>
                    <button
                      className="primary"
                      onClick={validate}
                      disabled={!!busy}
                    >
                      선택 검증
                    </button>
                    {validated && (
                      <span className="verified">
                        <Icon name="check" />
                        검증 통과
                      </span>
                    )}
                  </div>
                </Section>
                <Section divided>
                  <SectionHeader title="내보내기 준비" />
                  <label>
                    목적지 폴더
                    <div className="input-action">
                      <input
                        aria-label="목적지 폴더"
                        value={destination}
                        readOnly
                        placeholder="iCloud Drive의 허용된 내보내기 폴더"
                      />
                      <button
                        className="secondary large"
                        onClick={() =>
                          run("목적지 선택", async () => {
                            const path =
                              await bridge.chooseDestination();
                            if (path) {
                              setDestination(path);
                              setPlan(null);
                              setReviewed(false);
                              setMoveConfirmed(false);
                            }
                          })
                        }
                        disabled={!!busy}
                      >
                        목적지 선택
                      </button>
                    </div>
                  </label>
                  <p className="ui-meta form-note">
                    도우미가 허용한 폴더만 쓸 수 있고, 계획 단계에서는
                    원본을 복사하거나 지우지 않아요. 기본은 복사예요. Photos
                    원본은 그대로 두고, 이동(원본 삭제)은 직접 고를 때만 해요.
                  </p>
                  <div className="button-row">
                    <button
                      className="primary"
                      onClick={() => createPlan("export")}
                      disabled={!!busy || !validated || !destination}
                    >
                      복사 계획 만들기
                    </button>
                    <button
                      className="secondary"
                      title="복사·검증 뒤 Photos 원본을 최근 삭제 항목으로 옮겨요. 명시적으로 원할 때만 고르세요."
                      onClick={() => createPlan("move")}
                      disabled={!!busy || !validated || !destination}
                    >
                      이동 계획 만들기
                    </button>
                  </div>
                </Section>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
function AssetRow({
  asset,
  choice,
  onChange,
  disabled,
  editingDisabled,
  onEdit,
}: {
  asset: Asset;
  choice: Choice;
  onChange: (v: Choice) => void;
  disabled: boolean;
  editingDisabled: boolean;
  onEdit: () => void;
}) {
  return (
    <div className={`asset-row ${choice}`}>
      <span className="asset-kind">
        {asset.mediaKind === "video" ? "▶" : "▧"}
      </span>
      <div className="asset-info">
        <strong>{asset.publicFilename || "파일명 미상"}</strong>
        <span>
          {asset.mediaKind === "video"
            ? `동영상 ${asset.durationSeconds.toFixed(1)}초`
            : "사진"}{" "}
          · {asset.pixelWidth}×{asset.pixelHeight} ·{" "}
          {asset.hasLocation ? "위치 있음" : "위치 없음"}
        </span>
        <small>{readableTime(asset.capturedAt)}</small>
      </div>
      {asset.mediaKind === "video" && (
        <button
          className="asset-edit-button"
          aria-label={`이 영상 편집 ${asset.publicFilename || asset.id}`}
          onClick={onEdit}
          disabled={editingDisabled}
        >
          이 영상 편집
        </button>
      )}
      <select
        aria-label={`자산 분류 ${asset.publicFilename || asset.id}`}
        value={choice}
        onChange={(e) => onChange(e.target.value as Choice)}
        disabled={disabled}
      >
        <option value="undecided">미정</option>
        <option value="included">포함</option>
        <option value="excluded">제외</option>
      </select>
    </div>
  );
}

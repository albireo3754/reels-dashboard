import type { Tab } from "../pages";
import { Badge, Section, SectionHeader } from "../../shared/ui/primitives";
import { Empty, Icon, JSONDetails, asRecord, asStrings } from "../ui";
import { isRecoveryDigest } from "./shared";
import type { PhotoExportActions, PhotoExportState } from "./usePhotoExport";

/** 전송 화면(데스크톱). 상태와 핸들러는 App의 usePhotoExport에서 받는다. */
export function TransfersScreen({
  photo,
  actions,
  busy,
  setTab,
}: {
  photo: PhotoExportState;
  actions: PhotoExportActions;
  busy: string;
  setTab: (tab: Tab) => void;
}) {
  const {
    plan,
    reviewed,
    setReviewed,
    moveConfirmed,
    setMoveConfirmed,
    receipt,
    recovery,
    recoveryDigest,
    setRecoveryDigest,
    recoveryConfirmed,
    setRecoveryConfirmed,
  } = photo;
  const {
    applyPlan,
    importRecovery,
    recover,
  } = actions;
  const planData = plan
    ? asRecord(
        plan.kind === "move"
          ? plan.envelope.plan.exportPlan
          : plan.envelope.plan,
      )
    : {};
  const receiptRecord = asRecord(receipt),
    exportReceipt = asRecord(receiptRecord.exportReceipt || receipt),
    receiptEntries = Array.isArray(exportReceipt.entries)
      ? exportReceipt.entries.map(asRecord)
      : [];
  return (
    <>
      <dl className="transfer-types">
        <div>
          <dt>복사 내보내기</dt>
          <dd>선택한 원본을 목적지에 복사해요. Photos 원본은 그대로예요.</dd>
        </div>
        <div>
          <dt>검증 후 이동</dt>
          <dd>
            업로드와 파일 검증을 마친 뒤 Photos 원본을 최근 삭제 항목으로
            옮겨요.
          </dd>
        </div>
      </dl>
      {plan ? (
        <Section className="plan-panel">
          <SectionHeader
            title={`${plan.kind === "move" ? "이동" : "복사"} 계획 검토`}
            actions={
              <Badge tone={plan.kind === "move" ? "warning" : "neutral"}>
                {plan.kind === "move" ? "원본 삭제 포함" : "원본 유지"}
              </Badge>
            }
          />
          <PlanSummary data={planData} />
          <label>
            계획 digest
            <code className="digest">{plan.envelope.digest}</code>
          </label>
          <p className="file-path">계획 파일: {plan.path}</p>
          <JSONDetails
            data={plan.envelope.plan}
            label="계획 상세 보기"
          />
          <label className="checkbox-row ui-check">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(e) => setReviewed(e.target.checked)}
              disabled={!!busy}
            />
            계획을 검토했어요
          </label>
          {plan.kind === "move" && (
            <label className="checkbox-row ui-check destructive-check">
              <input
                type="checkbox"
                checked={moveConfirmed}
                onChange={(e) => setMoveConfirmed(e.target.checked)}
                disabled={!!busy}
              />
              Photos 원본이 최근 삭제 항목으로 이동함을 확인했어요
            </label>
          )}
          <button
            className={plan.kind === "move" ? "danger" : "primary"}
            onClick={applyPlan}
            disabled={
              !!busy ||
              !reviewed ||
              (plan.kind === "move" && !moveConfirmed)
            }
          >
            {plan.kind === "move" ? "원본 이동 실행" : "복사 실행"}
          </button>
        </Section>
      ) : (
        <Section>
          <Empty
            title="검토할 내보내기 계획이 없어요."
            actions={
              <button
                className="secondary"
                onClick={() => setTab("library")}
              >
                촬영 보관함 열기
              </button>
            }
          >
            촬영 보관함에서 선택을 검증한 뒤 계획을 만들어주세요.
          </Empty>
        </Section>
      )}
      <Section divided>
        <SectionHeader
          title="기존 이동 복구"
          description="중단된 작업은 같은 이동 계획과 digest로 다시 시도해요."
          actions={
            <button
              className="secondary"
              onClick={importRecovery}
              disabled={!!busy}
            >
              기존 계획 불러오기
            </button>
          }
        />
        {recovery && (
          <>
            <PlanSummary data={asRecord(recovery.data.exportPlan)} />
            <p className="file-path">{recovery.path}</p>
            <label>
              복구 digest
              <input
                aria-label="복구 digest"
                value={recoveryDigest}
                onChange={(e) => {
                  setRecoveryDigest(e.target.value.trim());
                  setRecoveryConfirmed(false);
                }}
                placeholder="기존 이동 계획의 64자리 SHA-256"
                disabled={!!busy}
              />
            </label>
            <label className="checkbox-row ui-check destructive-check">
              <input
                type="checkbox"
                checked={recoveryConfirmed}
                onChange={(e) => setRecoveryConfirmed(e.target.checked)}
                disabled={!!busy}
              />
              같은 이동의 원본 삭제와 복구 내용을 확인했어요
            </label>
            <button
              className="danger"
              onClick={recover}
              disabled={
                !!busy ||
                !recoveryConfirmed ||
                !isRecoveryDigest(recoveryDigest)
              }
            >
              같은 이동 재시도
            </button>
          </>
        )}
        <p className="ui-meta form-note">
          업로드 대기나 삭제 후 기록 실패가 있었다면 새 계획으로 바꾸지
          마세요. 원본 이동·복구 가능 여부는 도우미가 확인해요.
        </p>
      </Section>
      {receipt !== null && (
        <Section divided className="receipt-panel">
          <SectionHeader
            title="작업 결과"
            actions={
              <span className="verified">
                <Icon name="check" />
                결과 기록 확인
              </span>
            }
          />
          <div className="receipt-stats">
            <span>
              <strong>{receiptEntries.length}</strong>파일
            </span>
            <span>
              <strong>
                {receiptEntries
                  .reduce((n, e) => n + Number(e.bytes || 0), 0)
                  .toLocaleString()}
              </strong>
              bytes
            </span>
            <span>
              <strong>
                {receiptEntries.filter((e) => e.reused).length}
              </strong>
              재사용
            </span>
            {Array.isArray(receiptRecord.deletedAssetIDs) && (
              <span>
                <strong>{receiptRecord.deletedAssetIDs.length}</strong>
                원본 이동
              </span>
            )}
          </div>
          <p className="file-path">
            {String(exportReceipt.destinationRoot || "")}
          </p>
          {asStrings(exportReceipt.warnings).map((w) => (
            <p className="inline-warning" key={w}>
              {w}
            </p>
          ))}
          <JSONDetails data={receipt} label="파일별 검증 결과 보기" />
        </Section>
      )}
    </>
  );
}
function PlanSummary({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="plan-summary">
      <div>
        <span>콘텐츠</span>
        <strong>{String(data.label || "이름 없음")}</strong>
      </div>
      <div>
        <span>포함 / 제외</span>
        <strong>
          {asStrings(data.includedAssetIDs).length} /{" "}
          {asStrings(data.excludedAssetIDs).length}개
        </strong>
      </div>
      <div className="full">
        <span>목적지</span>
        <strong className="file-path">
          {String(data.destinationRoot || "미확인")}
        </strong>
      </div>
      {asStrings(data.warnings).map((w) => (
        <p className="inline-warning full" key={w}>
          {w}
        </p>
      ))}
    </div>
  );
}

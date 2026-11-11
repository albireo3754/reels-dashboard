import { koreanDateTime } from "../shared/lib/format";
import { useEffect, useState } from "react";
import type { DashboardBridge } from "../shared/contracts";
import type { MobileBriefingStatus } from "../shared/mobile-briefing";
import { Button, Section, SectionHeader } from "../shared/ui/primitives";

const time = (value: string | null) =>
  koreanDateTime(value, "아직 확인되지 않았어요");

/**
 * Mobile briefing site status. On the dashboard it is one quiet line
 * (`compact`); the settings screen shows the same facts as a section.
 */
export function MobileBriefing({
  bridge,
  compact = false,
}: {
  bridge: DashboardBridge;
  compact?: boolean;
}) {
  const [status, setStatus] = useState<MobileBriefingStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const next = await bridge.mobileBriefing!.status();
        if (active) {
          setStatus(next);
          setFailed(false);
        }
      } catch {
        if (active) setFailed(true);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [bridge]);
  const state = failed ? "unavailable" : status?.state;
  const stateText =
    state === "connected"
      ? "동기화 서비스 연결됨"
      : state === "offline"
        ? "동기화 서비스 연결 끊김"
        : state === "not-configured"
          ? "연결 정보 없음"
          : state === "unavailable"
            ? "연결 상태 확인 실패"
            : "연결 상태 확인 중";
  const facts = (
    <>
      마지막 서버 저장 · {time(status?.syncedAt ?? null)}
      {status?.contentCount != null && (
        <>
          {" "}
          · 콘텐츠·촬영 묶음 {status.contentCount}개 · 자료{" "}
          {status.assetCount}개
        </>
      )}
    </>
  );
  const open = () => {
    void bridge.mobileBriefing!.open().catch(() => setFailed(true));
  };
  const offlineHint =
    state === "offline"
      ? "사이트에서는 마지막으로 저장된 내용을 볼 수 있어요."
      : undefined;
  if (compact)
    return (
      <section
        className="briefing-line"
        aria-label="모바일 브리핑"
        title={offlineHint}
      >
        <span className="briefing-line-title">모바일 브리핑</span>
        <span
          role="status"
          className={state === "connected" ? undefined : "briefing-line-warn"}
        >
          {stateText}
        </span>
        <span className="ui-meta ui-truncate">{facts}</span>
        <Button
          size="small"
          className="briefing-line-open"
          disabled={!status?.siteUrl}
          onClick={open}
        >
          브리핑 사이트 열기
        </Button>
      </section>
    );
  return (
    // 설정 화면의 다른 섹션과 같은 열(settings-section 최대 폭)에 맞춘다.
    <Section className="briefing-panel settings-section" aria-label="모바일 브리핑">
      <SectionHeader
        title="모바일 브리핑"
        description="본인 전용 사이트에서 진행 현황과 캡션·댓글을 확인해요."
        actions={
          <Button
            variant="secondary"
            disabled={!status?.siteUrl}
            onClick={open}
          >
            브리핑 사이트 열기
          </Button>
        }
      />
      <p className="settings-line">
        <span role="status">{stateText}</span>
        <span className="ui-meta">{facts}</span>
      </p>
      {offlineHint && <p className="ui-meta">{offlineHint}</p>}
    </Section>
  );
}

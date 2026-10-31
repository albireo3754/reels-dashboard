import { useEffect, useState } from "react";
import type { DashboardBridge } from "../shared/contracts";
import type { MobileBriefingStatus } from "../shared/mobile-briefing";

const time = (value: string | null) =>
  value ? new Date(value).toLocaleString("ko-KR") : "아직 확인되지 않았어요";

export function MobileBriefing({ bridge }: { bridge: DashboardBridge }) {
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
  return (
    <section className="panel briefing-panel" aria-label="모바일 브리핑">
      <div className="section-heading">
        <div>
          <span className="eyebrow">SITES</span>
          <h2>모바일 브리핑</h2>
        </div>
        <span role="status">
          {state === "connected"
            ? "동기화 서비스 연결됨"
            : state === "offline"
              ? "동기화 서비스 연결 끊김"
              : state === "not-configured"
                ? "연결 정보 없음"
                : state === "unavailable"
                  ? "연결 상태 확인 실패"
                  : "연결 상태 확인 중"}
        </span>
      </div>
      <p className="briefing-description">
        본인 전용 사이트에서 진행 현황과 캡션·댓글을 확인해요. Mac과 앱이 실행
        중이면 매분 변경 내용을 반영해요.
      </p>
      <p className="muted compact">
        마지막 서버 저장 · {time(status?.syncedAt ?? null)}
        {status?.contentCount != null && (
          <>
            {" "}
            · 콘텐츠·촬영 묶음 {status.contentCount}개 · 자료{" "}
            {status.assetCount}개
          </>
        )}
      </p>
      {state === "offline" && (
        <p className="muted compact">
          사이트에서는 마지막으로 저장된 내용을 볼 수 있어요.
        </p>
      )}
      <div className="button-row">
        <button
          className="primary"
          disabled={!status?.siteUrl}
          onClick={() => {
            void bridge.mobileBriefing!.open().catch(() => setFailed(true));
          }}
        >
          브리핑 사이트 열기
        </button>
      </div>
    </section>
  );
}

import { useCallback, useEffect, useState } from "react";
import type { AutopilotBridge, AutopilotView } from "../../../shared/autopilot";
import { outcomeLabel } from "../../../shared/autopilot";
import { errorMessage } from "../../../shared/lib/errors";
import { Notice, Section, SectionHeader, StatusText } from "../../../shared/ui/primitives";
import { blockedNotice, statusLine } from "../model/notices";
import "./autopilot-today.css";

const projectPrefix = "project:";

/**
 * The one item to look at after work, and how full the queue is. Read-only: it asks the app for the same
 * view `reels autopilot today` prints and starts nothing. Without a bridge (web demo, shared view) it renders nothing.
 */
export function AutopilotToday({ api, revision, onOpenProject }: { api?: AutopilotBridge; revision: string; onOpenProject?: (projectId: string) => void }) {
  const [view, setView] = useState<AutopilotView | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!api) return;
    try { setView(await api.get()); setError(""); } catch (e) { setError(errorMessage(e)); }
  }, [api]);
  // Reads again when the Dashboard changed and when the window comes back, so the card follows CLI runs too.
  useEffect(() => { void load(); }, [load, revision]);
  useEffect(() => {
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);
  if (!api || (!view && !error)) return null;
  const blocked = view ? blockedNotice(view) : null;
  const pick = view?.today ?? null;
  return (
    <Section className="autopilot-today" aria-label="퇴근 후 오늘 볼 1개" data-testid="autopilot-today">
      <SectionHeader level={3} title="퇴근 후 오늘 볼 1개" description={view ? <span data-testid="autopilot-status">{statusLine(view)}{view.enabled ? "" : " · 자동 실행 꺼짐"}</span> : undefined} />
      {error && <Notice tone="warning">오늘 볼 항목을 읽지 못했어요 · {error}</Notice>}
      {blocked && <Notice tone="warning" data-testid="autopilot-blocked">{blocked}</Notice>}
      {view?.paused && <Notice tone="warning" data-testid="autopilot-paused">자동 실행 일시정지 중 · {view.paused.reason}</Notice>}
      {view && (pick ? (
        <div className="autopilot-pick">
          <h4 className="autopilot-pick-title">
            {/^https?:\/\//.test(pick.target)
              ? <a href={pick.target} target="_blank" rel="noreferrer">{pick.title} ↗</a>
              : pick.target.startsWith(projectPrefix) && onOpenProject
                ? <button type="button" className="quiet autopilot-open" onClick={() => onOpenProject(pick.target.slice(projectPrefix.length))}>{pick.title}</button>
                : <span>{pick.title}</span>}
          </h4>
          <dl className="autopilot-facts">
            <dt>왜 지금</dt><dd>{pick.why.join(" · ")}</dd>
            <dt>필요한 한 가지</dt><dd>{pick.decision}</dd>
            <dt>완료 기준</dt><dd>{pick.doneWhen}</dd>
            {pick.outcome && (<><dt>자동 작업</dt><dd>{outcomeLabel[pick.outcome]}{pick.changes?.length ? ` · 변경 ${pick.changes.length}건` : ""}</dd></>)}
          </dl>
        </div>
      ) : (
        <StatusText className="autopilot-none">오늘 볼 항목 없음</StatusText>
      ))}
    </Section>
  );
}

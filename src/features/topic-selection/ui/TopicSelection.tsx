import { useCallback, useEffect, useMemo, useState } from "react";
import type { Project } from "../../../shared/contracts";
import type { Planning, PlanningBridge } from "../../../shared/planning";
import { weeklyGoalsView } from "../../../shared/weekly-goals";
import {
  topicBoard,
  topicGaps,
  type PitchDecision,
  type PitchReadiness,
  type TopicBoardItem,
} from "../../../shared/topic-pitch";
import { errorMessage } from "../../../shared/lib/errors";
import { Badge, Button, Notice, Section, SectionHeader } from "../../../shared/ui/primitives";
import { boardSummary } from "../model/summary";
import "./topic-selection.css";

const readinessTone: Record<PitchReadiness, "primary" | "neutral" | "warning"> = {
  ready: "primary",
  needs_edit: "neutral",
  needs_user: "warning",
  hold: "neutral",
};

/** What the questions mean at each readiness; for needs_user the badge already says it. */
const asksLabel: Record<PitchReadiness, string> = {
  ready: "올리기 전 확인",
  needs_edit: "확인할 것",
  needs_user: "",
  hold: "결정할 것",
};

/** Two-line cover hook, split where the content workspace writes ` / `. */
function CoverHook({ text }: { text: string }) {
  const lines = text.split(/\s+\/\s+/);
  return (
    <span className="topic-hook" aria-label={`표지 훅: ${lines.join(" ")}`}>
      {lines.map((l, i) => (
        <span key={i}>{l}</span>
      ))}
    </span>
  );
}

function TopicRow({
  item,
  onOpenProject,
  onDecide,
  busy,
}: {
  item: TopicBoardItem;
  onOpenProject?: (projectId: string) => void;
  onDecide?: (item: TopicBoardItem, decision: PitchDecision) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const picked = item.decision === "picked";
  const [first, ...others] = item.coverHooks;
  return (
    <li className="topic-row" data-readiness={item.readiness} data-picked={picked ? "" : undefined}>
      <div className="topic-main">
        <div className="topic-title">
          {item.rank !== undefined && <span className="topic-rank">{item.rank}</span>}
          <strong>{item.title}</strong>
          {picked ? <Badge tone="primary">선정</Badge> : <Badge tone={readinessTone[item.readiness]}>{item.readinessLabel}</Badge>}
          <span className="topic-meta">
            {item.channelLabel} · {item.effortLabel} · {item.hookFamily}
          </span>
        </div>
        <CoverHook text={first} />
        {item.asks.length > 0 && (
          <p className="topic-asks" data-readiness={item.readiness}>
            {asksLabel[item.readiness] && <span>{asksLabel[item.readiness]}</span>} {item.asks.join(" · ")}
          </p>
        )}
        {open && (
          <dl className="topic-detail">
            {others.length > 0 && (
              <>
                <dt>다른 표지</dt>
                <dd>{others.map((h, i) => <CoverHook key={`${i}:${h}`} text={h} />)}</dd>
              </>
            )}
            {item.captionHead && (
              <>
                <dt>캡션 첫 줄</dt>
                <dd>{item.captionHead}</dd>
              </>
            )}
            {item.basedOn.length > 0 && (
              <>
                <dt>빌린 훅</dt>
                <dd>
                  <ul>
                    {item.basedOn.map((b, i) => (
                      <li key={`${i}:${b.title}`}>
                        <b>{b.title}</b> — {b.evidence}
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
            <dt>소스</dt>
            <dd>{item.source}</dd>
            {item.hypothesis && (
              <>
                <dt>가설</dt>
                <dd>{item.hypothesis}</dd>
              </>
            )}
            <dt>카드</dt>
            <dd>
              {onOpenProject ? (
                <button type="button" className="quiet weekly-goals-open" onClick={() => onOpenProject(item.projectId)}>
                  {item.projectTitle}
                </button>
              ) : (
                item.projectTitle
              )}
            </dd>
          </dl>
        )}
      </div>
      <div className="topic-actions">
        <Button size="small" variant="quiet" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "접기" : "근거"}
        </Button>
        {onDecide &&
          (picked ? (
            <Button size="small" disabled={busy} onClick={() => onDecide(item, "proposed")}>
              선정 취소
            </Button>
          ) : (
            <>
              <Button size="small" variant="primary" disabled={busy} onClick={() => onDecide(item, "picked")}>
                선정
              </Button>
              <Button size="small" variant="quiet" disabled={busy} onClick={() => onDecide(item, "dropped")}>
                제외
              </Button>
            </>
          ))}
      </div>
    </li>
  );
}

/**
 * What to make next: pitches that cross a proven hook with footage we have, beside the work queue.
 * Picking only records the decision on the pitch; production and channels move on as usual.
 * Without pitches it says where they come from instead of disappearing, so the gap is visible.
 */
export function TopicSelection({
  projects,
  revision,
  planningRevision = 0,
  api,
  onOpenProject,
  onDecide,
}: {
  projects: Project[];
  revision: string;
  /** Bumped when the weekly goals are saved elsewhere, so the gap line follows. */
  planningRevision?: number;
  api?: PlanningBridge;
  onOpenProject?: (projectId: string) => void;
  /** Omitted in read-only views. */
  onDecide?: (projectId: string, pitchId: string, decision: PitchDecision) => Promise<void>;
}) {
  const [planning, setPlanning] = useState<Planning | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!api) return;
    try {
      setPlanning(await api.get());
    } catch {
      setPlanning(null);
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load, revision, planningRevision]);
  const board = useMemo(
    () => topicBoard(projects, planning ? topicGaps(weeklyGoalsView(planning, projects)) : []),
    [projects, planning],
  );
  const decide = onDecide
    ? async (item: TopicBoardItem, decision: PitchDecision) => {
        setBusy(true);
        try {
          await onDecide(item.projectId, item.id, decision);
          setError("");
        } catch (e) {
          setError(errorMessage(e));
        } finally {
          setBusy(false);
        }
      }
    : undefined;
  return (
    <Section className="topic-selection" aria-label="소재 선정" data-testid="topic-selection">
      <SectionHeader level={3} title="소재 선정" description={boardSummary(board)} />
      {error && <Notice tone="danger">결정을 저장하지 못했어요 · {error}</Notice>}
      {board.items.length === 0 ? (
        <p className="topic-empty">
          아직 소재 후보가 없어요. 잘된 훅과 우리 영상 소스를 엮은 드래프트를 에이전트가 MCP <code>reels_set_pitches</code>로 올리면 여기에 보여요.
        </p>
      ) : (
        <ol className="topic-list">
          {board.items.map((item) => (
            <TopicRow key={`${item.projectId}:${item.id}`} item={item} onOpenProject={onOpenProject} onDecide={decide} busy={busy} />
          ))}
        </ol>
      )}
      {board.counts.dropped > 0 && <p className="topic-dropped">제외한 후보 {board.counts.dropped}개는 카드에 기록만 남겨요.</p>}
    </Section>
  );
}

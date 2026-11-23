import { useCallback, useEffect, useMemo, useState } from "react";
import type { Project } from "../../../shared/contracts";
import type { Planning, PlanningBridge } from "../../../shared/planning";
import { weeklyGoalsView } from "../../../shared/weekly-goals";
import {
  topicBoard,
  topicGaps,
  type PitchDecision,
  type TopicBoardItem,
} from "../../../shared/topic-pitch";
import { errorMessage } from "../../../shared/lib/errors";
import { Button, Notice } from "../../../shared/ui/primitives";
import { TopicBoardView } from "../../../../packages/briefing/ui";
import "./topic-selection.css";

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
  return <TopicBoardView
    board={board}
    onOpenProject={onOpenProject}
    notice={error && <Notice tone="danger">결정을 저장하지 못했어요 · {error}</Notice>}
    emptyHint={<>아직 소재 후보가 없어요. 잘된 훅과 우리 영상 소스를 엮은 드래프트를 에이전트가 MCP <code>reels_set_pitches</code>로 올리면 여기에 보여요.</>}
    actions={decide && (item => item.decision === "picked"
      ? <Button size="small" disabled={busy} onClick={() => decide(item, "proposed")}>선정 취소</Button>
      : <><Button size="small" variant="primary" disabled={busy} onClick={() => decide(item, "picked")}>선정</Button>
        <Button size="small" variant="quiet" disabled={busy} onClick={() => decide(item, "dropped")}>제외</Button></>)}
  />;
}

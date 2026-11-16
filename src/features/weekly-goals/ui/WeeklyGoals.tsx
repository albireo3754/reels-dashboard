import { useCallback, useEffect, useMemo, useState } from "react";
import type { Project } from "../../../shared/contracts";
import type { Planning, PlanningBridge } from "../../../shared/planning";
import { addDays } from "../../../shared/planning";
import { goalChannels, goalChannelLabels, weeklyGoalsView, type ChannelQueue, type ChannelWeek, type GoalCandidate, type WeeklyTargets } from "../../../shared/weekly-goals";
import { errorMessage } from "../../../shared/lib/errors";
import { Badge, Button, Notice, Section, SectionHeader } from "../../../shared/ui/primitives";
import { Popover } from "../../../shared/ui/Popover";
import "./weekly-goals.css";

const dayLabel = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", weekday: "short" });
const statusLabel: Record<GoalCandidate["status"], string> = { planned: "예정", draft: "임시저장", reuse: "재업 후보" };

/**
 * This week's goal per channel, what to fill it with, and the two-week booking queue for videos.
 * Read-only on channels: it suggests what to book; booking itself happens on the channel and is then
 * recorded on the project. Without a planning bridge (shared view) it renders nothing.
 */
export function WeeklyGoals({ api, projects, revision, onOpenProject }: { api?: PlanningBridge; projects: Project[]; revision: string; onOpenProject?: (projectId: string) => void }) {
  const [planning, setPlanning] = useState<Planning | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const load = useCallback(async () => {
    if (!api) return;
    try { setPlanning(await api.get()); setError(""); } catch (e) { setError(errorMessage(e)); }
  }, [api]);
  useEffect(() => { void load(); }, [load, revision]);
  useEffect(() => {
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);
  const view = useMemo(() => (planning ? weeklyGoalsView(planning, projects) : null), [planning, projects]);
  if (!api || (!view && !error)) return null;
  const week = view?.thisWeek;
  return (
    <Section className="weekly-goals" aria-label="이번 주 목표" data-testid="weekly-goals">
      <SectionHeader
        level={3}
        title="이번 주 목표"
        description={week ? `${dayLabel(week.from)} – ${dayLabel(addDays(week.to, -1))} · ${week.totals.target}개 중 ${week.totals.done}개 · 남은 ${week.totals.remaining}개` : undefined}
        actions={view && <Button variant="quiet" size="small" onClick={() => setEditing(v => !v)} aria-expanded={editing}>{editing ? "닫기" : "목표 수정"}</Button>}
      />
      {error && <Notice tone="warning">주간 목표를 읽지 못했어요 · {error}</Notice>}
      {view && planning && editing && <TargetEditor api={api} planning={planning} targets={view.targets} onSaved={next => { setPlanning(next); setEditing(false); }} />}
      {week && <div className="weekly-goal-grid">{week.channels.map(c => <ChannelTile key={c.channel} week={c} onOpenProject={onOpenProject} />)}</div>}
      {view && <BookingQueue channels={view.queue.channels} until={view.queue.until} onOpenProject={onOpenProject} />}
    </Section>
  );
}

function ProjectName({ id, title, hint, onOpenProject }: { id: string; title: string; hint?: string; onOpenProject?: (projectId: string) => void }) {
  const tip = hint ? `${title} · ${hint}` : title;
  return onOpenProject
    ? <button type="button" className="quiet weekly-goals-open" title={tip} onClick={() => onOpenProject(id)}>{title}</button>
    : <span title={tip}>{title}</span>;
}

/** One color axis: solid = live, light = booked. */
function Meter({ done, booked, total, label }: { done: number; booked: number; total: number; label: string }) {
  const part = (n: number) => `${total ? Math.min(100, (n / total) * 100) : 0}%`;
  return (
    <div className="weekly-goal-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.min(total, done + booked)}>
      <span className="done" style={{ width: part(done) }} />
      <span className="booked" style={{ width: part(Math.min(booked, Math.max(0, total - done))) }} />
    </div>
  );
}

function ChannelTile({ week, onOpenProject }: { week: ChannelWeek; onOpenProject?: (projectId: string) => void }) {
  const count = week.published + week.scheduled;
  const met = week.target > 0 && week.remaining === 0;
  const fill = week.candidates.slice(0, Math.max(week.remaining, 0));
  return (
    <article className="weekly-goal-tile" aria-label={`${week.label} 이번 주`} data-met={met ? "" : undefined}>
      <header>
        <h4>{week.label}</h4>
        <strong>{count}<small> / {week.target}</small></strong>
      </header>
      <Meter done={week.published} booked={week.scheduled} total={week.target} label={`${week.label} ${count}/${week.target}`} />
      <p className="weekly-goal-meta">
        {week.target === 0 ? "이번 주 목표 없음" : `게시 ${week.published} · 이번 주 예약 ${week.scheduled} · `}
        {week.target > 0 && (met ? <span className="weekly-goal-met">달성</span> : `남은 ${week.remaining}`)}
      </p>
      {week.remaining > 0 && (
        fill.length
          ? <ol className="weekly-goal-fill" aria-label={`${week.label} 채울 것`}>{fill.map(c => (
            <li key={c.projectId}>
              <ProjectName id={c.projectId} title={c.title} hint={c.status === "reuse" ? "인스타 릴스를 클립으로 재업" : statusLabel[c.status]} onOpenProject={onOpenProject} />
              <Badge tone={c.status !== "reuse" && !c.ready ? "warning" : "neutral"}>{c.status === "reuse" ? statusLabel.reuse : c.ready ? "완성본" : "제작 중"}</Badge>
            </li>))}</ol>
          : <p className="weekly-goal-empty">채울 후보 없음 · 새 소재가 필요해요</p>
      )}
    </article>
  );
}

const shownRows = 4;
function QueueRow({ q, onOpenProject }: { q: ChannelQueue; onOpenProject?: (projectId: string) => void }) {
  const [all, setAll] = useState(false);
  const ahead = q.booked.length + q.beyond.length;
  const rows = [...q.booked.map(b => ({ ...b, kind: "booked" as const })), ...q.slots.map(s => ({ ...s, kind: "slot" as const }))]
    .sort((a, b) => a.day.localeCompare(b.day));
  const visible = all ? rows : rows.slice(0, shownRows);
  const left = q.open - q.slots.length;
  return (
    <article className="booking-row" aria-label={`${q.label} 예약`} data-full={q.full ? "" : undefined}>
      <header>
        <h5>{q.label}</h5>
        <span className="booking-count">앞으로 예약 {ahead} / {q.cap}</span>
        <span className="booking-state">{q.cap === 0 ? "목표 없음" : q.full ? "2주치 예약 완료" : `${q.open}개 더 예약 가능`}</span>
      </header>
      <Meter done={0} booked={ahead} total={q.cap} label={`${q.label} 앞으로 예약 ${ahead}/${q.cap}`} />
      {q.beyond.length > 0 && <Notice tone="warning">2주 넘게 앞선 예약 {q.beyond.length}개 · {q.beyond.map(b => `${dayLabel(b.day)} ${b.title}`).join(", ")}</Notice>}
      {rows.length > 0 && <ul className="booking-list">
        {visible.map(row => <li key={`${row.kind}:${row.projectId}`} className={row.kind}><time>{dayLabel(row.day)}</time><ProjectName id={row.projectId} title={row.title} onOpenProject={onOpenProject} />{row.kind === "booked" ? <Badge>예약됨</Badge> : <Badge tone="primary">예약 제안</Badge>}</li>)}
      </ul>}
      {rows.length > shownRows && <Button size="small" className="booking-more" onClick={() => setAll(v => !v)} aria-expanded={all}>{all ? "접기" : `${rows.length - shownRows}개 더 보기`}</Button>}
      {!q.full && q.cap > 0 && left > 0 && (
        <p className="weekly-goal-empty">{q.slots.length < q.ready.length
          ? `나머지 ${left}칸은 2주 안에 남는 날이 없어요`
          : `나머지 ${left}칸은 새 완성본이 생기면 채워져요${q.inProduction ? ` · 제작 중 ${q.inProduction}개` : ""}`}</p>
      )}
    </article>
  );
}

function BookingQueue({ channels, until, onOpenProject }: { channels: ChannelQueue[]; until: string; onOpenProject?: (projectId: string) => void }) {
  return (
    <section className="booking-queue" aria-label="영상 예약 큐">
      <h4>영상 예약 큐 <span>오늘부터 2주 · {dayLabel(addDays(until, -1))}까지 · 완성본 기준</span>
        <Popover label="예약 큐 안내">
          <p className="booking-help">채널마다 주간 목표의 2배(2주치)까지만 예약해 둬요. 완성본을 작업 순서대로 빈 날에 제안하고, 14일 뒤로는 제안하지 않아요. 앱은 채널에 직접 예약·게시하지 않아요. 채널에서 예약한 뒤 프로젝트 게시 상태를 ‘공개 예약’으로 기록하면 ‘예약됨’으로 바뀌어요. 위 타일의 ‘이번 주 예약’은 이번 주 안의 예약(지난 시각 포함), 여기 숫자는 지금 이후 예약이에요.</p>
        </Popover>
      </h4>
      <div className="booking-rows">{channels.map(q => <QueueRow key={q.channel} q={q} onOpenProject={onOpenProject} />)}</div>
    </section>
  );
}

function TargetEditor({ api, planning, targets, onSaved }: { api: PlanningBridge; planning: Planning; targets: WeeklyTargets; onSaved: (next: Planning) => void }) {
  const [draft, setDraft] = useState<WeeklyTargets>(targets);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setBusy(true); setError("");
    try { onSaved(await api.update({ expectedUpdatedAt: planning.updatedAt, weeklyTargets: draft })); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  return (
    <form className="weekly-target-editor" aria-label="주간 목표 수정" onSubmit={e => { e.preventDefault(); void save(); }}>
      {goalChannels.map(channel => (
        <label key={channel}>
          <span>{goalChannelLabels[channel]}</span>
          <input type="number" min={0} max={14} value={draft[channel]} onChange={e => setDraft(d => ({ ...d, [channel]: Math.max(0, Math.min(14, Math.trunc(Number(e.target.value) || 0))) }))} />
          {channel !== "blog" && <small>2주 예약 {draft[channel] * 2}개까지</small>}
        </label>
      ))}
      <Button type="submit" size="small" disabled={busy}>{busy ? "저장 중…" : "저장"}</Button>
      {error && <Notice tone="warning">{error}</Notice>}
    </form>
  );
}

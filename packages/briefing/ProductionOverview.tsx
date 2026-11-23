import type { ReactNode } from "react";

/** The local and synchronized dashboards present the same production workflow. */
export function ProductionOverview({
  weeklyGoals,
  topics,
  today,
}: {
  weeklyGoals: ReactNode;
  topics: ReactNode;
  today: ReactNode;
}) {
  return (
    <>
      {weeklyGoals}
      {topics}
      {today}
    </>
  );
}

export function GoalMeter({
  published,
  scheduled,
  target,
  label,
}: {
  published: number;
  scheduled: number;
  target: number;
  label: string;
}) {
  const done = Math.min(published, target);
  const booked = Math.min(scheduled, target - done);
  const width = (value: number) => `${target ? (value / target) * 100 : 0}%`;
  return (
    <div
      className="weekly-goal-meter goal-meter"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.max(1, target)}
      aria-valuenow={done + booked}
    >
      <span className="done" style={{ width: width(done) }} />
      <i className="booked" style={{ width: width(booked) }} />
    </div>
  );
}

export function WeeklyChannelCard({
  goal,
  period,
  meterLabel,
  children,
}: {
  goal: {
    label: string;
    target: number;
    published: number;
    scheduled: number;
    remaining: number;
  };
  period: string;
  meterLabel: string;
  children: ReactNode;
}) {
  const total = goal.published + goal.scheduled;
  const met = goal.target > 0 && goal.remaining === 0;
  return (
    <article
      className="weekly-goal-tile goal-tile"
      aria-label={`${goal.label} ${period}`}
      data-met={met ? "" : undefined}
    >
      <header className="goal-heading">
        <h4>{goal.label}</h4>
        <strong>
          {total}
          <small> / {goal.target}</small>
        </strong>
      </header>
      <GoalMeter
        published={goal.published}
        scheduled={goal.scheduled}
        target={goal.target}
        label={meterLabel}
      />
      <p className="weekly-goal-meta muted">
        {goal.target === 0 ? (
          "목표 없음"
        ) : (
          <>
            게시 {goal.published} ·{" "}
            {period === "이번 주" ? "이번 주 예약" : "예약"} {goal.scheduled} ·{" "}
            {met ? (
              <span className="weekly-goal-met">달성</span>
            ) : (
              `남은 ${goal.remaining}`
            )}
          </>
        )}
      </p>
      {children}
    </article>
  );
}

type TodayPick = {
  title: string;
  target: string;
  why: readonly string[];
  decision: string;
  doneWhen: string;
  outcome: string | null;
  changeCount: number;
};

export function TodayPickView({
  pick,
  onOpenProject,
  heading: Heading,
}: {
  pick: TodayPick;
  onOpenProject?: (id: string) => void;
  heading: "h3" | "h4";
}) {
  const project = pick.target.startsWith("project:");
  return (
    <div className="autopilot-pick">
      <Heading className="autopilot-pick-title">
        {project && onOpenProject ? (
          <button
            type="button"
            className="today-title quiet autopilot-open"
            onClick={() => onOpenProject(pick.target.slice(8))}
          >
            {pick.title}
          </button>
        ) : /^https?:\/\//.test(pick.target) ? (
          <a
            className="today-title"
            href={pick.target}
            target="_blank"
            rel="noreferrer"
          >
            {pick.title}
          </a>
        ) : (
          pick.title
        )}
      </Heading>
      <dl className="autopilot-facts today-facts">
        <dt>왜 지금</dt>
        <dd>{pick.why.join(" · ")}</dd>
        <dt>필요한 한 가지</dt>
        <dd>{pick.decision}</dd>
        <dt>완료 기준</dt>
        <dd>{pick.doneWhen}</dd>
        {pick.outcome && (
          <>
            <dt>자동 작업</dt>
            <dd>
              {pick.outcome}
              {pick.changeCount > 0 && ` · 변경 ${pick.changeCount}건`}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

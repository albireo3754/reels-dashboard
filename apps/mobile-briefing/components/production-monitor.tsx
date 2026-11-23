import {
  ProductionOverview,
  TodayPickView,
  WeeklyChannelCard,
} from "@briefing/ui";
import { ChevronDown, Send } from "lucide-react";
import {
  phaseLabels,
  thirdWeekGoals,
  type Monitor,
  type Progress,
} from "../lib/monitor";
import { TopicSelection } from "./topic-selection";
import { PaseoRequestCopy } from "./paseo-request-copy";
import { validPaseoTarget } from "../lib/paseo-request.mjs";
const day = (s: string) =>
  new Date(s + "T12:00:00Z").toLocaleDateString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  });
type Goal = Monitor["thisWeek"]["channels"][number];
type Week = Omit<Monitor["thisWeek"], "channels"> & {
  channels: (Omit<Goal, "candidates"> & {
    candidates: (Goal["candidates"][number] & {
      phase?: keyof typeof phaseLabels;
    })[];
  })[];
};
type OpenProject = (id: string) => void;

function WeekSummary({ week }: { week: Week }) {
  return (
    <span className="muted week-dates">
      {day(week.from)}부터 7일 · {week.totals.target}개 중 {week.totals.done}개
      · 남은 {week.totals.remaining}개
    </span>
  );
}

function WeekGoals({
  week,
  title,
  onOpen,
  partialCandidates = false,
}: {
  week: Week;
  title: string;
  onOpen: OpenProject;
  partialCandidates?: boolean;
}) {
  return (
    <div className="goal-grid">
      {week.channels.map((c) => {
        return (
          <WeeklyChannelCard
            key={c.channel}
            goal={c}
            period={title}
            meterLabel={`${c.label} 목표 진행`}
          >
            {c.candidates.length > 0 ? (
              <ul className="goal-candidates">
                {c.candidates.map((p) => (
                  <li key={p.projectId}>
                    <button onClick={() => onOpen(p.projectId)}>
                      {p.title}
                    </button>
                    <span>
                      {p.phase
                        ? phaseLabels[p.phase]
                        : p.status === "reuse"
                          ? "재업 후보"
                          : p.ready
                            ? "완성본"
                            : "제작 중"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              c.remaining > 0 && (
                <p className="muted goal-empty">
                  {partialCandidates
                    ? "표시할 예약 제안 없음"
                    : "채울 후보 없음"}
                </p>
              )
            )}
          </WeeklyChannelCard>
        );
      })}
    </div>
  );
}

function UpcomingWeek({
  week,
  title,
  onOpen,
  forecast = false,
}: {
  week: Week;
  title: string;
  onOpen: OpenProject;
  forecast?: boolean;
}) {
  return (
    <details className="upcoming-week">
      <summary>
        <span>
          <strong>{title}</strong>
          <WeekSummary week={week} />
        </span>
        <ChevronDown size={17} aria-hidden="true" />
      </summary>
      {forecast && (
        <p className="muted week-forecast">
          채널별 목표는 2주차 기준이에요. 후보는 날짜가 잡힌 예약 제안만
          표시돼요.
        </p>
      )}
      <WeekGoals
        week={week}
        title={title}
        onOpen={onOpen}
        partialCandidates={forecast}
      />
    </details>
  );
}

export function ProductionMonitor({
  monitor,
  contents,
  syncedAt = null,
  onOpen,
  onInstruct,
}: {
  monitor: Monitor | null;
  contents: readonly Progress[];
  syncedAt?: string | null;
  onOpen: OpenProject;
  onInstruct?: (target: string) => void;
}) {
  if (!monitor)
    return (
      <p className="notice">
        제작 요약을 기다리고 있어요. Mac에서 다음 동기화가 끝나면 주간 목표와
        오늘 볼 항목이 표시돼요.
      </p>
    );
  const thirdWeek = thirdWeekGoals(monitor, contents);
  const a = monitor.autopilot,
    pick = a.today;
  return (
    <ProductionOverview
      weeklyGoals={
        <section className="monitor-section" aria-label="주간 게시 목표">
          <div className="section-heading">
            <div>
              <h2>이번 주 목표</h2>
              <WeekSummary week={monitor.thisWeek} />
            </div>
          </div>
          <WeekGoals
            week={monitor.thisWeek}
            title="이번 주 목표"
            onOpen={onOpen}
          />
          <div className="upcoming-weeks">
            <UpcomingWeek
              week={monitor.nextWeek}
              title="2주차 목표"
              onOpen={onOpen}
            />
            {thirdWeek && (
              <UpcomingWeek
                week={thirdWeek}
                title="3주차 목표"
                onOpen={onOpen}
                forecast
              />
            )}
          </div>
          <details className="booking-queue">
            <summary>
              게시 2주 예약 현황{" "}
              <span>
                {monitor.queue.channels.reduce((n, c) => n + c.booked, 0)}개
                예약 <ChevronDown size={15} />
              </span>
            </summary>
            <p className="muted">
              {day(monitor.queue.until)} 전까지 · 예약 제안은 아직 채널에 등록된
              일정이 아니에요.
            </p>
            <div className="queue-grid">
              {monitor.queue.channels.map((c) => (
                <article key={c.channel}>
                  <h3>
                    {c.label}{" "}
                    <small>
                      {c.booked} / {c.cap}
                    </small>
                  </h3>
                  <p className="muted">
                    {c.cap === 0
                      ? "목표 없음"
                      : c.full
                        ? "2주치 예약 완료"
                        : `${c.open}개 더 예약 가능`}{" "}
                    · 제작 중 {c.inProduction}
                  </p>
                  {c.rows.length ? (
                    <ul>
                      {c.rows.map((p) => (
                        <li key={p.projectId}>
                          <span>
                            {day(p.day)} ·{" "}
                            {p.status === "scheduled" ? "예약" : "제안"}
                            {p.phase ? ` · ${phaseLabels[p.phase]}` : ""}
                          </span>
                          <button onClick={() => onOpen(p.projectId)}>
                            {p.title}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">예약된 영상이나 완성 후보가 없어요.</p>
                  )}
                </article>
              ))}
            </div>
          </details>
        </section>
      }
      topics={<TopicSelection board={monitor.topics} />}
      today={
        <section
          className="monitor-section today-panel"
          aria-label="퇴근 후 오늘 볼 1개"
        >
          <div className="section-heading">
            <div>
              <h2>퇴근 후 오늘 볼 1개</h2>
              <p className="muted">
                {a.status}
                {!a.enabled ? " · 자동 실행 꺼짐" : ""}
              </p>
            </div>
          </div>
          {a.notice && <p className="notice">{a.notice}</p>}
          {a.paused && <p className="notice">자동 실행 일시정지 중</p>}
          {pick ? (
            <>
              <TodayPickView heading="h3" pick={pick} onOpenProject={onOpen} />
              {onInstruct && validPaseoTarget(pick.target) && (
                <button
                  type="button"
                  className="instruct-button today-instruct"
                  onClick={() => onInstruct(pick.target)}
                >
                  <Send size={15} /> 이 항목으로 지시
                </button>
              )}
              <details className="paseo-direct">
                <summary>Paseo로 직접 이어가기</summary>
                <PaseoRequestCopy
                  key={`${pick.target}|${syncedAt ?? monitor.generatedAt}`}
                  target={pick.target}
                  basisAt={syncedAt ?? monitor.generatedAt}
                />
              </details>
            </>
          ) : (
            <p className="muted">오늘 볼 항목 없음</p>
          )}
        </section>
      }
    />
  );
}

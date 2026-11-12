import { useCallback, useEffect, useState } from "react";
import type { Project } from "../../../shared/contracts";
import { addDays, emptyPlanning, monday, weekPlan, type Planning, type PlanningBridge } from "../../../shared/planning";
import { errorMessage } from "../../../shared/lib/errors";
import "./publication-calendar.css";

const stamp = (value: string) => new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const time = (value: string) => new Date(value).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false });
const dayLabel = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", weekday: "short" });
export function PublicationCalendar({ api, projects }: { api?: PlanningBridge; projects: Project[] }) {
  const [data, setData] = useState<Planning>(emptyPlanning);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const channel = "naver-clip" as const;
  const refresh = useCallback(async () => {
    if (!api) return;
    setBusy(true); setError("");
    try { setData(await api.get()); } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);
  const first = addDays(monday(new Date()), offset * 7);
  return <section className="publication-calendar" aria-label="게시 캘린더">
    <header className="calendar-heading"><div><h2>캘린더</h2><p>주간 목표와 게시 일정 · 한국시간 · 월요일 시작</p></div>
      <div className="calendar-actions">
        <a href={data.calendar?.url ?? "https://calendar.google.com/calendar/u/0/r/week"} target="_blank" rel="noreferrer">Google Calendar 열기 ↗</a>
        <a href={data.linear?.url ?? "https://linear.app"} target="_blank" rel="noreferrer">Linear 열기 ↗</a>
        <button onClick={() => void refresh()} disabled={busy || !api}>{busy ? "불러오는 중…" : "새로고침"}</button>
      </div>
    </header>
    {error && <p role="alert">{error}</p>}
    {!api && <p role="status">외부 일정은 데스크톱 앱에서 연결해요. 공유 화면에는 개인 일정을 포함하지 않아요.</p>}
    <div className="calendar-source-status">
      <span>Google Calendar · {data.calendar ? `${stamp(data.calendar.syncedAt)}에 가져옴` : "연결된 일정 없음"}</span>
      <span>Linear · {data.linear ? `${stamp(data.linear.syncedAt)}에 가져옴` : "연결 후 할 일을 가져올 수 있어요"}</span>
    </div>
    <p className="calendar-help">일정은 Google Calendar에서, 할 일은 Linear에서 수정해요. 연결 세션에서 가져온 결과를 표시하며 실시간 자동 동기화는 하지 않아요.</p>
    <div className="calendar-controls">
      <div><button aria-label="이전 주" onClick={() => setOffset(v => v - 1)}>←</button><button onClick={() => setOffset(0)}>이번 주</button><button aria-label="다음 주" onClick={() => setOffset(v => v + 1)}>→</button></div>
      <span>네이버클립 · 주 {data.weeklyTarget}개 목표</span>
    </div>
    {[0, 1].map(index => {
      const week = weekPlan(data, projects, addDays(first, index * 7), channel);
      const label = offset === 0 ? (index ? "다음 주" : "이번 주") : `${dayLabel(week.from)} 주간`;
      return <article className="calendar-week" key={week.from} aria-label={label}>
        <header><div><h3>{label}</h3><p>{dayLabel(week.from)} – {dayLabel(addDays(week.to, -1))}</p></div><div className="calendar-goal"><strong>{week.published + week.scheduled} / {data.weeklyTarget}</strong><span>게시 {week.published} · 예정 {week.scheduled} · {week.covered ? `남은 ${week.remaining}개` : "예정 일정 미확인"}</span></div></header>
        {!week.covered && <p className="calendar-coverage">이 주 전체의 Google Calendar 조회 결과가 없어요. 목표 잔여량은 동기화 후 확인해요.</p>}
        <div className="calendar-days">{Array.from({ length: 7 }, (_, day) => {
          const date = addDays(week.from, day);
          return <section key={date} aria-label={dayLabel(date)}><h4>{dayLabel(date)}</h4>{week.posts.filter(p => p.day === date).map(post => <div className={`calendar-post ${post.status}`} key={post.key}>
            <small>{post.status === "published" ? "게시 완료" : `${post.start ? time(post.start) : ""} 예정`}</small>
            {post.url ? <a href={post.url} target="_blank" rel="noreferrer">{post.title} ↗</a> : <span>{post.title}</span>}
          </div>)}</section>;
        })}</div>
        <div className="calendar-tasks"><h4>Linear 할 일</h4>{week.issues.length ? <ul>{week.issues.map(issue => <li key={issue.id}><a href={issue.url} target="_blank" rel="noreferrer">{issue.identifier} · {issue.title} ↗</a><span>{issue.state === "completed" ? "완료" : issue.state === "started" ? "진행 중" : "할 일"} · {issue.dueDate}</span></li>)}</ul> : <p>{data.linear ? "가져온 할 일 중 이 주 마감인 항목이 없어요." : "Linear 연결 대기 중이에요."}</p>}</div>
      </article>;
    })}
  </section>;
}

import type { ChannelQueue, ChannelWeek, WeekGoals } from "../../../shared/weekly-goals";
import type { RecentPost, ReportChannel, ReportGroup, ReportProject, StatusReport } from "./report";

/**
 * One self-contained HTML file: inline CSS, no script that runs, no external request. The report is
 * also embedded as JSON (`#reels-status-report`) so another session can read the same numbers.
 * `statusReportMarker` marks a file this command wrote, so `reels report` only ever overwrites its own.
 */
export const statusReportMarker = "reels-dashboard-status-report";

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** JSON inside <script> must never close the element or open a comment. */
const scriptJson = (value: unknown) =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const safeUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
};
const link = (text: string, url: string | undefined) => {
  const href = url ? safeUrl(url) : null;
  return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(text)}</a>` : escapeHtml(text);
};

const seoul = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", ...options });
const stampFormat = seoul({ year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const shortFormat = seoul({ month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayFormat = seoul({ month: "numeric", day: "numeric", weekday: "short" });
/** "2026. 11. 17. 09:34" style, Seoul time. */
export const stamp = (iso: string | undefined) => (iso && Number.isFinite(Date.parse(iso)) ? stampFormat.format(new Date(iso)) : "없음");
const when = (iso: string) => shortFormat.format(new Date(iso));
/** A calendar day (YYYY-MM-DD) as "11. 17. (화)". Noon UTC keeps it on the same Seoul day. */
const day = (value: string) => dayFormat.format(new Date(`${value}T12:00:00Z`));

const channelChip = (c: ReportChannel) => {
  const at = c.at ? (c.status === "scheduled" ? ` ${when(c.at)}` : ` ${day(c.at)}`) : "";
  const cls = c.overdue ? "chip warn" : c.status === "published" ? "chip done" : "chip";
  const text = `${c.label} · ${c.statusLabel}${at}${c.overdue ? " · 시각 지남" : ""}`;
  return `<span class="${cls}">${link(text, c.url)}</span>`;
};
const channels = (list: ReportChannel[]) => (list.length ? list.map(channelChip).join(" ") : `<span class="muted">채널 미지정</span>`);
const nextAction = (text: string) => (text ? escapeHtml(text) : `<span class="muted">미정</span>`);

function projectRows(projects: ReportProject[], withPriority: boolean) {
  return projects
    .map(
      (p) => `<tr>
${withPriority ? `<td class="num">${p.priority ?? ""}</td>` : ""}<td class="title"><strong>${escapeHtml(p.title)}</strong><div class="meta">${escapeHtml(p.kind)} · ${escapeHtml(p.stageLabel)} · ${escapeHtml(p.date)}</div></td>
<td class="state"><span class="state-${p.state}">${escapeHtml(p.stateLabel)}</span></td>
<td>${channels(p.channels)}</td>
<td class="next">${nextAction(p.nextAction)}</td>
</tr>`,
    )
    .join("\n");
}

function groupSection(group: ReportGroup) {
  if (!group.projects.length && group.id !== "ordered") return "";
  const ordered = group.id === "ordered";
  const table = group.projects.length
    ? `<table><thead><tr>${ordered ? `<th class="num">순번</th>` : ""}<th>프로젝트</th><th>상태</th><th>채널</th><th>다음 할 일</th></tr></thead>
<tbody>
${projectRows(group.projects, ordered)}
</tbody></table>`
    : `<p class="muted">순번이 붙은 미완료 프로젝트가 없어요.</p>`;
  const heading = `${escapeHtml(group.title)} <span class="count">${group.projects.length}</span>`;
  // Long lists that need no decision start folded so the page reads top to bottom.
  if (group.id === "in_progress" || group.id === "scheduled")
    return `<section id="group-${group.id}"><details><summary><h2>${heading}</h2></summary><p class="note">${escapeHtml(group.note)}</p>${table}</details></section>`;
  return `<section id="group-${group.id}"><h2>${heading}</h2><p class="note">${escapeHtml(group.note)}</p>${table}</section>`;
}

function todaySection(report: StatusReport) {
  const auto = report.autopilot;
  if (!auto) return `<section id="today"><h2>오늘 할 일</h2><p class="muted">autopilot 상태를 읽지 못했어요.</p></section>`;
  const pick = auto.today;
  const body = pick
    ? `<p class="pick"><strong>${escapeHtml(pick.title)}</strong> <span class="chip">${pick.kind === "review" ? "검토" : "진행"}</span></p>
<dl>
<dt>할 일</dt><dd>${escapeHtml(pick.decision)}</dd>
<dt>끝나는 기준</dt><dd>${escapeHtml(pick.doneWhen)}</dd>
<dt>고른 이유</dt><dd>${escapeHtml(pick.why.join(" · "))}</dd>
</dl>`
    : `<p class="muted">지금 사람이 볼 항목이 없어요.</p>`;
  const state = auto.paused ? "일시정지" : auto.enabled ? "켜짐" : "꺼짐";
  return `<section id="today"><h2>오늘 할 일</h2>${body}
<p class="meta">autopilot ${state} · 리뷰 대기 ${auto.counts.review} · 진행 ${auto.counts.active} · 후보 ${auto.counts.candidates}</p></section>`;
}

function summarySection(report: StatusReport) {
  const c = report.counts;
  const tile = (label: string, value: number, hint: string, href: string) =>
    `<a class="tile" href="${href}"><span class="value">${value}</span><span class="label">${escapeHtml(label)}</span><span class="hint">${escapeHtml(hint)}</span></a>`;
  return `<section id="summary" class="tiles">
${tile("사람이 볼 것", c.needsUser, `검토 대기 ${c.review} · 채널 남음 ${c.channel_pending}`, "#group-ordered")}
${tile("진행 중", c.in_progress, "아이디어~편집", "#group-in_progress")}
${tile("공개 예약 대기", c.scheduled, "채널 예약 완료", "#group-scheduled")}
${tile("완료", c.complete, `전체 ${c.total}개 중`, "#recent")}
</section>`;
}

function goalRow(channel: ChannelWeek) {
  const filled = channel.published + channel.scheduled;
  const pct = channel.target ? Math.min(100, Math.round((Math.min(filled, channel.target) / channel.target) * 100)) : 100;
  const posts = channel.posts.map((p) => `${day(p.day)} ${link(p.title, p.status === "published" ? p.url : undefined)}${p.status === "published" ? "" : " (예약)"}`);
  const fill = channel.remaining
    ? channel.candidates.slice(0, channel.remaining).map((c) => `${escapeHtml(c.title)} <span class="muted">${c.status === "reuse" ? "재업 후보" : c.ready ? "완성본" : "제작 중"}</span>`)
    : [];
  return `<tr>
<td><strong>${escapeHtml(channel.label)}</strong></td>
<td class="num">${filled} / ${channel.target}<div class="bar"><span style="width:${pct}%"></span></div></td>
<td class="num">${channel.remaining}</td>
<td>${posts.length ? posts.join("<br>") : `<span class="muted">없음</span>`}</td>
<td>${channel.remaining ? (fill.length ? fill.join("<br>") : `<span class="muted">채울 후보 없음</span>`) : `<span class="muted">채움</span>`}</td>
</tr>`;
}

function weekTable(title: string, week: WeekGoals) {
  return `<h3>${escapeHtml(title)} <span class="meta">${day(week.from)} ~ ${day(addDay(week.to, -1))} · ${week.totals.done} / ${week.totals.target}, 남은 ${week.totals.remaining}${week.calendarCovered ? "" : " · 캘린더 미조회"}</span></h3>
<table><thead><tr><th>채널</th><th class="num">게시+예약 / 목표</th><th class="num">남음</th><th>게시·예약</th><th>채울 것</th></tr></thead>
<tbody>
${week.channels.map(goalRow).join("\n")}
</tbody></table>`;
}
const addDay = (value: string, count: number) => {
  const d = new Date(`${value}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + count);
  return d.toISOString().slice(0, 10);
};

function queueColumn(q: ChannelQueue) {
  const booked = q.booked.map((b) => `<li>${when(b.at)} ${escapeHtml(b.title)}</li>`);
  const slots = q.slots.map((s) => `<li class="suggest">${day(s.day)} ${escapeHtml(s.title)} <span class="muted">제안</span></li>`);
  const beyond = q.beyond.map((b) => `<li class="warn">${when(b.at)} ${escapeHtml(b.title)} <span class="muted">2주 밖</span></li>`);
  const status = q.full ? "2주치 예약 완료" : `빈칸 ${q.open} · 완성본 대기 ${q.ready.length} · 제작 중 ${q.inProduction}`;
  return `<div class="queue"><h4>${escapeHtml(q.label)} <span class="meta">${q.booked.length + q.beyond.length} / ${q.cap}</span></h4>
<p class="meta">${escapeHtml(status)}</p>
${booked.length + slots.length + beyond.length ? `<ul>${[...booked, ...slots, ...beyond].join("")}</ul>` : `<p class="muted">예약 없음</p>`}</div>`;
}

function goalsSection(report: StatusReport) {
  const { thisWeek, nextWeek, queue } = report.goals;
  return `<section id="goals"><h2>주간 목표</h2>
${weekTable("이번 주", thisWeek)}
${weekTable("다음 주", nextWeek)}
<h3>영상 예약 큐 <span class="meta">오늘부터 ${queue.horizonDays}일</span></h3>
<div class="queues">${queue.channels.map(queueColumn).join("\n")}</div>
</section>`;
}

function recentSection(recent: RecentPost[]) {
  const rows = recent.map((p) => `<li>${day(p.day)} <span class="chip done">${escapeHtml(p.label)}</span> ${link(p.title, p.url)}</li>`);
  return `<section id="recent"><h2>최근 게시 <span class="count">${recent.length}</span></h2><p class="note">최근 14일 동안 게시 완료로 기록된 채널이에요.</p>
${rows.length ? `<ul class="plain">${rows.join("\n")}</ul>` : `<p class="muted">없음</p>`}</section>`;
}

const css = `
:root{--bg:#fff;--muted-bg:#f7f7f5;--sunken:#f1f1ef;--border:#e9e9e7;--text:#37352f;--muted:#6b6a66;--subtle:#72716c;--primary:#386354;--primary-soft:#e5ece8;--warn:#9a5b00;--warn-soft:#fdf3e1}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard",sans-serif}
main{max-width:1180px;margin:0 auto;padding:32px 24px 64px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:0 0 6px;display:inline-block}h3{font-size:15px;margin:20px 0 8px}h4{font-size:14px;margin:0 0 4px}
section{padding:24px 0;border-top:1px solid var(--border)}header{padding-bottom:20px}
.meta,.note,.muted{color:var(--subtle);font-weight:400}.meta{font-size:12px}.note{margin:0 0 12px;font-size:13px}
.count{color:var(--subtle);font-weight:400;font-size:14px;margin-left:4px}
a{color:var(--primary)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;vertical-align:top;padding:8px 10px 8px 0;border-bottom:1px solid var(--border)}
th{font-size:12px;color:var(--subtle);font-weight:500}td.num,th.num{text-align:right;white-space:nowrap;width:1%}
td.title{min-width:200px}td.state{white-space:nowrap}td.next{min-width:260px}
.chip{display:inline-block;background:var(--sunken);border-radius:4px;padding:0 6px;margin:0 2px 2px 0;font-size:12px;white-space:nowrap}
.chip.done{background:var(--primary-soft)}.chip.warn,.warn{background:var(--warn-soft);color:var(--warn)}
.chip a{color:inherit}
.state-review,.state-channel_pending{font-weight:600}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:24px}
.tile{display:flex;flex-direction:column;text-decoration:none;color:inherit}.tile .value{font-size:28px;font-weight:600}.tile .label{font-weight:600}.tile .hint{font-size:12px;color:var(--subtle)}
.bar{height:4px;background:var(--sunken);border-radius:2px;margin-top:4px;min-width:80px}.bar span{display:block;height:100%;background:var(--primary);border-radius:2px}
.queues{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}.queue ul{margin:6px 0 0;padding-left:18px}.queue li.suggest{color:var(--muted)}
ul.plain{list-style:none;padding:0;margin:0}ul.plain li{padding:4px 0}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:8px 0}dt{color:var(--subtle)}dd{margin:0}
.pick{font-size:16px;margin:4px 0}
details>summary{cursor:pointer;list-style:none}details>summary::-webkit-details-marker{display:none}details>summary h2::after{content:" ▸";color:var(--subtle)}details[open]>summary h2::after{content:" ▾"}
.warnings li{background:var(--warn-soft);color:var(--warn);padding:4px 8px;border-radius:4px;margin-bottom:4px;list-style:none}.warnings ul{padding:0}
footer{padding-top:24px;border-top:1px solid var(--border);font-size:12px;color:var(--subtle)}
code{background:var(--muted-bg);padding:1px 4px;border-radius:3px}
@media (max-width:900px){.tiles{grid-template-columns:repeat(2,1fr)}.queues{grid-template-columns:1fr}table{display:block;overflow-x:auto}}
@media print{section{break-inside:avoid-page}}
`;

export function renderStatusReportHtml(report: StatusReport): string {
  const s = report.sources;
  const warnings = report.warnings.length
    ? `<section id="warnings" class="warnings"><h2>확인할 것</h2><ul>${report.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul></section>`
    : "";
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="${statusReportMarker}">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'">
<title>릴스 대시보드 현황 · ${escapeHtml(report.today)}</title>
<style>${css}</style>
</head>
<body>
<main>
<header>
<h1>릴스 대시보드 현황</h1>
<p class="meta">${escapeHtml(stamp(report.generatedAt))} 기준 · Dashboard 저장 ${escapeHtml(stamp(s.dashboardUpdatedAt))} · 캘린더 조회 ${escapeHtml(stamp(s.calendarSyncedAt))} · Linear 조회 ${escapeHtml(stamp(s.linearSyncedAt))}</p>
<p class="meta">읽기 전용 사본이에요. 상태를 바꾸려면 앱이나 <code>reels</code> CLI를 쓰고, 다시 만들려면 <code>reels report</code>를 실행하세요.</p>
</header>
${warnings}
${todaySection(report)}
${summarySection(report)}
${goalsSection(report)}
${report.groups.map(groupSection).join("\n")}
${recentSection(report.recent)}
<footer>프로젝트 ${report.counts.total}개 · 보고서 형식 v${report.version} · 아래 JSON(<code>#reels-status-report</code>)에 같은 내용이 있어요.</footer>
</main>
<script type="application/json" id="reels-status-report">${scriptJson(report)}</script>
</body>
</html>
`;
}

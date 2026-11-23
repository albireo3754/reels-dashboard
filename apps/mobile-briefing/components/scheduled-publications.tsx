import {channelLabels, type Monitor, type Progress} from '../lib/monitor';

type Content = Progress & {id: string; title: string};
type Reservation = {
 projectId: string;
 title: string;
 channel: keyof typeof channelLabels;
 scheduledAt?: string;
 day?: string;
 format?: 'long' | 'shorts';
};
const seoulDay = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'});
const dateLabel = new Intl.DateTimeFormat('ko-KR', {timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'short'});
const timeLabel = new Intl.DateTimeFormat('ko-KR', {timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false});

export function ScheduledPublications({contents, monitor, onOpen}: {
 contents: readonly Content[];
 monitor: Monitor | null;
 onOpen: (id: string) => void;
}) {
 const reservations = new Map<string, Reservation>();
 const byId = new Map(contents.map(content => [content.id, content]));
 for (const channel of monitor?.queue.channels ?? []) {
  for (const row of channel.rows) {
   const publication = byId.get(row.projectId)?.publications?.find(p => p.channel === channel.channel);
   if (row.status !== 'scheduled' || (publication && publication.status !== 'scheduled')) continue;
   reservations.set(`${row.projectId}:${channel.channel}`, {...row, channel: channel.channel});
  }
 }
 for (const content of contents) {
  for (const publication of content.publications ?? []) {
   if (publication.status !== 'scheduled') continue;
   const key = `${content.id}:${publication.channel}`;
   reservations.set(key, {...reservations.get(key), ...publication, projectId: content.id, title: content.title});
  }
 }
 const rows = [...reservations.values()].map(row => ({
  ...row,
  day: row.scheduledAt ? seoulDay.format(new Date(row.scheduledAt)) : row.day,
 })).sort((a, b) => (a.day ?? '9999').localeCompare(b.day ?? '9999') ||
  (a.scheduledAt ? Date.parse(a.scheduledAt) : Infinity) - (b.scheduledAt ? Date.parse(b.scheduledAt) : Infinity) || a.title.localeCompare(b.title, 'ko'));
 const now = new Date();
 const today = seoulDay.format(now);
 const todayCount = rows.filter(row => row.day === today).length;
 return <section className="scheduled-panel" aria-labelledby="scheduled-heading">
  <div className="scheduled-heading">
   <div><h2 id="scheduled-heading">공개 예약 <strong>{rows.length}건</strong></h2><p>오늘 {todayCount}건 · 한국 시간 기준</p></div>
  </div>
  {rows.length > 0 ? <ul className="scheduled-list">{rows.map(row => {
   const overdue = row.scheduledAt ? Date.parse(row.scheduledAt) <= now.getTime() : !!row.day && row.day < today;
   return <li key={`${row.projectId}:${row.channel}`}>
    <div className="scheduled-when">
     <span>{row.day ? `${row.day === today ? '오늘 · ' : ''}${dateLabel.format(new Date(row.day + 'T12:00:00+09:00'))}` : '날짜 미등록'}</span>
     <strong>{row.scheduledAt ? timeLabel.format(new Date(row.scheduledAt)) : '시간 미등록'}</strong>
    </div>
    <div className="scheduled-content">
     <span className="scheduled-channel">{channelLabels[row.channel]}{row.channel === 'youtube' && row.format ? ` · ${row.format === 'shorts' ? '쇼츠' : '본편'}` : ''}</span>
     {byId.has(row.projectId) ? <button onClick={() => onOpen(row.projectId)}>{row.title}</button> : <strong>{row.title}</strong>}
     <span className={overdue ? 'scheduled-overdue' : 'scheduled-status'}>{overdue ? '예약 시각 경과 · 공개 여부 확인 필요' : '공개 예약'}</span>
    </div>
   </li>;
  })}</ul> : <p className="scheduled-empty">현재 동기화된 기록에 공개 예약이 없어요.</p>}
 </section>;
}

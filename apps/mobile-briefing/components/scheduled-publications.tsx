import {channelLabels, type Monitor} from '../lib/monitor';

const seoulDay = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'});
const dateLabel = new Intl.DateTimeFormat('ko-KR', {timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'short'});
const timeLabel = new Intl.DateTimeFormat('ko-KR', {timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false});

export function ScheduledPublications({contents, monitor, onOpen}: {
 contents: readonly {id: string}[];
 monitor: Monitor | null;
 onOpen: (id: string) => void;
}) {
 const rows = monitor?.reservations;
 if (!rows) return <p className="notice">대시보드의 예약 목록을 기다리고 있어요.</p>;
 const projectIds = new Set(contents.map(content => content.id));
 const today = seoulDay.format(new Date());
 const todayCount = rows.filter(row => row.day === today).length;
 return <section className="scheduled-panel" aria-labelledby="scheduled-heading">
  <div className="scheduled-heading">
   <div><h2 id="scheduled-heading">공개 예약 <strong>{rows.length}건</strong></h2><p>오늘 {todayCount}건 · 한국 시간 기준</p></div>
  </div>
  {rows.length > 0 ? <ul className="scheduled-list">{rows.map(row => <li key={`${row.projectId}:${row.channel}`}>
    <div className="scheduled-when">
     <span>{row.day === today ? '오늘 · ' : ''}{dateLabel.format(new Date(row.at))}</span>
     <strong>{timeLabel.format(new Date(row.at))}</strong>
    </div>
    <div className="scheduled-content">
     <span className="scheduled-channel">{channelLabels[row.channel]}</span>
     {projectIds.has(row.projectId) ? <button onClick={() => onOpen(row.projectId)}>{row.title}</button> : <strong>{row.title}</strong>}
     <span className="scheduled-status">공개 예약</span>
    </div>
   </li>)}</ul> : <p className="scheduled-empty">현재 동기화된 기록에 공개 예약이 없어요.</p>}
 </section>;
}

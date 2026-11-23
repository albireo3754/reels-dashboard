import { projectStates } from "@briefing/model";
export { projectStateLabels as stateLabels } from "@briefing/model";
import {z} from 'zod';
import {sourceBoardSchema} from "./source-board";
import {topicBoardSchema} from './topic-board';
const text=(max=2000)=>z.string().max(max);
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const count=z.number().int().min(0).max(10000);
const channel=z.enum(['blog','naver-clip','instagram','youtube']);
export const channelLabels={blog:'블로그','naver-clip':'네이버클립',instagram:'인스타그램',youtube:'유튜브'} as const;
export const statusLabels={planned:'예정',draft:'임시저장',scheduled:'공개 예약',published:'게시 완료'} as const;
export const phaseLabels={draft:'임시저장',final:'완성본',review:'검토 대기',production:'제작 중',reuse:'재업 후보'} as const;
const state=z.enum(projectStates);
const url=text(2048).refine(v=>!v||/^https?:\/\//.test(v));
export const progressShape={
 kind:z.enum(['content','operation']).optional(),priority:count.nullable().optional(),state:state.nullable().optional(),
 publications:z.array(z.object({channel,status:z.enum(['planned','draft','scheduled','published']),url,publishedAt:day.optional(),scheduledAt:z.string().datetime({offset:true}).optional(),format:z.enum(['long','shorts']).optional()}).strict()).max(4).optional(),
};
const candidate=z.object({projectId:text(160),title:text(500),status:z.enum(['planned','draft','reuse']),ready:z.boolean()}).strict();
const week=z.object({from:day,to:day,totals:z.object({target:count,done:count,remaining:count}).strict(),channels:z.array(z.object({channel,label:text(40),target:count,published:count,scheduled:count,remaining:count,candidates:z.array(candidate).max(500)}).strict()).max(4)}).strict();
export const monitorSchema=z.object({
 sourceBoards:z.array(z.object({projectId:z.string().min(1).max(160),board:sourceBoardSchema}).strict()).max(500).refine(rows=>new Set(rows.map(row=>row.projectId)).size===rows.length).optional(),
 topics:topicBoardSchema.optional(),
 generatedAt:z.string().datetime(),thisWeek:week,nextWeek:week,
 queue:z.object({until:day,channels:z.array(z.object({channel,label:text(40),cap:count,booked:count,open:count,full:z.boolean(),inProduction:count,rows:z.array(z.object({projectId:text(160),title:text(500),day,status:z.enum(['scheduled','suggested']),phase:z.enum(['draft','final','review','production','reuse']).optional()}).strict()).max(1000)}).strict()).max(4)}).strict(),
 autopilot:z.object({enabled:z.boolean(),paused:z.boolean(),notice:text().nullable(),status:text(),today:z.object({title:text(500),target:text(2048).refine(v=>!v||/^https?:\/\//.test(v)||v.startsWith('project:')),why:z.array(text()).max(50),decision:text(10000),doneWhen:text(10000),outcome:text(100).nullable(),changeCount:count}).strict().nullable()}).strict(),
}).strict().refine(v=>new TextEncoder().encode(JSON.stringify(v)).byteLength<=1900000,'Monitor row exceeds database limit');
export type Monitor=z.infer<typeof monitorSchema>;
export type Progress=z.infer<z.ZodObject<typeof progressShape>>;

const seoulDay = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'});

export function thirdWeekGoals(monitor: Monitor, contents: readonly Progress[]) {
 const from = monitor.nextWeek.to;
 const end = new Date(from + 'T00:00:00Z');
 if (Number.isNaN(end.getTime())) return null;
 end.setUTCDate(end.getUTCDate() + 7);
 const to = end.toISOString().slice(0, 10);
 const inWeek = (date?: string) => !!date && from <= date && date < to;
 const channels = monitor.nextWeek.channels.map(({channel, label, target}) => {
  let published = 0;
  let scheduled = 0;
  for (const content of contents) {
   const publication = content.publications?.find(p => p.channel === channel);
   if (!publication || (channel === 'youtube' && publication.format !== 'shorts')) continue;
   if (publication.status === 'published' && inWeek(publication.publishedAt)) published++;
   if (publication.status === 'scheduled' && publication.scheduledAt && inWeek(seoulDay.format(new Date(publication.scheduledAt)))) scheduled++;
  }
  const suggestions = monitor.queue.channels.find(c => c.channel === channel)?.rows ?? [];
  const candidates = Array.from(new Map(suggestions
   .filter(row => row.status === 'suggested' && inWeek(row.day))
   .map(row => [row.projectId, {
    projectId: row.projectId,
    title: row.title,
    status: row.phase === 'reuse' ? 'reuse' as const : 'planned' as const,
    ready: row.phase === 'final',
    phase: row.phase,
   }])).values());
  return {channel, label, target, published, scheduled, remaining: Math.max(0, target - published - scheduled), candidates};
 });
 const totals = channels.reduce((sum, c) => ({
  target: sum.target + c.target,
  done: sum.done + c.published + c.scheduled,
  remaining: sum.remaining + c.remaining,
 }), {target: 0, done: 0, remaining: 0});
 return {from, to, totals, channels};
}

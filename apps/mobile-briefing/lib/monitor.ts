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
const post=z.object({projectId:text(500),title:text(500),day,status:z.enum(['planned','published'])}).strict();
const reservation=z.object({projectId:text(500),title:text(500),day,channel,at:z.string().datetime({offset:true})}).strict();
const week=z.object({from:day,to:day,totals:z.object({target:count,done:count,remaining:count}).strict(),channels:z.array(z.object({channel,label:text(40),target:count,published:count,scheduled:count,remaining:count,posts:z.array(post).optional(),candidates:z.array(candidate).max(500)}).strict()).max(4)}).strict();
export const monitorSchema=z.object({
 sourceBoards:z.array(z.object({projectId:z.string().min(1).max(160),board:sourceBoardSchema}).strict()).max(500).refine(rows=>new Set(rows.map(row=>row.projectId)).size===rows.length).optional(),
 topics:topicBoardSchema.optional(),
 generatedAt:z.string().datetime(),thisWeek:week,nextWeek:week,thirdWeek:week.optional(),reservations:z.array(reservation).optional(),
 queue:z.object({until:day,channels:z.array(z.object({channel,label:text(40),cap:count,booked:count,open:count,full:z.boolean(),inProduction:count,rows:z.array(z.object({projectId:text(500),title:text(500),day,status:z.enum(['scheduled','suggested']),phase:z.enum(['draft','final','review','production','reuse']).optional()}).strict()).max(1000)}).strict()).max(4)}).strict(),
 autopilot:z.object({enabled:z.boolean(),paused:z.boolean(),notice:text().nullable(),status:text(),today:z.object({title:text(500),target:text(2048).refine(v=>!v||/^https?:\/\//.test(v)||v.startsWith('project:')),why:z.array(text()).max(50),decision:text(10000),doneWhen:text(10000),outcome:text(100).nullable(),changeCount:count}).strict().nullable()}).strict(),
}).strict().refine(v=>new TextEncoder().encode(JSON.stringify(v)).byteLength<=1900000,'Monitor row exceeds database limit');
export type Monitor=z.infer<typeof monitorSchema>;
export type Progress=z.infer<z.ZodObject<typeof progressShape>>;

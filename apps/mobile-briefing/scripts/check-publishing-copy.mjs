// Local-only API/UI fixture. Never sends synthetic snapshots to production.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const origin=process.argv[2]??'http://127.0.0.1:5199';
if(!['127.0.0.1','localhost'].includes(new URL(origin).hostname))throw new Error('LOCAL_ONLY');
const phase=process.argv[3]??'initial';
const secret=/^BRIDGE_SECRET=(.*)$/m.exec(await readFile('.dev.vars','utf8'))?.[1]?.replace(/^["']|["']$/g,'');
if(!secret)throw new Error('Local fixture BRIDGE_SECRET missing');
const sections=[
 {id:'caption',kind:'caption',label:'캡션',parentId:null,text:phase==='updated'?'수정된 새콤한 맛과 젤리 식감이에요.\n#테스트':'처음 저장한 문안이에요.\n#테스트'},
 {id:'comment-1',kind:'comment',label:'댓글 1',parentId:null,text:'제품 이름을 확인해요.\n테스트 레몬 · 테스트 젤리'},
 {id:'reply-1',kind:'reply',label:'대댓글 1',parentId:'comment-1',text:'#추가태그'},
];
const copy={status:'ready',publicationStatus:'draft',updatedAt:new Date().toISOString(),sections};
const snapshot={sourceId:'primary-mac',sourceLabel:'로컬 검증',sourceRevision:`copy-qa-${Date.now()}`,sourceUpdatedAt:new Date().toISOString(),contents:[{id:'content:copy-qa',title:'문안 동기화 테스트',date:'2026-10-28',dateBasis:'record',stage:'review',nextAction:'세 문안과 복사를 확인해요',publicURL:'',publishingCopy:copy}],assets:[]};
const headers={'Content-Type':'application/json','X-Reels-Bridge-Key':secret};
const r=await fetch(new URL('/api/bridge/snapshot',origin),{method:'PUT',headers,body:JSON.stringify(snapshot)});
assert.equal(r.status,200,await r.text());
const read=await fetch(new URL('/api/briefing',origin),{headers});assert.equal(read.status,200);
const data=await read.json();assert.deepEqual(data.contents[0].publishing_copy,copy);assert.equal(data.mediaEnabled,false);
console.log(`PASS ${phase}: D1 roundtrip, line breaks, reply parent, media disabled`);

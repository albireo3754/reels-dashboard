// Local-only snapshot integration fixture; production hosts are rejected.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {routeFixture} from './route-map-fixture.mjs';
const origin=process.argv[2]??'http://127.0.0.1:5198';
if(!['127.0.0.1','localhost'].includes(new URL(origin).hostname))throw new Error('LOCAL_ONLY');
const secret=/^BRIDGE_SECRET=(.*)$/m.exec(await readFile('.dev.vars','utf8'))?.[1]?.replace(/^["']|["']$/g,'');
if(!secret)throw new Error('Local fixture BRIDGE_SECRET missing');
const headers={'Content-Type':'application/json','X-Reels-Bridge-Key':secret};
const make=routeMap=>({sourceId:'primary-mac',sourceLabel:'지도 로컬 검증',sourceRevision:`route-qa-${Date.now()}`,sourceUpdatedAt:new Date().toISOString(),contents:[{id:'content:route-qa',title:'촬영 지도 검증',date:'2026-01-02',dateBasis:'capture',stage:'selected',nextAction:'시간별 핀을 확인해요',publicURL:'',routeMap,routeMapStatus:routeMap?'ready':null}],assets:[]});
async function write(snapshot){const r=await fetch(new URL('/api/bridge/snapshot',origin),{method:'PUT',headers,body:JSON.stringify(snapshot)});return r;}
async function read(){return (await fetch(new URL('/api/briefing',origin),{headers})).json();}
const input=structuredClone(routeFixture);input.assets[1].source='/private/fixture-original.mp4';input.assets[1].thumbnail='data:image/jpeg;base64,private';
assert.equal((await write(make(input))).status,200);
let data=await read();assert.deepEqual(data.contents[0].route_map,routeFixture);assert.equal(data.contents[0].route_map_status,'ready');assert.equal(data.mediaEnabled,false);assert(!JSON.stringify(data).includes('/private/fixture'));
const updated=structuredClone(routeFixture);updated.assets[1].section='수정된 구간';assert.equal((await write(make(updated))).status,200);assert.equal((await read()).contents[0].route_map.assets[1].section,'수정된 구간');
const invalid=structuredClone(routeFixture);invalid.assets[0].point=[999,37];assert.equal((await write(make(invalid))).status,400);assert.equal((await read()).contents[0].route_map.assets[1].section,'수정된 구간');
assert.equal((await write(make(null))).status,200);assert.equal((await read()).contents[0].route_map,null);
// Leave the initial synthetic fixture available for optional local UI inspection.
assert.equal((await write(make(routeFixture))).status,200);
console.log('PASS: D1 route roundtrip/update/removal, unknown-path stripping, invalid coordinates rejected without replacing snapshot, media remains disabled');

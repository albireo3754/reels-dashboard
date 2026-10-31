import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,stat,utimes,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error The SDK is consumed directly by the Node bridge.
import {projectSnapshot,SNAPSHOT_MAX_BYTES,SYNC_ROUTE_MAX_BYTES} from '../../packages/icloud-object-sdk/index.mjs';
// @ts-expect-error Node bridge sanitizer is tested against the application contract.
import {parseRouteMap as parseBridgeRouteMap} from '../../packages/icloud-object-sdk/route-map.mjs';
import {parseRouteMap} from '../../src/shared/route-map';

const route = (section='Before') => ({
  schemaVersion:1,captureDate:'2026-10-03',timezone:'Asia/Seoul',
  assets:[{name:'scene.MOV',time:'18:00:00',kind:'video',duration:5,point:[126.9,37.5],accuracy:7,uncertain:false,section,source:path.join(os.tmpdir(),'private-video.mov'),thumbnail:'data:image/jpeg;base64,private'}],
  ways:[{points:[[126.9,37.5],[126.91,37.51]],kind:'footway',privateNote:'omit'}],
  legs:[{points:[[126.9,37.5],[126.91,37.51]],status:'inferred'}],
  pois:[{name:'Peak',point:[126.91,37.51]}],attribution:'OpenStreetMap contributors',routeStatus:'Candidate route, not recorded track',privatePath:'must not cross',
});
const dashboard=(resources:any[])=>({updatedAt:'2026-10-01T00:00:00.000Z',projects:[{id:'content:example',title:'Example',date:'2026-10-03',stage:'selected',nextAction:'Review',publicURL:'',resources}]});
const resource=(file:string,role='document')=>({role,label:'Route map',path:file});

test('bridge sanitizer strips local source/thumbnail and matches application DTO',()=>{
  const actual=parseBridgeRouteMap(route());
  assert.deepEqual(actual,parseRouteMap(route()));
  assert.ok(!JSON.stringify(actual).includes('private'));
  assert.equal(actual.assets[0].point[0],126.9);
});

test('route contents alter sync revision even with identical size, mtime and dashboard revision',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'route-sync-'));
  try{
    const file=path.join(root,'route-map-data.json');await writeFile(file,JSON.stringify(route()));
    const exactTime=new Date('2026-10-01T00:00:00.000Z');await utimes(file,exactTime,exactTime);
    const before=await projectSnapshot(dashboard([resource(file)]));const info=await stat(file);
    await writeFile(file,JSON.stringify(route('After!')));await utimes(file,exactTime,exactTime);
    const after=await projectSnapshot(dashboard([resource(file)]));
    assert.equal((await stat(file)).size,info.size);assert.equal((await stat(file)).mtimeMs,info.mtimeMs);
    assert.deepEqual(before.snapshot.assets,after.snapshot.assets);
    assert.notEqual(before.snapshot.sourceRevision,after.snapshot.sourceRevision);
    assert.equal(after.snapshot.contents[0].routeMap.assets[0].section,'After!');
    assert.equal(after.snapshot.contents[0].routeMapStatus,'ready');
    assert.ok(!JSON.stringify(after.snapshot).includes(root));
    assert.ok(!JSON.stringify(after.snapshot).includes('private-video'));
    assert.equal(after.objects.entries.size,1); // No source or preview media was registered or read.
    await rm(file);const missing=await projectSnapshot(dashboard([resource(file)]));
    assert.equal(missing.snapshot.contents[0].routeMap,null);assert.equal(missing.snapshot.contents[0].routeMapStatus,'unavailable');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('only one exact named document can project a route; invalid and ambiguous inputs fail closed',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'route-invalid-'));
  try{
    const file=path.join(root,'route-map-data.json');await writeFile(file,JSON.stringify(route()));
    const other=path.join(root,'unrelated.json');await writeFile(other,JSON.stringify(route()));
    for(const resources of [[resource(other)],[resource(file,'draft')],[]]){
      const r=await projectSnapshot(dashboard(resources));assert.equal(r.snapshot.contents[0].routeMap,null);assert.equal(r.snapshot.contents[0].routeMapStatus,null);
    }
    await mkdir(path.join(root,'duplicate'));const duplicate=path.join(root,'duplicate','route-map-data.json');await writeFile(duplicate,JSON.stringify(route()));
    const ambiguous=await projectSnapshot(dashboard([resource(file),resource(duplicate)]));assert.equal(ambiguous.snapshot.contents[0].routeMap,null);assert.equal(ambiguous.snapshot.contents[0].routeMapStatus,'unavailable');
    for(const body of ['{broken',JSON.stringify({...route(),assets:[{...route().assets[0],point:[999,37]}]}),JSON.stringify({...route(),assets:[route().assets[0],route().assets[0]]}),' '.repeat(8*1024*1024+1)]){
      await writeFile(file,body);const r=await projectSnapshot(dashboard([resource(file)]));assert.equal(r.snapshot.contents[0].routeMap,null);assert.equal(r.snapshot.contents[0].routeMapStatus,'unavailable');
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test('application and bridge both reject nonchronological times, traversal names and invalid coordinates',()=>{
  const cases=[
    {...route(),assets:[{...route().assets[0],name:'../scene.MOV'}]},
    {...route(),assets:[{...route().assets[0],time:'25:00:00'}]},
    {...route(),assets:[route().assets[0],{...route().assets[0],name:'earlier.MOV',time:'17:00:00'}]},
    {...route(),assets:[{...route().assets[0],point:[126.9,Infinity]}]},
  ];
  for(const value of cases){assert.throws(()=>parseRouteMap(value));assert.throws(()=>parseBridgeRouteMap(value));}
});

test('single large and aggregate route payloads cannot block the 4MiB metadata ingestion boundary',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'route-budget-'));
  const dense=(ways:number)=>({...route(),ways:Array.from({length:ways},()=>({kind:'path',points:Array.from({length:10000},()=>[126.123456789,37.123456789])}))});
  try{
    const large=path.join(root,'route-map-data.json');const largeBody=JSON.stringify(dense(18));
    assert(Buffer.byteLength(largeBody)>4*1024*1024&&Buffer.byteLength(largeBody)<8*1024*1024);
    await writeFile(large,largeBody);
    const single=await projectSnapshot(dashboard([resource(large)]));
    assert.equal(single.snapshot.contents[0].routeMap,null);assert.equal(single.snapshot.contents[0].routeMapStatus,'unavailable');
    assert.equal(single.snapshot.contents[0].title,'Example');assert.equal(single.snapshot.assets.length,1);
    assert(Buffer.byteLength(JSON.stringify(single.snapshot))<=SNAPSHOT_MAX_BYTES);
    await writeFile(large,JSON.stringify(dense(4)));
    assert(Buffer.byteLength(JSON.stringify(dense(4)))>SYNC_ROUTE_MAX_BYTES);
    const d1=await projectSnapshot(dashboard([resource(large)]));assert.equal(d1.snapshot.contents[0].routeMapStatus,'unavailable');
    const first=dashboard([]);first.projects=[];
    const smallBody=JSON.stringify(dense(3));assert(Buffer.byteLength(smallBody)<SYNC_ROUTE_MAX_BYTES);
    for(let i=0;i<5;i++){
      const file=path.join(root,String(i),'route-map-data.json');await mkdir(path.dirname(file));await writeFile(file,smallBody);
      const item=dashboard([resource(file)]).projects[0];item.id='content:'+i;first.projects.push(item);
    }
    const combined=await projectSnapshot(first);
    assert(Buffer.byteLength(JSON.stringify(combined.snapshot))<=SNAPSHOT_MAX_BYTES);
    assert.equal(combined.snapshot.contents.filter((c:any)=>c.routeMapStatus==='ready').length,4);
    assert.equal(combined.snapshot.contents.filter((c:any)=>c.routeMapStatus==='unavailable').length,1);
    assert.equal(combined.snapshot.contents.length,5);assert.equal(combined.snapshot.assets.length,5);
  }finally{await rm(root,{recursive:true,force:true});}
});

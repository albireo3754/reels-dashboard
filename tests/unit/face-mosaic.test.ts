import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, stat, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {LocalStore} from '../../src/shared/lib/storage';
import {ContentLibrary} from '../../src/features/content-library';
import {MediaAnalysis} from '../../src/desktop/media-analysis';

test('face mosaic saves a new image and reviewed settings, rejecting changed sources and overwrites', async () => {
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'mosaic-')));
  try {
    const media=path.join(root,'media'); await mkdir(media); const source=path.join(media,'test.png');
    const runtime=path.resolve('native/editor-engine/.build/runtime');
    execFileSync(path.join(runtime,'bin/ffmpeg'),['-v','error','-f','lavfi','-i','testsrc=size=100x100','-frames:v','1',source]);
    const before=await readFile(source), info=await stat(source);
    const store=new LocalStore(root); await store.initialize();
    await store.update(d=>({...d,projects:[{id:'p',title:'p',date:'2026-10-31',stage:'captured',nextAction:'',publicURL:'',shared:false,resources:[{role:'folder',path:media,label:'media'}]}]}));
    const service=new MediaAnalysis(store,new ContentLibrary(store),runtime);
    await mkdir(service.root,{recursive:true});
    const sample={id:'s',sourcePath:source,sourceVersion:createHash('sha256').update(`${info.size}:${info.mtimeMs}`).digest('hex'),kind:'photo',time:null,imagePath:source};
    const fields={description:'fixture',tags:[],ocr:[],uncertainties:[],faceRegions:[{x:.1,y:.1,width:.3,height:.3}]};
    await writeFile(path.join(service.root,createHash('sha256').update('p').digest('hex')+'.json'),JSON.stringify({schemaVersion:1,projectId:'p',revision:1,runs:[],corrections:{},results:[{sample,provider:'fake',runId:'run',analyzedAt:'2026-10-31',fields}]}));
    const request={projectId:'p',sampleId:'s',regions:fields.faceRegions,blockSize:20}; const output=path.join(root,'output.png');
    assert.ok((await service.mosaicSample('p','s')).startsWith('data:image/jpeg;base64,'));
    assert.equal(await service.mosaicExport(request,output),output);
    assert.deepEqual(await readFile(source),before);
    const plan=JSON.parse(await readFile(output+'.mosaic.json','utf8')); assert.deepEqual(plan.regions,request.regions); assert.equal(plan.blockSize,20);
    await assert.rejects(service.mosaicExport(request,output));
    await writeFile(source,'changed');
    await assert.rejects(service.mosaicExport(request,path.join(root,'other.png')),/변경/);
  } finally {await rm(root,{recursive:true,force:true});}
});

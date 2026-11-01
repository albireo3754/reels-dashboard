import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {LocalStore} from '../../src/shared/lib/storage';
import {ContentLibrary} from '../../src/features/content-library';
import {BlogLibrary} from '../../src/desktop/blog-library';
import {importSpec} from '../../src/features/blog-workspace/model/import-spec';

test('blog uses registered markdown, local image grants and revision checked private drafts',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'blog-test-')));
 try {const folder=path.join(root,'media');await mkdir(folder);const doc=path.join(root,'article.md'),photo=path.join(folder,'photo.png'),outside=path.join(root,'outside.png');await writeFile(doc,'# public\n\nprivate');await writeFile(photo,'synthetic');await writeFile(outside,'private');
 const store=new LocalStore(root);await store.initialize();await store.update(d=>({...d,projects:[{id:'p',title:'p',date:'2026-10-31',stage:'captured',nextAction:'',publicURL:'',shared:false,resources:[{role:'document',path:doc,label:'원고'},{role:'folder',path:folder,label:'사진'}]}]}));
 const api=new BlogLibrary(store,new ContentLibrary(store));assert.match((await api.readDocument('p',doc)).text,/private/);await assert.rejects(api.readDocument('p',outside));
 const first=await api.load('p');const saved=await api.save({...first,blocks:[{id:'a',type:'text',text:'public'},{id:'b',type:'image',path:photo,alt:'사진'}]});assert.equal(saved.revision,1);assert.equal((await api.load('p')).blocks.length,2); const secondApi=new BlogLibrary(store,new ContentLibrary(store)); const parallel=await Promise.allSettled([api.save(saved),secondApi.save(saved)]); assert.equal(parallel.filter(r=>r.status==='fulfilled').length,1); assert.equal(parallel.filter(r=>r.status==='rejected').length,1); await assert.rejects(api.save(first),/STALE_BLOG/);const latest=await api.load('p');await assert.rejects(api.save({...latest,blocks:[{id:'x',type:'image',path:outside,alt:'x'}]}));assert.equal(await readFile(doc,'utf8'),'# public\n\nprivate');
 const link=path.join(folder,'linked.png');await symlink(outside,link);await assert.rejects(api.save({...latest,blocks:[{id:'x',type:'image',path:link,alt:'x'}]}));
 } finally {await rm(root,{recursive:true,force:true});}
});
test('render spec maps semantic blocks and styles, rejects external image URLs',()=>{
 const data={layout:{background:'#ffffff',paragraphSize:16},fonts:{body:'sans'},spans:[{text:'test',weight:700}],blocks:[{type:'heading',text:'제목'},{type:'paragraph',text:'test 문단'},{type:'image',src:'media/photo.png',alt:'사진'},{type:'native-map',label:'지도'}]};let n=0;
 const imported=importSpec(JSON.stringify(data),'/linked',()=>String(++n));assert.equal(imported.blocks.length,4);assert.equal(imported.blocks[0].type==='text'&&imported.blocks[0].role,'heading');assert.equal(imported.blocks[1].type==='text'&&imported.blocks[1].spans?.[0].weight,700);assert.equal(imported.blocks[2].type==='image'&&imported.blocks[2].path,'/linked/photo.png');assert.equal(imported.style.paragraphSize,16);
 data.blocks[2].src='https://example.invalid/a.png';assert.throws(()=>importSpec(JSON.stringify(data),'/linked',()=>String(++n)));
});

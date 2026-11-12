import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,rm,symlink} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {parse,serialize,validate} from "../../src/shared/blog-markup";
import {bundleHashes,classify,protectedText} from "../../src/shared/blog-markup-source";
import {renderHtml} from "../../src/shared/blog-markup-render";
import {MarkupStore} from "../../src/app/blog-editor/markup-store";
import {startCanonicalEditor} from "../../src/app/blog-editor/server";
import {markupFixture} from "../fixtures/markup-editor";
const wrap=(tag:string)=>`<Bundle id="B1" name="toast" question="what happened">\n${tag}\n</Bundle>\n`;
const tag='<Video file="cheers.mp4" alt="건배" poster="photo.png" caption="새 출발에 건배" ratio="4:5" fit="cover" position="50% 70%" muted loop/>';
test("Video round trips, validates attributes and renders real controls with escaped caption and explicit crop",()=>{
 const d=parse(wrap(tag));assert.deepEqual(parse(serialize(d)),d);assert.equal(validate(d).filter(i=>i.level==='error').length,0);
 const html=renderHtml(d,{media:'media/'});assert.match(html,/<video controls playsinline preload="metadata"/);assert.match(html,/src="media\/cheers.mp4"/);assert.match(html,/poster="media\/photo.png"/);assert.match(html,/object-fit:cover;object-position:50% 70%;aspect-ratio:0.8/);assert.match(html,/ muted loop/);assert.doesNotMatch(html,/autoplay/);
 const unsafe=parse(wrap('<Video file="clip.mov"/>')); (unsafe.bundles[0].nodes[0] as any).attrs.caption='<script>"&'; assert.match(renderHtml(unsafe),/&lt;script&gt;&quot;&amp;/);
 for(const bad of ['file="../secret.mp4"','file="https://x/y.mp4"','file="clip.txt"','file="clip.mp4" onerror="x"','file="clip.mp4" ratio="0:4"','file="clip.mp4" position="101% 50%"','file="clip.mp4" muted="yes"','file="clip.mp4" poster="../photo.jpg"']) {
  const doc=parse(wrap(`<Video ${bad}/>`));assert(validate(doc).some(i=>i.level==='error'),bad);assert.doesNotMatch(renderHtml(doc),/<video /);
 }
 const moved=parse(wrap(tag.replace('50% 70%','50% 60%')));assert.equal(bundleHashes(d).B1.textHash,bundleHashes(moved).B1.textHash);assert.notEqual(bundleHashes(d).B1.fullHash,bundleHashes(moved).B1.fullHash);
 const changed=parse(wrap(tag.replace('새 출발에 건배','오늘의 건배')));assert.equal(classify(d,changed).document,'text');assert.notEqual(protectedText(d),protectedText(changed));
});
test("editor preserves Video on text save, serves only registered media, and supports byte ranges and HEAD",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'blog-video-'));let server;
 try {
  const config=await markupFixture(root);let s=await readFile(config.canon,'utf8');s=s.replace('<Photo file="photo.png" alt="Example photo"/>',tag);await writeFile(config.canon,s);
  const bytes=Buffer.from('0123456789abcdef');await writeFile(path.join(config.media,'cheers.mp4'),bytes);await writeFile(path.join(config.media,'unlinked.mp4'),bytes);
  const store=new MarkupStore(config);const before=await store.load();const frame=await store.frame();assert.match(frame,/kind=video&amp;name=cheers.mp4/);assert.match(frame,/poster="\/api\/blog\/asset\?kind=photo&amp;name=photo.png"/);
  const saved=await store.save({revision:before.revision,edits:[{id:'P2',source:'Changed after the toast'}]});assert.equal(saved.document.frameVersion,before.frameVersion);assert.match(await readFile(config.canon,'utf8'),/<Video/);assert.match(await readFile(config.layout,'utf8'),/<video controls/);assert.match(await readFile(config.layout,'utf8'),/blog-markup-theme/);
  server=await startCanonicalEditor(config);const url=server.url+'/api/blog/asset?kind=video&name=cheers.mp4';
  const full=await fetch(url);assert.equal(full.status,200);assert.equal(full.headers.get('content-type'),'video/mp4');assert.deepEqual(Buffer.from(await full.arrayBuffer()),bytes);
  for(const [range,expected] of [['bytes=2-5','2345'],['bytes=-4','cdef'],['bytes=12-','cdef']]){const r=await fetch(url,{headers:{Range:range}});assert.equal(r.status,206);assert.equal(await r.text(),expected);assert.equal(r.headers.get('accept-ranges'),'bytes');}
  const head=await fetch(url,{method:'HEAD',headers:{Range:'bytes=2-5'}});assert.equal(head.status,206);assert.equal(head.headers.get('content-length'),'4');assert.equal(await head.text(),'');
  assert.equal((await fetch(url,{headers:{Range:'bytes=999-'}})).status,416);
  assert.equal((await fetch(server.url+'/api/blog/asset?kind=video&name=unlinked.mp4')).status,409);
  assert.equal((await fetch(url,{headers:{Origin:'https://elsewhere.invalid'}})).status,403);
  await rm(path.join(config.media,'cheers.mp4'));await symlink(path.join(root,'article.notes.md'),path.join(config.media,'cheers.mp4'));
  assert.equal((await fetch(url)).status,409);
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});

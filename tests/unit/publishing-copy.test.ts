import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,stat,utimes} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
// @ts-expect-error The SDK is consumed directly by the Node bridge.
import {parsePublishingCopy} from '../../packages/icloud-object-sdk/publishing-copy.mjs';
// @ts-expect-error The SDK is consumed directly by the Node bridge.
import {projectSnapshot} from '../../packages/icloud-object-sdk/index.mjs';
const doc=(caption='새콤한 맛')=>`---\ncontent_id: example\npublication_status: draft\n---\n## 이전 영상\n\`\`\`text\nold draft\n\`\`\`\n## 캡션\nInternal notes must stay local.\n\`\`\`text\n${caption}\n#여행\n\`\`\`\n## 댓글 1\n\`\`\`text\n제품 이름\n\`\`\`\n## 대댓글 1\n\`\`\`text\n#제품\n\`\`\`\n## 조사\n\`\`\`text\nPrivate research /Users/example/secret\n\`\`\`\n`;
test('only matching canonical publishing blocks cross the boundary, preserving reply parent',()=>{
 const copy=parsePublishingCopy(doc(),'content:example');
 assert.equal(copy.status,'ready');assert.equal(copy.publicationStatus,'draft');
 assert.deepEqual(copy.sections.map((s:any)=>[s.id,s.parentId]),[['caption',null],['comment-1',null],['reply-1','comment-1']]);
 assert.equal(copy.sections[0].text,'새콤한 맛\n#여행');
 assert.ok(!JSON.stringify(copy).includes('Internal'));assert.ok(!JSON.stringify(copy).includes('/Users/'));
 assert.equal(parsePublishingCopy(doc(),'content:other'),null);
});
test('unwritten, ambiguous and unclosed blocks are not reported as ready copy',()=>{
 assert.equal(parsePublishingCopy('---\ncontent_id: example\n---\n## 캡션\n미작성','content:example').status,'empty');
 assert.equal(parsePublishingCopy('---\ncontent_id: example\n---\n## 캡션\n```text\nunclosed','content:example').status,'empty');
 const repeated=doc()+'\n## 캡션\n```text\nsecond\n```';
 assert.ok(!parsePublishingCopy(repeated,'content:example').sections.some((s:any)=>s.kind==='caption'));
 assert.equal(parsePublishingCopy('---\ncontent_id: example\n---\n```js\n## 캡션\n```\n','content:example').status,'empty');
});
test('text-only changes alter sync revision even with identical size, mtime and dashboard revision',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'publishing-copy-'));
 try{
  const file=path.join(root,'content.md');await writeFile(file,doc());
  const dashboard={updatedAt:'2026-10-01T00:00:00.000Z',projects:[{id:'content:example',title:'Example',date:'2026-10-01',stage:'review',nextAction:'Review',publicURL:'',resources:[{role:'document',label:'Content',path:file}]}]};
  const before=await projectSnapshot(dashboard);const info=await stat(file);
  await writeFile(file,doc('달콤한 맛'));await utimes(file,info.atime,info.mtime);
  const after=await projectSnapshot(dashboard);
  assert.equal((await stat(file)).size,info.size);assert.notEqual(before.snapshot.sourceRevision,after.snapshot.sourceRevision);
  assert.match(after.snapshot.contents[0].publishingCopy.sections[0].text,/달콤/);
  assert.ok(!JSON.stringify(after.snapshot).includes(root));
  await rm(file);const missing=await projectSnapshot(dashboard);
  assert.equal(missing.snapshot.contents[0].publishingCopy,null);
 }finally{await rm(root,{recursive:true,force:true});}
});

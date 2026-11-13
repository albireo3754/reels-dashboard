import {test,expect} from '@playwright/test';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {markupFixture} from '../fixtures/markup-editor';
import {startCanonicalEditor} from '../../src/app/blog-editor/server';
import {contentHistoryDir} from '../../src/shared/content-history';
import {parse} from '../../src/shared/blog-markup';
import {bundleHashes} from '../../src/shared/blog-markup-source';

test('two real editor edits, reject proposal, reload: durable revisions and feedback',async({page})=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'eval-ui-'));let server;
 try{
  const config={...await markupFixture(root),review:path.join(root,'reviews.json')};
  const source=await readFile(config.canon,'utf8');
  await writeFile(config.review,JSON.stringify({reviews:[{bundleId:'B1',summary:'Fixture',verdict:'needs-work',basedOn:bundleHashes(parse(source)).B1,findings:[{id:'keep',axis:'문장',severity:'권장',observation:'Synthetic proposal',proposal:{layer:'text',tid:'P2',before:'Second line',after:'Replacement'}}]}]}));
  server=await startCanonicalEditor(config);await page.goto(server.url+'/?blogEditor=1');
  const frame=page.frameLocator('iframe[title="정본 본문 편집"]');
  await frame.locator('[data-review-ui="ins"][data-pid="keep"]').click();
  await frame.locator('[data-review-ui="hint"]').getByRole('button',{name:'현재 유지',exact:true}).click();
  const dir=contentHistoryDir(config.canon);
  await expect.poll(async()=>readdir(path.join(dir,'events')).catch(()=>[])).toHaveLength(1);
  for(const text of ['Saved first edit','Saved second edit']){
   const p=frame.locator('[data-tid="P2"]');await p.click();await page.keyboard.press('ControlOrMeta+a');await page.keyboard.type(text);
   await expect.poll(()=>readFile(config.canon,'utf8')).toContain(text);
   await expect(page.locator('#ce-save-status')).toContainText('✓ 저장 완료');
  }
  await page.reload();await expect(frame.locator('[data-tid="P2"]')).toHaveText('Saved second edit');
  const names=(await readdir(path.join(dir,'transactions'))).filter(n=>n.endsWith('.json'));
  expect(names.length).toBeGreaterThanOrEqual(2);
  const tx=await Promise.all(names.map(async n=>JSON.parse(await readFile(path.join(dir,'transactions',n),'utf8'))));
  expect(tx.some(t=>t.diff.inserted.includes('first'))).toBe(true);expect(tx.some(t=>t.diff.inserted.includes('second'))).toBe(true);
  expect(tx.every(t=>t.actor==='user')).toBe(true);
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});

import {test,expect} from '@playwright/test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {startWorkflowServer} from '../../src/app/workflow/server';import {workflowRequest} from '../../src/app/workflow/client';
test('CLI session form uses the dashboard component, detects conflicting edits, and returns exact submitted output',async({page,context})=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'forms-ui-'));const h=await startWorkflowServer({root:path.join(root,'db'),port:0});
 const cli=async(...args:string[])=>JSON.parse((await promisify(execFile)(process.execPath,['--import','tsx','src/app/workflow/forms-cli.ts',...args],{cwd:process.cwd(),env:{...process.env,REELS_WORKFLOW_URL:h.url}})).stdout);
 try{
  await writeFile(path.join(root,'source.md'),'Synthetic source');await writeFile(path.join(root,'photo.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l4kAAAAASUVORK5CYII=','base64'));
  await writeFile(path.join(root,'create.json'),JSON.stringify({workspace:root,projectId:'fixture:shared',sourceFiles:['source.md'],form:{version:1,title:'같은 폼',introduction:'세션에서 보낸 질문',facts:[],questions:[{id:'q',section:'기억',prompt:'가장 기억나는 것은?',images:[{path:'photo.png',caption:'합성 사진'}]},{id:'skip',section:'선택',prompt:'제외할 내용은?',images:[]}]}}));
  let f=await cli('create',path.join(root,'create.json'));const url=(await cli('open',f.formId)).url;
  await page.goto(url);await expect(page.getByRole('heading',{name:'입력폼·답변·결과',exact:true})).toBeVisible();await expect(page.getByAltText('합성 사진')).toBeVisible();
  await page.getByLabel('가장 기억나는 것은?',{exact:true}).fill('첫 기억!!');
  await expect(page.getByRole('button',{name:'대시보드 실행',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'답변 임시저장',exact:true}).click();await expect(page.getByText('답변을 임시저장했어요.')).toBeVisible();
  const other=await context.newPage();await other.goto(url);await other.getByLabel('가장 기억나는 것은?',{exact:true}).fill('다른 창의 수정');
  await page.getByLabel('가장 기억나는 것은?',{exact:true}).fill('내 원문!!\n이 말투 유지');await page.getByRole('button',{name:'답변 임시저장',exact:true}).click();await expect(page.getByText('답변을 임시저장했어요.')).toBeVisible();
  await other.getByRole('button',{name:'답변 임시저장',exact:true}).click();await expect(other.getByRole('alert')).toContainText('STALE_FORM');await expect(other.getByLabel('가장 기억나는 것은?',{exact:true})).toHaveValue('다른 창의 수정');await other.close({runBeforeUnload:false});
  await page.getByLabel('선택 답변 상태').selectOption('omit');await page.getByRole('button',{name:'한 번에 제출 · 요청 확인'}).click();
  await expect(page.getByRole('region',{name:'제출된 답변'})).toContainText('답변 제출 완료');
  const out=await cli('results',f.formId);expect(out.responses[0].text).toBe('내 원문!!\n이 말투 유지');expect(out.responses[1].status).toBe('omit');expect((await workflowRequest('list',{},h.url)).runs).toHaveLength(0);
  const run=await workflowRequest('create',{title:'대시보드에서 이어가기',workspace:root,trackedFiles:['source.md'],instructions:'fixture',inputFormId:f.formId},h.url);expect(run.experience.formId).toBe(f.formId);
  await writeFile(path.join(root,'result.md'),'사용자 표현을 반영한 결과');await workflowRequest('form-apply',{formId:f.formId,expectedRevision:out.revision,summary:'후속 결과를 반영했습니다.',evidence:['result.md']},h.url);
  await page.reload();await expect(page.getByRole('region',{name:'제출된 답변'})).toContainText('후속 결과를 반영했습니다.');await page.getByText('기억 · 답변',{exact:true}).click();await expect(page.getByText('내 원문!!\n이 말투 유지',{exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/workflow/shared-form-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:'test-results/workflow/shared-form-mobile.png',fullPage:true});
 }finally{await h.close();await rm(root,{recursive:true,force:true});}
});

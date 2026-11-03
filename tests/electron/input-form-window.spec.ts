import {test,expect} from '@playwright/test';import {writeFile} from 'node:fs/promises';import path from 'node:path';
import {startWorkflowServer} from '../../src/app/workflow/server';import {workflowRequest} from '../../src/app/workflow/client';import {callAgent} from '../../src/shared/lib/agent-socket';import {launchApp,makeProfile,closeApp,cleanProfile} from './helpers';
test('MCP/CLI open action opens the same form in a native draft window and reuses it',async()=>{
 const profile=await makeProfile();let app;
 const h=await startWorkflowServer({root:path.join(profile,'workflows'),port:0,openForm:id=>callAgent(profile,'reels_open_input_form',{formId:id})});
 try{
  await writeFile(path.join(profile,'source.md'),'fixture');
  const f=await workflowRequest('form-create',{workspace:profile,sourceFiles:['source.md'],form:{version:1,title:'세션에서 보낸 폼',introduction:'fixture',facts:[],questions:[{id:'q',section:'기억',prompt:'남길 말은?',images:[]}]}},h.url);
  app=await launchApp(profile,false,{REELS_WORKFLOW_URL:h.url});await app.firstWindow();
  await expect.poll(async()=>{try{return (await callAgent(profile,'reels_get_app_state',{}))!==null;}catch{return false;}}).toBe(true);
  const viaNative:any=await callAgent(profile,'reels_form_get',{formId:f.formId});expect(viaNative.formId).toBe(f.formId);
  const opened=await workflowRequest('form-open',{formId:f.formId,surface:'desktop'},h.url);expect(opened.opened).toBe(true);
  const page=app.windows().find(p=>p.url().includes('form='+f.formId))!;expect(page).toBeTruthy();await expect(page.getByRole('heading',{name:'세션에서 보낸 폼',exact:true})).toBeVisible();
  const count=app.windows().length;await workflowRequest('form-open',{formId:f.formId,surface:'desktop'},h.url);expect(app.windows().length).toBe(count);
  await page.getByLabel('남길 말은?',{exact:true}).fill('창에서도 같은 원문!!');await page.getByRole('button',{name:'한 번에 제출 · 요청 확인'}).click();await expect(page.getByRole('region',{name:'제출된 답변'})).toBeVisible();
  const results=await workflowRequest('form-results',{formId:f.formId},h.url);expect(results.responses[0].text).toBe('창에서도 같은 원문!!');expect((await workflowRequest('list',{},h.url)).runs).toHaveLength(0);
 }finally{await closeApp(app);await h.close();await cleanProfile(profile);}
});

import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startWorkflowServer } from '../../src/app/workflow/server';
import { launchApp, makeProfile, closeApp, cleanProfile } from './helpers';

test('packaged dashboard receives a photo question and submits user answers through its IPC bridge',async()=>{
 const profile=await makeProfile();
 const server=await startWorkflowServer({root:path.join(profile,'workflows'),port:0,sdkEnv:{}});
 let app;
 try {
  await writeFile(path.join(profile,'source.md'),'Synthetic only');
  await writeFile(path.join(profile,'photo.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l4kAAAAASUVORK5CYII=','base64'));
  await writeFile(path.join(profile,'experience-form.json'),JSON.stringify({version:1,title:'직접 경험',introduction:'한 번에 응답',facts:[],questions:[{id:'q',section:'기억',prompt:'무엇이 기억나나요?',images:[{path:'photo.png',caption:'합성 사진'}]}]}));
  const post=async(action:string,input:unknown)=>(await fetch(server.url+'/api/workflows/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})).json();
  let run=await post('create',{title:'Synthetic intake',workspace:profile,instructions:'Synthetic',trackedFiles:['source.md'],collectExperience:true});
  await post('submit',{runId:run.runId,taskId:run.task.taskId,outcome:'done',summary:'Prepared',evidence:['experience-form.json']});
  app=await launchApp(profile,true,{REELS_WORKFLOW_URL:server.url});const page=await app.firstWindow();
  await page.getByRole('button',{name:'워크플로',exact:true}).click();
  await expect(page.getByRole('heading',{name:'현재 요청 · 내 경험 채우기'})).toBeVisible();
  await expect(page.getByAltText('합성 사진')).toBeVisible();
  await page.getByLabel('무엇이 기억나나요?',{exact:true}).fill('기억 원문!!');
  await page.getByRole('button',{name:'한 번에 제출 · 요청 확인'}).click();
  await expect(page.getByRole('heading',{name:'현재 요청 · 답변 요청 분류'})).toBeVisible();
 }finally{await closeApp(app);await server.close();await cleanProfile(profile);}
});

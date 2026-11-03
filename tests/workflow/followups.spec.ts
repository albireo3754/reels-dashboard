import {test,expect} from '@playwright/test';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {startWorkflowServer} from '../../src/app/workflow/server';
test('dashboard shows each sourced request, pending/session handling, evidence and next stage',async({page})=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'followups-ui-'));const h=await startWorkflowServer({root:path.join(root,'db'),port:0});
 const post=async(a:string,x:unknown)=>{const res=await fetch(h.url+'/api/workflows/'+a,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(x)});if(!res.ok)throw Error(await res.text());return res.json();};
 try{
  await writeFile(path.join(root,'source.md'),'주차 조사해줘.');await writeFile(path.join(root,'report.md'),'주차를 확인함');
  await writeFile(path.join(root,'experience-form.json'),JSON.stringify({version:1,title:'fixture',introduction:'',facts:[],questions:[{id:'q',section:'기억',prompt:'기억?',images:[]}]}));
  let r=await post('create',{title:'추가 요청 확인',workspace:root,instructions:'fixture',trackedFiles:['source.md'],collectExperience:true});
  const done=async(files:string[])=>r=await post('submit',{runId:r.runId,taskId:r.task.taskId,outcome:'done',summary:'확인 완료',evidence:files});
  await done(['experience-form.json']);r=await post('experience-save',{runId:r.runId,taskId:r.task.taskId,expectedRevision:0,answers:[{questionId:'q',status:'answered',text:'주차 조사해줘.'}],submit:true});
  await writeFile(path.join(root,'followup-tasks.json'),JSON.stringify({version:1,reviewedAnswerIds:['q'],tasks:[{id:'parking',title:'주차 조사',kind:'research',sourceFile:'source.md',sourceQuote:'주차 조사해줘.',instruction:'주차 지원 여부 조사',executor:'session'}]}));await done(['followup-tasks.json']);
  await page.goto(h.url+'/?workflow=1');await expect(page.getByRole('region',{name:'추가 요청 작업 목록'})).toContainText('주차 조사 · 대기');
  await expect(page.getByRole('button',{name:'제작 세션에서 처리할 작업'})).toBeDisabled();
  await page.getByLabel('판단·변경 내용').fill('전용 주차장 안내 확인');await page.getByLabel('결과·검토 근거 파일',{exact:false}).fill('report.md');await page.getByRole('button',{name:'결과 제출',exact:true}).click();
  await expect(page.getByRole('heading',{name:'현재 요청 · 초안 작성'})).toBeVisible();await expect(page.getByRole('region',{name:'추가 요청 작업 목록'})).toContainText('주차 조사 · 처리 완료');
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/workflow/followups-mobile.png',fullPage:true});
 }finally{await h.close();await rm(root,{recursive:true,force:true});}
});

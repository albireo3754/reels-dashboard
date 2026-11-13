import {readFile,mkdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {contentHash,immutableJson} from '../../shared/content-history';
import {privateOutput,caseSchema} from './dataset';

const config=z.strictObject({version:z.literal(1),name:z.string().min(1),model:z.string().min(1),workflow:z.string().min(1),
  settings:z.record(z.string(),z.unknown()),adapter:z.string(),
  files:z.array(z.strictObject({role:z.enum(['input','document','skill','role','workflow','dependency']),file:z.string()})).min(1),
  cases:z.array(caseSchema),scope:z.array(z.string()).min(1),unexecuted:z.array(z.string()),
  timeoutMs:z.number().int().min(1).max(3600000).default(60000),maxAttempts:z.number().int().min(1).max(3).default(1),
});
const adapterResult=z.strictObject({
  findings:z.array(z.strictObject({caseId:z.string(),ids:z.array(z.string())})),
  evidence:z.array(z.string()),usage:z.record(z.string(),z.number().nonnegative()).nullable(),
  execution:z.enum(['fixture','model','existing-artifact']),unexecuted:z.array(z.string()),
});
export interface EvalContext {directory:string;input:unknown;signal:AbortSignal;attempt:number;}
export interface EvalAdapter {run(context:EvalContext):Promise<z.infer<typeof adapterResult>>;}
export async function freezeExperiment(value:unknown,output:string){
  const spec=config.parse(value),root=await privateOutput(output),directory=path.join(root,randomUUID());
  await mkdir(directory);
  const files=[];
  for(const entry of [...spec.files,{role:'adapter',file:spec.adapter}]){
    const text=await readFile(entry.file,'utf8'),sha256=contentHash(text);
    await immutableJson(path.join(directory,'frozen',sha256+'.json'),{sha256,text});
    files.push({...entry,sha256,text});
  }
  // Variants share the same source inputs and case revisions; workflow/role/skills are separately identified.
  const inputHash=contentHash(JSON.stringify({files:files.filter(f=>f.role==='input').map(f=>f.sha256),cases:spec.cases}));
  const contextHash=contentHash(JSON.stringify(files.filter(f=>f.role!=='adapter').map(f=>[f.role,f.sha256])));
  const packet={version:1,spec,files,inputHash,contextHash,createdAt:new Date().toISOString()};
  await immutableJson(path.join(directory,'packet.json'),packet);
  return {directory,packet};
}
const judgeVersion='finding-id-set/v1';
export function judge(cases:z.infer<typeof caseSchema>[],output:z.infer<typeof adapterResult>){
  return cases.map(c=>{
    if(c.status!=='confirmed'||!c.confirmation)return {caseId:c.id,status:'not-run',reason:'unconfirmed label'};
    const actual=output.findings.find(f=>f.caseId===c.id);
    if(!actual)return {caseId:c.id,status:'not-run',reason:'adapter omitted case'};
    const expected=new Set(c.expectedFindingIds),found=new Set(actual.ids);
    const tp=[...found].filter(id=>expected.has(id)).length,fn=expected.size-tp,fp=c.exhaustive?[...found].filter(id=>!expected.has(id)).length:null;
    return {caseId:c.id,status:fn===0&&(fp===0||fp===null)?'passed':'failed',tp,fn,fp,
      precision:fp===null||tp+fp===0?null:tp/(tp+fp),recall:expected.size?tp/expected.size:null,
      limitation:c.exhaustive?null:'precision unjudged: labels are not exhaustive'};
  });
}
/** Uses a trusted local adapter; no provider selection, credential changes or implicit model launch. */
export async function replay(directory:string,adapterOverride?:EvalAdapter,signal?:AbortSignal){
  const packet=JSON.parse(await readFile(path.join(directory,'packet.json'),'utf8'));
  const spec=config.parse(packet.spec);
  for(const file of packet.files){
    if(contentHash(file.text)!==file.sha256)throw new Error('CORRUPT_PACKET');
    if(['adapter','dependency'].includes(file.role)&&contentHash(await readFile(file.file,'utf8'))!==file.sha256)throw new Error('SOURCE_CHANGED: freeze a new experiment');
  }
  const attemptRoot=path.join(directory,'execution-'+randomUUID());await mkdir(attemptRoot);

  const attempts=[];
  const evidenceManifest:Array<{file:string;sha256:string;bytes:number}>=[];
  let output:z.infer<typeof adapterResult>|undefined;
  for(let attempt=1;attempt<=spec.maxAttempts;attempt++){
    const startedAt=new Date().toISOString(),started=Date.now();
    const abort=new AbortController();
    const stop=()=>abort.abort();signal?.addEventListener('abort',stop,{once:true});
    if(signal?.aborted)abort.abort();
    const timer=setTimeout(()=>abort.abort(),spec.timeoutMs);
    const attemptDir=path.join(attemptRoot,String(attempt));await mkdir(attemptDir);
    await immutableJson(path.join(attemptDir,'started.json'),{attempt,startedAt,model:spec.model,settings:spec.settings});
    try{
      if(abort.signal.aborted)throw new Error('ABORTED');
      // Adapter contract: honor signal and stop its children before settling. In-process adapters are trusted code.
      const adapter:EvalAdapter=adapterOverride??await import(pathToFileURL(spec.adapter).href);
      output=adapterResult.parse(await adapter.run({directory:attemptDir,input:packet,signal:abort.signal,attempt}));
      if(abort.signal.aborted)throw new Error('ABORTED');
      if(new Set(output.findings.map(f=>f.caseId)).size!==output.findings.length||output.findings.some(f=>!spec.cases.some(c=>c.id===f.caseId)))throw new Error('Invalid/duplicate case ids');
      for(const evidence of output.evidence){
        const target=await realpath(path.resolve(attemptDir,evidence));
        const actualAttempt=await realpath(attemptDir);
        if(!target.startsWith(actualAttempt+path.sep))throw new Error('Evidence must be in attempt directory');
        const bytes=await readFile(target);
        evidenceManifest.push({file:path.relative(directory,target),sha256:contentHash(bytes),bytes:bytes.length});
      }
      attempts.push({attempt,startedAt,durationMs:Date.now()-started,status:'completed',usage:output.usage});break;
    }catch(e){
      output=undefined;attempts.push({attempt,startedAt,durationMs:Date.now()-started,status:abort.signal.aborted?'aborted':'failed',error:String(e),usage:null});
      if(abort.signal.aborted)break;
    }finally{
      clearTimeout(timer);signal?.removeEventListener('abort',stop);
      await immutableJson(path.join(attemptDir,'finished.json'),attempts.at(-1));
    }
  }
  const result={version:1,inputHash:packet.inputHash,contextHash:packet.contextHash,model:spec.model,workflow:spec.workflow,settings:spec.settings,
    judge:{version:judgeVersion,scope:spec.scope,unexecuted:[...spec.unexecuted,...(output?.unexecuted??[])]},
    status:output?'completed':attempts.at(-1)?.status??'not-run',attempts,evidenceManifest,output:output??null,
    cases:output?judge(spec.cases,output):spec.cases.map(c=>({caseId:c.id,status:'not-run',reason:'execution did not complete'}))};
  await immutableJson(path.join(attemptRoot,'result.json'),result);
  return {resultFile:path.join(attemptRoot,'result.json'),...result};
}
export async function compare(leftFile:string,rightFile:string){
  const left=JSON.parse(await readFile(leftFile,'utf8')),right=JSON.parse(await readFile(rightFile,'utf8'));
  if(left.inputHash!==right.inputHash)throw new Error('PAIR_INPUT_MISMATCH');
  if(JSON.stringify(left.judge)!==JSON.stringify(right.judge))throw new Error('PAIR_JUDGE_SCOPE_MISMATCH');
  return {inputHash:left.inputHash,contextChanged:left.contextHash!==right.contextHash,judge:left.judge,
    comparable:left.status==='completed'&&right.status==='completed'&&left.output.execution===right.output.execution&&left.output.execution!=='existing-artifact',
    comparisonNote:'Existing artifacts do not prove identical original inputs; fixture scores are contract tests, not model quality.',
    left:{model:left.model,status:left.status,execution:left.output?.execution,cases:left.cases,usage:left.output?.usage},
    right:{model:right.model,status:right.status,execution:right.output?.execution,cases:right.cases,usage:right.output?.usage}};
}

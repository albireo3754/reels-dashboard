import {mkdtemp,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {freezeExperiment,replay,compare} from '../src/app/content-evals/runner';
const root=await mkdtemp(path.join(os.tmpdir(),'content-evals-demo-'));
const input=path.join(root,'input.md');await writeFile(input,'Synthetic paragraph with an unwanted repeated caption.');
const spec={version:1,name:'synthetic regression',model:'fixture-only',workflow:'contract-demo',settings:{variant:'baseline'},
 adapter:path.resolve('docs/content-evals-examples/fixture-adapter.mjs'),files:[{role:'input',file:input}],
 cases:[{version:1,id:'caption',rawIds:['0'.repeat(64)],status:'confirmed',split:'development',input:'Synthetic paragraph',expectedFindingIds:['unwanted-caption'],exhaustive:true,confirmation:{actor:'user',by:'synthetic fixture author',evidence:'No real user label: demonstration only',at:'2026-11-13T00:00:00.000Z'}}],
 scope:['synthetic finding IDs'],unexecuted:['model quality','photo/layout quality'],timeoutMs:1000,maxAttempts:1};
const a=await freezeExperiment(spec,path.join(root,'runs'));
const b=await freezeExperiment({...spec,settings:{variant:'regressed'}},path.join(root,'runs'));
const left=await replay(a.directory),right=await replay(b.directory);
const comparison=await compare(left.resultFile,right.resultFile);
await writeFile(path.join(root,'comparison.json'),JSON.stringify(comparison,null,2));
process.stdout.write(JSON.stringify({root,left:left.resultFile,right:right.resultFile,comparison},null,2)+'\n');

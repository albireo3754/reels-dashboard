import {readFile} from 'node:fs/promises';
import {parse} from 'yaml';
import {importDataset,storeCase} from '../src/app/content-evals/dataset';
import {freezeExperiment,replay,compare} from '../src/app/content-evals/runner';
const [command,a,b]=process.argv.slice(2);
const data=async(file:string)=>parse(await readFile(file,'utf8'));
try{
  let result:unknown;
  if(command==='import'&&a&&b)result=await importDataset(await data(a),b);
  else if(command==='case'&&a&&b)result=await storeCase(b,await data(a));
  else if(command==='freeze'&&a&&b)result=await freezeExperiment(await data(a),b).then(x=>({directory:x.directory,inputHash:x.packet.inputHash}));
  else if(command==='replay'&&a)result=await replay(a);
  else if(command==='compare'&&a&&b)result=await compare(a,b);
  else throw new Error('Usage: content-evals.ts import|case|freeze manifest.yaml private-output | replay frozen-directory | compare left-result.json right-result.json');
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  if(command==='import'&&(result as {errors:unknown[]}).errors.length)process.exitCode=1;
}catch(e){process.stderr.write(String(e)+'\n');process.exitCode=1;}

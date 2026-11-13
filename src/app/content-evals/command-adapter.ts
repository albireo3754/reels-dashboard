import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {EvalAdapter} from './runner';
/** Wrap an existing runtime, not a second model engine. The wrapper reads frozen-packet.json and emits the result contract on stdout. */
export function commandAdapter(command:string,args:string[]):EvalAdapter{
  return {async run(ctx){
    const input=path.join(ctx.directory,'frozen-packet.json');
    await writeFile(input,JSON.stringify(ctx.input));
    return new Promise((resolve,reject)=>{
      if(ctx.signal.aborted){reject(new Error('ABORTED'));return;}
      const child=spawn(command,[...args,input],{cwd:ctx.directory,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
      let stdout='',stderr='',overflow=false;
      const kill=()=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
      ctx.signal.addEventListener('abort',kill,{once:true});
      const collect=(stream:'stdout'|'stderr',data:Buffer)=>{
        if(stream==='stdout')stdout+=data.toString();else stderr+=data.toString();
        if(stdout.length+stderr.length>8_000_000){overflow=true;kill();}
      };
      child.stdout.on('data',d=>collect('stdout',d));child.stderr.on('data',d=>collect('stderr',d));
      child.on('error',e=>{ctx.signal.removeEventListener('abort',kill);reject(e);});
      child.on('close',async(code)=>{
        ctx.signal.removeEventListener('abort',kill);
        try{
          await writeFile(path.join(ctx.directory,'stderr.log'),stderr);
          await writeFile(path.join(ctx.directory,'stdout.json'),stdout);
          if(overflow||ctx.signal.aborted||code!==0)throw new Error(`Adapter process failed: code=${code}, aborted=${ctx.signal.aborted}, overflow=${overflow}`);
          resolve(JSON.parse(stdout));
        }catch(e){reject(e);}
      });
    });
  }};
}

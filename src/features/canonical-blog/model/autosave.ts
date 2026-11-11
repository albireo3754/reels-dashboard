export type AutosavePhase="idle"|"waiting"|"saving"|"failed";
export interface AutosaveState{phase:AutosavePhase;failures:number;retryInMs?:number;error?:string}
export interface AutosaveOptions{
  /** Quiet time after the last change before saving. */
  delay?:number;
  maxBackoff?:number;
  /** Saves the latest state; `force` means an explicit save rather than the timer. */
  save:(force:boolean)=>Promise<unknown>;
  onState?:(state:AutosaveState)=>void;
}
/**
 * One save in flight, the latest state wins: changes made during a save start a new
 * quiet period when it ends, and a failure keeps retrying with growing waits.
 */
export function createAutosave({delay=1200,maxBackoff=30000,save,onState}:AutosaveOptions){
  let timer:ReturnType<typeof setTimeout>|undefined;
  let saving=false,dirty=false,again=false,force=false,failures=0,error:string|undefined,stopped=false;
  let waiters:Array<(ok:boolean)=>void>=[];
  const report=(phase:AutosavePhase,retryInMs?:number)=>onState?.({phase,failures,retryInMs,error});
  const clear=()=>{if(timer!==undefined)clearTimeout(timer);timer=undefined;};
  const arm=(ms:number)=>{clear();if(!stopped)timer=setTimeout(()=>void cycle(),ms);};
  const settle=(ok:boolean)=>{const list=waiters;waiters=[];for(const done of list)done(ok);};
  async function cycle(){
    clear();
    if(saving||stopped)return;
    saving=true;dirty=false;again=false;
    const forced=force;force=false;
    if(!failures)report("saving");
    try{await save(forced);failures=0;error=undefined;}
    catch(e){
      // An explicit save stays explicit through its retries.
      saving=false;failures++;dirty=true;force=force||forced;
      error=e instanceof Error?e.message:String(e);
      const wait=Math.min(maxBackoff,1000*2**(failures-1));
      report("failed",wait);settle(false);arm(wait);
      return;
    }
    saving=false;
    if(again)return void cycle();
    if(dirty){report("waiting");arm(delay);}
    else report("idle");
    settle(true);
  }
  return {
    /** A change happened: save once things go quiet. A running retry keeps its own timing. */
    touch(){
      dirty=true;
      if(saving||failures)return;
      report("waiting");arm(delay);
    },
    /** Saves now, or right after the save in flight. Resolves false when that save fails. */
    flush(explicit=false){
      force=force||explicit;
      const done=new Promise<boolean>(resolve=>waiters.push(resolve));
      if(saving)again=true;else void cycle();
      return done;
    },
    get pending(){return dirty||saving||timer!==undefined;},
    stop(){stopped=true;clear();settle(false);},
  };
}

import {ZodError} from "zod";
import {workflowRequest} from "../workflow/client";
import type {MarkupStore} from "./markup-store";
import {cleanSuggestions,type BlogSuggestResponse,type InlineSuggestInput} from "../../shared/inline-suggest";

/** Calls the workflow backend's synchronous `suggest-inline` action. Replaceable in tests. */
export type SuggestCall=(input:InlineSuggestInput,signal:AbortSignal)=>Promise<unknown>;
export const workflowSuggest:SuggestCall=(input,signal)=>workflowRequest("suggest-inline",input,undefined,signal);

export const SUGGEST_MESSAGES={
  unsupported:"이 형식에서는 추천을 지원하지 않아요.",
  unreachable:"추천 엔진에 연결하지 못했어요. 워크플로 서버가 실행 중인지 확인해주세요.",
  timeout:"추천이 너무 오래 걸려 중단했어요. 다시 요청해주세요.",
} as const;

export function suggestTimeoutMs(env:NodeJS.ProcessEnv=process.env){
  const value=Number(env.REELS_SUGGEST_TIMEOUT_MS??90000);
  return Number.isInteger(value)&&value>=1000&&value<=600000?value:90000;
}

/**
 * POST /api/blog/suggest. Never writes files: it reads the current document, builds the
 * caret context from the writer's unsaved paragraph, asks the workflow engine, and returns
 * cleaned ghost-text candidates. Validity against later edits is checked by the client.
 */
export async function handleSuggest(store:MarkupStore|undefined,value:unknown,signal:AbortSignal,call:SuggestCall=workflowSuggest):Promise<{status:number;body:unknown}>{
  if(!store)return {status:400,body:{error:SUGGEST_MESSAGES.unsupported}};
  let input:InlineSuggestInput;
  try{input=await store.suggestInput(value);}
  catch(e){
    const message=e instanceof ZodError?"추천 요청 형식이 올바르지 않아요.":e instanceof Error?e.message:String(e);
    return {status:/편집 기준이 만료/.test(message)?409:400,body:{error:message}};
  }
  const started=Date.now();
  // The engine has its own timeout; this one only guards against a hung connection.
  const timeout=AbortSignal.timeout(suggestTimeoutMs()+10000);
  try{
    const raw:any=await call(input,AbortSignal.any([signal,timeout]));
    const suggestions=cleanSuggestions(raw,input);
    const response:BlogSuggestResponse={requestId:input.id,revision:(value as {revision:string}).revision,paragraphId:input.paragraphId,offset:(value as {offset:number}).offset,suggestions,elapsedMs:typeof raw?.elapsedMs==="number"?raw.elapsedMs:Date.now()-started};
    return {status:200,body:response};
  }catch(e){
    if(signal.aborted)return {status:499,body:{error:"추천 요청이 취소됐어요."}};
    const message=e instanceof Error?e.message:String(e);
    if(timeout.aborted||/SUGGEST_TIMEOUT/.test(message))return {status:504,body:{error:SUGGEST_MESSAGES.timeout}};
    // fetch() rejects with TypeError on connection failure; a non-JSON reply means the URL is not the workflow server.
    if(e instanceof TypeError||e instanceof SyntaxError)return {status:502,body:{error:SUGGEST_MESSAGES.unreachable}};
    return {status:502,body:{error:"추천을 만들지 못했어요: "+message.replace(/^SUGGEST_\w+:\s*/,"").slice(0,500)}};
  }
}

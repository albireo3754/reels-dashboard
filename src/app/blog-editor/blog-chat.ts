import {ZodError} from "zod";
import {workflowRequest} from "../workflow/client";
import type {MarkupStore} from "./markup-store";
import {cleanChatResult,type BlogChatInput,type BlogChatResponse} from "../../shared/blog-chat";

/** Calls the workflow backend's synchronous `chat-blog` action. Replaceable in tests. */
export type ChatCall=(input:BlogChatInput,signal:AbortSignal)=>Promise<unknown>;
export const workflowChat:ChatCall=(input,signal)=>workflowRequest("chat-blog",input,undefined,signal);

export const CHAT_MESSAGES={
  unsupported:"이 형식에서는 채팅을 지원하지 않아요.",
  unreachable:"채팅 엔진에 연결하지 못했어요. 워크플로 서버가 실행 중인지 확인해주세요.",
  timeout:"답변이 너무 오래 걸려 중단했어요. 다시 질문해주세요.",
  empty:"답변을 받지 못했어요. 질문을 바꿔 다시 시도해주세요.",
} as const;

export function chatTimeoutMs(env:NodeJS.ProcessEnv=process.env){
  const value=Number(env.REELS_CHAT_TIMEOUT_MS??120000);
  return Number.isInteger(value)&&value>=1000&&value<=600000?value:120000;
}

/**
 * POST /api/blog/chat. Never writes files: it builds read-only context around the
 * attached phrases (unsaved text included), asks the workflow engine, and returns a
 * reply plus rewrite candidates the editor re-validates before `본문에 반영`.
 */
export async function handleChat(store:MarkupStore|undefined,value:unknown,signal:AbortSignal,call:ChatCall=workflowChat):Promise<{status:number;body:unknown}>{
  if(!store)return {status:400,body:{error:CHAT_MESSAGES.unsupported}};
  let input:BlogChatInput;
  try{input=await store.chatInput(value);}
  catch(e){
    const message=e instanceof ZodError?"채팅 요청 형식이 올바르지 않아요.":e instanceof Error?e.message:String(e);
    return {status:/편집 기준이 만료/.test(message)?409:400,body:{error:message}};
  }
  const started=Date.now();
  const timeout=AbortSignal.timeout(chatTimeoutMs()+10000);
  try{
    const raw:any=await call(input,AbortSignal.any([signal,timeout]));
    const {reply,rewrites}=cleanChatResult(raw,input);
    if(!reply&&!rewrites.length)return {status:502,body:{error:CHAT_MESSAGES.empty}};
    const response:BlogChatResponse={requestId:input.id,revision:(value as {revision:string}).revision,reply,rewrites,elapsedMs:typeof raw?.elapsedMs==="number"?raw.elapsedMs:Date.now()-started};
    return {status:200,body:response};
  }catch(e){
    if(signal.aborted)return {status:499,body:{error:"질문을 취소했어요."}};
    const message=e instanceof Error?e.message:String(e);
    if(timeout.aborted||/CHAT_TIMEOUT/.test(message))return {status:504,body:{error:CHAT_MESSAGES.timeout}};
    if(e instanceof TypeError||e instanceof SyntaxError)return {status:502,body:{error:CHAT_MESSAGES.unreachable}};
    return {status:502,body:{error:"답변을 만들지 못했어요: "+message.replace(/^CHAT_\w+:\s*/,"").slice(0,500)}};
  }
}

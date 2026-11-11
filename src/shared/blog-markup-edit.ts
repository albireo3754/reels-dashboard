import type {MarkStyle,ParagraphNode} from "./blog-markup";
import {cssHex,readInline,type InlineRun} from "./canonical-blog";

/**
 * Typing must never make a paragraph unsavable. Characters that mean something to the
 * manuscript or the inline source are swapped one-for-one with look-alikes, so offsets
 * and marks stay valid: <> ⟦⟧ become full-width forms, ** and == their full-width pair,
 * and a line that would read as a `¶ id` header or a footnote gets a no-break space.
 */
export function safePlain(text:string):string{
  const swap:Record<string,string>={"<":"＜",">":"＞","⟦":"〚","⟧":"〛"};
  return text.replace(/[<>⟦⟧]/g,c=>swap[c])
    .replace(/\*\*/g,"＊＊").replace(/==/g,"＝＝")
    .replace(/^¶ /gm,"¶ ")
    .replace(/^ {2}(?=(?:[⁰¹²³⁴⁵⁶⁷⁸⁹]+|\^\d+|※) )/gm,"  ");
}
/** Editor runs made safe for the source: no CR, safe characters, no blank lines at either end. */
export function safeRuns(runs:InlineRun[]):InlineRun[]{
  const clean=runs.map(r=>({...r,text:r.text.replace(/\r\n?/g,"\n")}));
  const safe=safePlain(clean.map(r=>r.text).join(""));
  if(!safe.trim())return [];
  const start=/^(?:\s*\n)*/.exec(safe)![0].length;
  const end=safe.length-/(?:\n\s*)*$/.exec(safe)![0].length;
  const out:InlineRun[]=[];let at=0;
  for(const run of clean){
    const lo=Math.max(at,start),hi=Math.min(at+run.text.length,end);
    if(lo<hi)out.push({...run,text:safe.slice(lo,hi)});
    at+=run.text.length;
  }
  return out;
}
function rebuilt(original:ParagraphNode,runs:InlineRun[]):ParagraphNode{
  const text=runs.map(r=>r.text).join("");
  const result:ParagraphNode={kind:"paragraph",id:original.id,lines:text?text.split("\n"):[],marks:[],notes:[]};
  let line=0,column=0;
  for(const run of runs){
    run.text.split("\n").forEach((part,i)=>{
      if(i){line++;column=0;}
      if(part&&Object.keys(run.style).length){
        const style:MarkStyle={};
        if(run.style.color)style.color=cssHex(run.style.color);
        if(run.style.background)style.background=cssHex(run.style.background);
        if(run.style.weight===700)style.weight=700;
        if(run.style.size)style.size=run.style.size;
        const old=original.marks.find(m=>original.lines[m.line]?.slice(m.start,m.end)===part);
        if(style.size)style.sizeRole=old?.style.size===style.size?old.style.sizeRole:style.size<16?"down":"up";
        result.marks.push({n:result.marks.length+1,line,start:column,end:column+part.length,style,role:old?.role??"사용자 편집"});
      }
      column+=part.length;
    });
  }
  return result;
}
/**
 * The paragraphs an edit produces. A blank line inside the text ends a paragraph: the
 * first part keeps the id, each later part takes a new one, and marks follow their line.
 * Only malformed inline source throws, and the caller then skips this paragraph alone.
 */
export function editedParagraphs(original:ParagraphNode,source:string,nextId:()=>string):ParagraphNode[]{
  const whole=rebuilt(original,safeRuns(readInline(source)));
  const groups:number[][]=[[]];
  whole.lines.forEach((line,i)=>{
    if(line.trim())groups.at(-1)!.push(i);
    else if(groups.at(-1)!.length)groups.push([]);
  });
  return groups.filter((g,i)=>g.length||!i).map((lines,i)=>{
    const marks=whole.marks.filter(m=>lines.includes(m.line)).map((m,n)=>({...m,n:n+1,line:lines.indexOf(m.line)}));
    return {...whole,id:i?nextId():original.id,lines:lines.map(l=>whole.lines[l]),marks};
  });
}
/** The same text for read-only context (suggestions, chat): one paragraph, blank lines closed up. */
export function editedFlat(original:ParagraphNode,source:string):ParagraphNode{
  const parts=editedParagraphs(original,source,()=>original.id);
  let offset=0;
  const marks=parts.flatMap(p=>{const shifted=p.marks.map(m=>({...m,line:m.line+offset}));offset+=p.lines.length;return shifted;});
  return {...parts[0],lines:parts.flatMap(p=>p.lines),marks:marks.map((m,i)=>({...m,n:i+1}))};
}

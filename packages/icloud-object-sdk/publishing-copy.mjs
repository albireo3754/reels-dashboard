// Export only copy blocks from a registered canonical content document.
// Research notes, other Markdown sections and local paths stay on the Mac.
export function parsePublishingCopy(markdown, contentId) {
 const source=markdown.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n');
 const front=/^---\n([\s\S]*?)\n---(?:\n|$)/.exec(source);
 if(!front)return null;
 const id=/^content_id:\s*["']?([^\s"']+)["']?\s*$/m.exec(front[1])?.[1];
 if(!id||`content:${id}`!==contentId)return null;
 const publicationStatus=/^publication_status:\s*["']?([\w-]+)["']?\s*$/m.exec(front[1])?.[1]??'unknown';
 const sections=[];let heading=null,fence=null,lines=[],copyFence=false;
 for(const line of source.slice(front[0].length).split('\n')) {
  if(fence){
   if(new RegExp(`^${fence[0]}{${fence.length},}\\s*$`).test(line)){
    const text=lines.join('\n').trim();
    if(copyFence&&heading&&text&&text.length<=20000)sections.push({...heading,text});
    fence=null;lines=[];
   }else lines.push(line);
   continue;
  }
  const title=/^##\s+(.+?)\s*$/.exec(line)?.[1];
  if(title){
   const match=/^(캡션|댓글|대댓글)(?:\s+(\d+))?$/.exec(title);
   heading=match?{id:match[1]==='캡션'?'caption':`${match[1]==='댓글'?'comment':'reply'}-${match[2]??'1'}`,kind:match[1]==='캡션'?'caption':match[1]==='댓글'?'comment':'reply',label:title,parentId:match[1]==='대댓글'?`comment-${match[2]??'1'}`:null}:null;
  }
  const start=/^(`{3,}|~{3,})([^\s]*)\s*$/.exec(line);
  if(start){fence=start[1];copyFence=['','text','plaintext'].includes(start[2]);lines=[];}
 }
 // Ambiguous alternate versions must not look like one confirmed copy block.
 const unique=sections.filter(s=>sections.filter(x=>x.id===s.id).length===1);
 const linked=unique.map(s=>s.parentId&&!unique.some(x=>x.id===s.parentId)?{...s,parentId:null}:s);
 return {status:linked.length?'ready':'empty',publicationStatus,sections:linked.slice(0,30)};
}

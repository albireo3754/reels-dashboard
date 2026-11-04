import {blogSpan,blogStyle,type BlogBlock,type BlogStyle} from '../../../shared/blog';
/** Imports only an explicitly selected spec; URLs never become remote image requests. */
export function importSpec(selection:string, folder:string, createId:()=>string):{blocks:BlogBlock[];style:BlogStyle} {
  const match=selection.match(/```json\s*([\s\S]*?)```/i);
  const value=JSON.parse(match ? match[1] : selection) as {title?:unknown;blocks?:unknown;spans?:unknown;layout?:Record<string,unknown>;fonts?:Record<string,unknown>};
  if(!Array.isArray(value.blocks) || value.blocks.length>300) throw new Error('유효한 render-spec 블록이 필요해요.');
  const spans=Array.isArray(value.spans)?value.spans.map(v=>blogSpan.parse(v)):[];
  const layout=value.layout??{},fonts=value.fonts??{};
  const style=blogStyle.parse(Object.fromEntries(Object.entries({bodyFont:fonts.body,infoFont:fonts.info,background:layout.background,color:layout.color,headingColor:layout.headingColor,paragraphSize:layout.paragraphSize,mobileParagraphSize:layout.mobileParagraphSize,headingSize:layout.headingSize,lineHeight:layout.lineHeight,align:layout.align,desktopWidth:layout.desktopWidth,mobileWidth:layout.mobileWidth,padding:layout.padding,headingWeight:layout.headingWeight,imageRadius:layout.imageRadius}).filter(([,v])=>v!==undefined)));
  const used=new Set<string>(); const blocks:BlogBlock[]=[];
  if(typeof value.title==='string' && value.title.trim()) {if(value.title.length>20000) throw new Error('제목이 너무 길어요.'); blocks.push({id:createId(),type:'text',text:value.title,role:'title'});}
  for(const raw of value.blocks) {
    if(!raw || typeof raw!=='object') throw new Error('유효하지 않은 블록이에요.');
    const item=raw as Record<string,unknown>;
    if(item.type==='image') {
      if(!folder) throw new Error('이미지에 연결할 사진 폴더를 먼저 선택해주세요.');
      if(typeof item.src!=='string' || /^(?:[a-z]+:|\/)/i.test(item.src) || item.src.split('/').some(p=>p==='..' || p==='.' || !p)) throw new Error('로컬 상대 이미지 이름만 가져올 수 있어요.');
      const name=item.src.split('/').at(-1)!;
      if(!/\.(?:jpe?g|png|webp|heic)$/i.test(name)) throw new Error('지원하지 않는 이미지예요.');
      blocks.push({id:createId(),type:'image',path:folder.replace(/\/$/,'')+'/'+name,alt:typeof item.alt==='string'?item.alt.slice(0,500):name});
    } else {
      const text=typeof item.text==='string'?item.text:typeof item.label==='string'?item.label:'';
      if(text) {if(text.length>20000) throw new Error('너무 긴 텍스트 블록이에요.'); const role=item.type==='heading'?'heading':item.type==='info'?'info':item.type==='source'?'source':item.type==='tags'?'tags':typeof item.type==='string'&&item.type.startsWith('native-')?'native':'paragraph'; const selected=spans.filter(s=>text.includes(s.text)&&(!used.has(s.text)||s.occurrence!=='first'));selected.forEach(s=>used.add(s.text));blocks.push({id:createId(),type:'text',text,role,spans:selected});}
    }
  }
  if(!blocks.length) throw new Error('가져올 블록이 없어요.');
  return {blocks,style};
}

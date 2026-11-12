import { isSticker, stickerHtml, STICKER_CSS, type StickerPreset } from "./blog-stickers";
import { collageRatios, collageRows, type MarkupDoc, type ParagraphNode, type ComponentNode } from "./blog-markup";
import { escapeHtml } from "./canonical-blog";
const esc=(s:unknown)=>escapeHtml(String(s??""));
const safeUrl=(s:string)=> /^(https?:\/\/[^\s]+|(?!(?:[a-z]+:|\/\/))[^\s]*)$/i.test(s)?s:"";
function inline(s:string) {
  return esc(s).replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,(_,label,url)=>`<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`);
}
function paragraph(p:ParagraphNode) {
  return p.lines.map((line,i)=>{
    let at=0,out="";
    for(const m of [...p.marks].filter(m=>m.line===i).sort((a,b)=>a.start-b.start)) {
      const s=m.style,css:string[]=[];
      if(s.weight)css.push("font-weight: 700");
      if(s.color)css.push("color: "+s.color);
      if(s.background)css.push("background-color: "+s.background);
      if(s.size)css.push("font-size: "+s.size+"px");
      const attrs=s.size?` data-se-fs="fs${s.size}"`+(s.sizeRole?` data-size-role="${esc(s.sizeRole)}"`:""):"";
      out+=inline(line.slice(at,m.start))+`<span${attrs} style="${esc(css.join("; "))};">${inline(line.slice(m.start,m.end))}</span>`;
      at=m.end;
    }
    return out+inline(line.slice(at));
  }).join("<br>");
}
export interface RenderStyle {media?:string;bodyFont?:string;infoFont?:string;bodyPx?:number;mobileBodyPx?:number;headingPx?:number;headingColor?:string;align?:string;lineHeight?:number}
export function renderHtml(doc:MarkupDoc,style:RenderStyle={}, editable=false):string {
  const theme={...(doc.metadata?.style as RenderStyle??{}),...style};
  const media=style.media??String(doc.metadata?.media??"");
  const img=(file:string,alt:string)=>`<img alt="${esc(alt)}" src="${esc(safeUrl(media+file))}">`;
  const editing=(p:ParagraphNode)=>editable?` contenteditable="true" spellcheck="false" data-tid="${esc(p.id)}" role="textbox" aria-label="${esc(p.id)} 문단"`:"";
  function component(n:ComponentNode):string {
    const a=n.attrs;const children=n.children??[];
    switch(n.tag) {
      case "Sticker":return stickerHtml({id:String(a.id),preset:String(a.preset) as StickerPreset,note:a.note?String(a.note):undefined});
      case "Photo": {const i=img(String(a.file??""),String(a.alt??""));return a.pair?`<div class="photo-group" data-layout="precomposed"><figure class="photo-block" data-component="PhotoGroup">${i}</figure></div>`:`<figure class="photo-block" data-component="PhotoBlock">${i}</figure>`;}
      case "Collage": {
        const files=String(a.files??"").split(" · "),alts=String(a.alts??"").split(" · "),ratios=collageRatios(a.ratios,files.length);
        if(ratios){
          // Justified rows: each cell grows by its own width/height, so a row of mixed ratios shares one height.
          const cell=(k:number)=>`<div style="--r:${Number(ratios[k].toFixed(4))}">${img(files[k],alts[k]??"")}</div>`;
          let at=0;
          const rows=collageRows(String(a.layout??""),files.length).map(size=>{
            const cells=Array.from({length:size},(_,i)=>cell(at+i)).join("");
            at+=size;
            return `<div class="collage-row">${cells}</div>`;
          }).join("");
          return `<figure class="photo-collage-rows" data-component="PhotoCollageRows" data-layout="${esc(a.layout)}">${rows}</figure>`;
        }
        return `<figure class="photo-grid4 even" data-component="PhotoCollage4" data-layout="${esc(a.layout)}">${String(a.files??"").split(" · ").map((f,i)=>`<div>${img(f,String(a.alts??"").split(" · ")[i]??"")}</div>`).join("")}</figure>`;
      }
      case "Heading":return `<blockquote class="section-heading"><h2>${esc(n.text)}</h2></blockquote>`;
      case "Title":return `<header><h1>${esc(n.text)}</h1></header>`;
      case "Tags":return `<p class="tags">${esc(n.text)}</p>`;
      case "Divider":return '<hr class="scene-divider">';
      case "PriceBox":return `<blockquote class="price-box" aria-label="내돈내산 가격">${children.map(p=>`<p${editing(p)}>${paragraph(p)}</p>`).join("")}</blockquote>`;
      case "VisitCard":return `<section class="visit-card" aria-label="방문 정보"><div class="card-label">방문 정보</div>${children.map((p,i)=>`<p class="${i===children.length-1?"source":"info"}"${editing(p)}>${paragraph(p)}</p>`).join("")}</section>`;
      case "Info":case "Source":return `<section class="${n.tag.toLowerCase()}">${children.map(p=>`<p${editing(p)}>${paragraph(p)}</p>`).join("")}</section>`;
      case "QuestionCard":return `<aside class="native-card"><small>From, 블로그씨</small><div>${esc(a.topic)}</div><small class="native-note">원래 질문 카드가 들어갈 자리</small></aside>`;
      case "Map":return `<aside class="native-card"><small>네이버 지도 · 기존 컴포넌트 유지</small><div>${esc(a.place)}</div>${a.href?`<a href="${esc(safeUrl(String(a.href)))}" target="_blank" rel="noreferrer">장소 확인 ↗</a>`:""}</aside>`;
    }
  }
  const css:string[]=[];
  for(const [key,value] of Object.entries(theme)) {
    if(key==="media")continue;
    if(typeof value==="number"&&Number.isFinite(value))css.push(`--${key}:${value}${key.endsWith("Px")?"px":""}`);
    else if(typeof value==="string"&&/^[\w #,.-]+$/.test(value))css.push(`--${key}:${key.endsWith("Font")&&!value.startsWith("se-")?"se-"+value:value}`);
  }
  return `<article${css.length?` style="${esc(css.join(";"))}"`:""}>`+doc.bundles.map(b=>{
    let nodeIndex=0;
    const content=b.nodes.map((n,i)=>{
      const index=isSticker(n)?undefined:nodeIndex++;
      // Keep original node indexes even when the duplicate source Title is hidden.
      if(editable&&n.kind==="component"&&n.tag==="Title")return "";
      const fragment=n.kind==="paragraph"?`<p class="paragraph"${editing(n)}>${paragraph(n)}</p>`:n.kind==="unknown"?`<aside class="unknown-component" data-component="Unknown" title="이 버전이 모르는 컴포넌트예요. 원문은 그대로 보존돼요."><code>${esc(n.source)}</code></aside>`:component(n);
      return fragment.replace(/^<(\w+)/, `<$1 data-bundle="${esc(b.id)}"`+(editable&&index!==undefined?` data-node-index="${index}"`:"")+(i===0?` data-bundle-start data-bundle-name="${esc(b.name)}"`:""));
    }).join("");
    return (editable?`<section class="editor-bundle" data-bundle="${esc(b.id)}"><div class="editor-bundle-label">${esc(b.name)}</div>`:"")+content+(editable?"</section>":"");
  }).join("")+"</article>";
}


// Added to an existing layout shell by the CLI. Its dimensions/photo rules stay in the shell.
export const MARKUP_STYLE_CSS = `<style id="blog-markup-theme">
${STICKER_CSS}
article{font-family:var(--bodyFont,se-nanumbareunhipi);font-size:var(--bodyPx,16px);text-align:var(--align,center);line-height:var(--lineHeight,1.8)}
article .info,article .source,article .price-box,article .visit-card,article .native-card,article .tags,article h2{font-family:var(--infoFont,se-nanumgothic)}
article .section-heading h2,main.mobile article .section-heading h2{font-size:var(--headingPx,19px);color:var(--headingColor,#85613f)}
main.mobile article{font-size:var(--mobileBodyPx,17px)}
article .photo-collage-rows{display:flex;flex-direction:column;gap:8px;margin:30px 0}
article .photo-collage-rows .collage-row{display:flex;gap:8px}
article .photo-collage-rows .collage-row>div{flex:var(--r,1) 1 0;min-width:0;aspect-ratio:var(--r,1);overflow:hidden}
article .photo-collage-rows img{display:block;width:100%;height:100%;max-width:none;margin:0;object-fit:cover}
article .unknown-component{margin:24px 0;padding:10px 12px;border:1px dashed #bbb;border-radius:6px;background:#fafafa;text-align:left}
article .unknown-component code{font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#555;white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-width:600px){article .photo-collage-rows,article .photo-collage-rows .collage-row{gap:6px}}
@media(max-width:600px){article{font-size:var(--mobileBodyPx,17px)}}
</style>`;

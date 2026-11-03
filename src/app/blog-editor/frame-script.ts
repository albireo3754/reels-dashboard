/** Runs only inside the same-origin, dedicated editor frame. Never evaluates article HTML. */
export const frameScript = String.raw`
const send=(data)=>parent.postMessage({editor:true,...data},location.origin);
// The host page owns scrolling. Also remove the classic macOS scrollbar gutter,
// even when a manuscript stylesheet reserves one. Standalone previews still scroll.
if(parent!==window){
 document.documentElement.style.overflow='hidden';
 document.documentElement.style.scrollbarGutter='auto';
}
let selected, savedRange;
// Transient AI ghost text (review-only; see the keyboard suggestion section below).
let ghost=null;
const hex=v=>{const m=v?.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);return m?'#'+m.slice(1).map(x=>Number(x).toString(16).padStart(2,'0')).join(''):null;};

const quick=document.createElement('div');
quick.setAttribute('role','toolbar');quick.setAttribute('aria-label','구절 바로 편집');
quick.style.cssText='position:absolute;z-index:1000;display:none;gap:4px;padding:7px;border:1px solid #b5c7bd;border-radius:9px;background:white;box-shadow:0 3px 12px #0002;font:13px sans-serif;max-width:95%;flex-wrap:wrap';
document.body.append(quick);
function quickButton(label,action){const b=document.createElement('button');b.type='button';b.textContent=label;b.style.cssText='font:13px sans-serif;padding:6px 8px;border:1px solid #ccd8cf;background:#fff;border-radius:5px;cursor:pointer';b.addEventListener('mousedown',e=>e.preventDefault());b.addEventListener('click',action);quick.append(b);}
quickButton('적갈색',()=>formatRange('foreColor','#a64132'));
quickButton('노랑 형광펜',()=>formatRange('hiliteColor','#fff8b2'));
if(document.documentElement.dataset.markup==='true')quickButton('메모',()=>annotate(false));
if(document.documentElement.dataset.markup==='true')quickButton('✓ 체크',()=>annotate(true));
function annotate(checked){
 removeGhost();
 if(!selected||!savedRange||savedRange.collapsed||selected.contentEditable!=='true')return;
 send({type:'annotate',id:selected.dataset.tid,text:savedRange.toString(),context:serialize(selected).map(r=>r.text).join(''),checked});
 quick.style.display='none';
}
document.addEventListener('pointerdown',e=>{if(!quick.contains(e.target)&&!e.target.closest('[data-tid]'))quick.style.display='none';});


async function annotationBadges(){
 if(document.documentElement.dataset.markup!=='true')return;
 try{
  const response=await fetch('/api/blog/annotations');if(!response.ok)return;
  const items=await response.json();document.querySelectorAll('[data-annotation-badge]').forEach(e=>e.remove());
  for(const p of document.querySelectorAll('[data-tid]')){
   const notes=items.filter(a=>a.paragraphId===p.dataset.tid);if(!notes.length)continue;
   const b=document.createElement('button');b.type='button';b.dataset.annotationBadge='true';
   b.textContent='메모 '+notes.length+' · ✓ '+notes.filter(n=>n.checked).length;
   b.style.cssText='font:12px sans-serif;color:#4d6c55;background:#edf4e9;border:1px solid #bfcebb;border-radius:5px;padding:5px 8px;margin:-14px 0 18px';
   b.addEventListener('click',()=>send({type:'annotation-open',id:p.dataset.tid}));p.after(b);
  }
 }catch{}
}
void annotationBadges();
function selectionState(){
 // A selection that moved across the ghost drops it first, so its text is never reported.
 if(ghost){const c=caretInfo();if(!c||c.p!==ghost.p||!c.collapsed||c.offset!==ghost.offset)removeGhost();}
 const sel=window.getSelection();if(!sel?.rangeCount)return;const range=sel.getRangeAt(0);
 const start=(range.startContainer.nodeType===1?range.startContainer:range.startContainer.parentElement)?.closest('[data-tid]');
 const end=(range.endContainer.nodeType===1?range.endContainer:range.endContainer.parentElement)?.closest('[data-tid]');
 if(!start||start!==end){quick.style.display='none';send({type:'selection',selection:null});return;}
 selected=start;savedRange=range.cloneRange();
 if(!range.collapsed&&start.dataset.tid!=='$title'){
  const rect=range.getBoundingClientRect();
  quick.style.display='flex';quick.style.left=Math.max(4,Math.min(rect.left,document.documentElement.clientWidth-quick.offsetWidth-4))+'px';
  quick.style.top=(rect.bottom+scrollY+6)+'px';
 }else quick.style.display='none';
 const values=[];const walker=document.createTreeWalker(start,NodeFilter.SHOW_TEXT);let node;
 while(node=walker.nextNode()){if(!range.intersectsNode(node)||!node.textContent||(range.startContainer===node&&range.startOffset===node.length)||(range.endContainer===node&&range.endOffset===0))continue;const css=getComputedStyle(node.parentElement);let el=node.parentElement,bg=null;while(el&&start.contains(el)){const c=getComputedStyle(el).backgroundColor;if(c!=='rgba(0, 0, 0, 0)'&&c!=='transparent'){bg=hex(c);break;}el=el.parentElement;}values.push({size:Math.round(parseFloat(css.fontSize)),bold:Number(css.fontWeight)>=600,color:hex(css.color),background:bg});}
 const common=k=>values.length&&values.every(v=>v[k]===values[0][k])?values[0][k]:null;
 send({type:'selection',selection:{id:start.dataset.tid,text:range.toString(),size:common('size'),bold:common('bold'),color:common('color'),background:common('background')}});
}
document.addEventListener('selectionchange',selectionState);
const color=v=>v&&(/^#[\da-f]{6}$/i.test(v)||/^rgb\(\d+,\s*\d+,\s*\d+\)$/.test(v))?v.replace(/\s/g,''):undefined;
function serialize(root){
 const runs=[];
 function walk(node,style={}){
  if(node.nodeType===3){if(node.textContent)runs.push({text:node.textContent,style});return;}
  if(node.nodeType!==1||node.hasAttribute('data-review-ui'))return;
  if(node.tagName==='BR'){runs.push({text:'\n',style:{}});return;}
  const next={...style};
  const c=color(node.style.color||node.getAttribute('color'));const bg=color(node.style.backgroundColor);
  if(c)next.color=c;if(bg)next.background=bg;
  if(node.tagName==='B'||node.tagName==='STRONG'||node.style.fontWeight==='700'||node.style.fontWeight==='bold')next.weight=700;
  if(node.style.fontWeight==='400'||node.style.fontWeight==='normal')delete next.weight;
  if(node.style.backgroundColor==='transparent'||node.style.backgroundColor==='rgba(0, 0, 0, 0)')delete next.background;
  if(node.style.fontSize){const n=parseFloat(node.style.fontSize);if(n>0&&n<=64)next.size=node.style.fontSize.endsWith('em')?n*16:n;}
  if(node.tagName==='A'){const href=node.getAttribute('href');if(/^https?:\/\//.test(href||'')){runs.push({text:'['+node.textContent+']('+href+')',style:next});return;}}
  const block=['DIV','P'].includes(node.tagName)&&node!==root;
  if(block&&runs.length&&!runs.at(-1).text.endsWith('\n'))runs.push({text:'\n',style:{}});
  for(const child of node.childNodes)walk(child,next);
 }
 for(const child of root.childNodes)walk(child);
 return runs;
}
/** Run fingerprint that ignores where text nodes happen to be split (review nodes split them). */
function runsKey(runs){
 const out=[];
 for(const r of runs){const k=JSON.stringify(r.style||{}),last=out.at(-1);if(last&&last.k===k)last.text+=r.text;else out.push({k,text:r.text});}
 return JSON.stringify(out);
}
function change(el){if(ghost&&ghost.p===el)removeGhost();send({type:'change',id:el.dataset.tid,runs:serialize(el)});}
document.addEventListener('click',e=>{
 const node=e.target.closest('[data-node-index]');
 if(node&&document.documentElement.dataset.markup==='true')send({type:'sticker-anchor',bundleId:node.dataset.bundle,before:Number(node.dataset.nodeIndex)+1});
});
let picked=null;function pick(b){document.querySelectorAll('.editor-bundle.picked').forEach(x=>x.classList.remove('picked'));picked=b||null;if(picked)picked.classList.add('picked');}
document.addEventListener('focusin',e=>{const el=e.target.closest('[data-tid]');if(!el)return;pick(null);selected=el;document.querySelectorAll('.active').forEach(x=>x.classList.remove('active'));const b=el.closest('[data-bundle]');b?.classList.add('active');send({type:'select',id:el.dataset.tid,bundleId:b?.dataset.bundle});});
document.addEventListener('input',e=>{const el=e.target.closest('[data-tid]');if(!el)return;change(el);if(review.items.length)holdParagraph(el);});
document.addEventListener('paste',e=>{if(!e.target.closest('[data-tid]'))return;e.preventDefault();document.execCommand('insertText',false,e.clipboardData.getData('text/plain').replace(/\n\s*\n/g,'\n'));});
document.addEventListener('drop',e=>e.preventDefault());
document.addEventListener('keydown',e=>{
 if(e.isComposing||e.keyCode===229)return;
 // Cmd/Ctrl+S saves from inside the frame too; keydown does not bubble to the host page.
 if((e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.code==='KeyS'){e.preventDefault();e.stopImmediatePropagation();send({type:'save'});return;}
 // A bundle picked by clicking outside its text is deleted with Delete/Backspace.
 if(picked&&(e.key==='Delete'||e.key==='Backspace')&&!e.metaKey&&!e.ctrlKey&&!e.altKey&&!(e.target.closest&&e.target.closest('[data-tid],input,textarea,[contenteditable="true"]'))){e.preventDefault();e.stopImmediatePropagation();send({type:'delete-bundle',bundleId:picked.dataset.bundle});return;}
 if(picked&&e.key==='Escape')pick(null);
},true);
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'&&!e.isComposing){e.preventDefault();send({type:'review',scope:e.shiftKey?'changed':'selected'});}else if(e.key==='Enter'&&e.target.closest('[data-tid]')){e.preventDefault();if(e.target.dataset.tid!=='$title')document.execCommand('insertLineBreak');}});
document.addEventListener('click',e=>{if(e.target.closest('a'))e.preventDefault();const b=e.target.closest('[data-bundle]');if(b)send({type:'select',bundleId:b.dataset.bundle});const sec=e.target.closest('.editor-bundle');pick(sec&&!e.target.closest('[data-tid],[data-review-ui]')?sec:null);});
function formatRange(command,value){removeGhost();if(!selected||!savedRange||savedRange.collapsed||selected.contentEditable!=='true')return;
  // Take the paragraph's review nodes out first so execCommand never wraps or copies them.
  if(selected.querySelector('[data-review-ui]')){
   // A live clone follows the node removal/normalize, so a selection inside a link label
   // (where plain offsets only reach the link's start or end) keeps its exact endpoints.
   const live=savedRange.cloneRange(),len=live.toString().length;
   const map=plainMap(selected),a=offsetOf(selected,savedRange.startContainer,savedRange.startOffset,map),b=offsetOf(selected,savedRange.endContainer,savedRange.endOffset,map);
   holdParagraph(selected);
   const ok=(n,o)=>n&&n.nodeType===3&&n.isConnected&&selected.contains(n)&&!n.parentElement.closest('[data-review-ui]')&&o<=n.length;
   if(ok(live.startContainer,live.startOffset)&&ok(live.endContainer,live.endOffset)&&!live.collapsed&&live.toString().length===len)savedRange=live;
   else{
    const m2=plainMap(selected),s=boundary(m2,a,false),t=boundary(m2,b,true);if(!s||!t)return;
    savedRange=document.createRange();savedRange.setStart(s[0],s[1]);savedRange.setEnd(t[0],t[1]);
   }
  }else if(review.items.length)holdParagraph(selected);
  const range=savedRange.cloneRange();selected.focus();const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
  document.execCommand('styleWithCSS',false,'true');
  if(command==='size'&&[11,13,15,16,19,24,26,28,30,32,34,38,45].includes(Number(value))){
   document.execCommand('fontSize',false,'7');
   selected.querySelectorAll('[style],font[size="7"]').forEach(el=>{if(el.style.fontSize==='xxx-large'||el.getAttribute('size')==='7'){el.style.fontSize=Number(value)+'px';el.removeAttribute('size');}});
  }else if(command==='clearBackground')document.execCommand('hiliteColor',false,'transparent');
  else if(['bold','foreColor','hiliteColor','removeFormat'].includes(command))document.execCommand(command,false,value);
  change(selected);selectionState();
 }
// ---- Review-only decorations -------------------------------------------------
// Proposals arrive from the embedding editor only. A text proposal is drawn as an
// in-text diff exactly at its target phrase (Cursor style): deleted characters are a
// CSS Custom Highlight (no DOM change) and inserted words are an EMPTY, non-editable
// <span data-review-ui="ins"> whose text comes from CSS generated content
// (attr(data-text)). textContent, innerText, Range.toString() and serialize() therefore
// never see it. Proposals that cannot be shown as a diff (format, notes, blocked,
// overlapping) get a small marker span. Every review node carries data-review-ui:
// serialize()/plainMap() skip them, copy strips them, and a paragraph's review nodes are
// removed before any edit reaches it and drawn again after the 400ms idle re-check.
const reviewFont='-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",system-ui,sans-serif';
const reviewCss=[
 '::highlight(rv-del){color:#b3261e;background-color:#fde2df;text-decoration:line-through;text-decoration-color:#b3261e}',
 '::highlight(rv-target){background-color:#e9f0fb;text-decoration:underline dotted;text-decoration-color:#6c86b5}',
 '::highlight(rv-focus){background-color:#fff0b3}',
 '[data-review-ui=ins],[data-review-ui=marker]{margin:0;padding:0;border:0;text-indent:0;letter-spacing:normal;font-style:normal;-webkit-user-select:none;user-select:none;cursor:pointer}',
 '[data-review-ui=ins]::after{content:attr(data-text);white-space:pre-wrap;color:#13612e;-webkit-text-fill-color:#13612e;background-color:#d9f3df;text-decoration:underline;text-decoration-color:#4f9a64;text-underline-offset:2px;border-radius:2px}',
 '[data-review-ui=ins].rv-active::after{background-color:#bdebc9;box-shadow:0 0 0 1px #4f9a64}',
 '[data-review-ui=marker]::after{content:attr(data-label);display:inline-block;margin:0 1px 0 4px;padding:0 7px;border:1px solid #c5d6cb;border-radius:999px;background:#f1f7f3;color:#2f5a46;-webkit-text-fill-color:#2f5a46;font:600 11.5px/1.65 '+reviewFont+';text-decoration:none;vertical-align:1px;white-space:nowrap}',
 '[data-review-ui=marker].rv-warn::after{border-color:#e6c88f;background:#fff5e2;color:#8a5a12;-webkit-text-fill-color:#8a5a12}',
 '[data-review-ui=marker].rv-note::after{border-color:#c4cfe3;background:#f2f5fb;color:#3d5482;-webkit-text-fill-color:#3d5482}',
 '[data-review-ui=marker].rv-active::after{box-shadow:0 0 0 2px #f3d27a}',
 // Taller hit area for taps without changing the line box.
 '[data-review-ui=marker]{display:inline;padding:9px 0;margin:-9px 0}',
 '[data-review-ui=marker]:focus{outline:none}',
 '[data-review-ui=marker]:focus-visible::after{outline:2px solid #2f6f55;outline-offset:1px}',
 '[data-review-ui=note-row]{display:block;margin:2px 0 12px;padding:0;text-align:left;text-indent:0;line-height:1.7;-webkit-user-select:none;user-select:none}',
 '[data-review-ui=note-row] [data-review-ui=marker]::after{margin:0 6px 0 0}',
 // Active-proposal popover and the manual ghost-suggestion bar.
 '.rv-hint,.rv-ghostbar{position:absolute;z-index:1001;box-sizing:border-box;width:max-content;margin:0;text-align:left;text-indent:0;letter-spacing:normal;word-break:keep-all;overflow-wrap:anywhere;font:12.5px/1.5 '+reviewFont+';color:#1f2b24;background:#fff;border:1px solid #d6e0d9;border-radius:8px;box-shadow:0 4px 14px #0000001f;-webkit-user-select:none;user-select:none}',
 // Only the controls and the reason text take the pointer: the rest of the popover lets clicks reach the text under it.
 '.rv-hint{display:block;max-width:400px;padding:8px 10px 9px;border-left:3px solid #5b8875;pointer-events:none}',
 '.rv-hint.rv-hint-blocked{border-left-color:#c58a2b;background:#fffaf0}',
 '.rv-hint.rv-hint-note{border-left-color:#7a8fb3;background:#f8faff}',
 '.rv-hint .rv-hint-head{display:flex;flex-wrap:wrap;gap:2px 8px;align-items:baseline;margin:0 0 3px}',
 '.rv-hint .rv-kind{font-size:12px;font-weight:700;color:#2f5a46}',
 '.rv-hint.rv-hint-blocked .rv-kind{color:#8a5a12}',
 '.rv-hint.rv-hint-note .rv-kind{color:#3d5482}',
 '.rv-hint .rv-meta{font-size:11.5px;color:#6b7a70}',
 '.rv-hint .rv-sum{margin:0;color:#3f4a44;white-space:pre-wrap}',
 '.rv-hint .rv-diff{margin-top:2px;font-size:14px;line-height:1.55;white-space:pre-wrap}',
 '.rv-hint .rv-eq{color:#5b6660}',
 '.rv-hint .rv-del{background:#fde2df;color:#b3261e;text-decoration:line-through}',
 '.rv-hint .rv-ins{background:#d9f3df;color:#13612e;text-decoration:underline;text-decoration-color:#4f9a64}',
 '.rv-hint .rv-plain{white-space:pre-wrap;color:#4b5650}',
 '.rv-hint .rv-note-text{white-space:pre-wrap;font-size:13px;line-height:1.55}',
 '.rv-hint .rv-reason-line{margin:0 0 3px;font-size:12px;color:#8a5a12}',
 '.rv-hint .rv-format{display:grid;gap:6px;margin-top:2px}',
 '.rv-hint .rv-format-row{display:grid;grid-template-columns:auto minmax(0,1fr);gap:0 8px;align-items:baseline}',
 '.rv-hint .rv-format-label{font-size:11px;font-weight:700;color:#6b7a70}',
 '.rv-hint .rv-sample{min-width:0;white-space:pre-wrap;line-height:1.5}',
 '.rv-hint .rv-format-desc{grid-column:2;font-size:11px;color:#6b7a70}',
 '.rv-hint .rv-keys{display:flex;flex-wrap:wrap;align-items:center;gap:3px 10px;margin-top:6px;font-size:12px;color:#4b5650}',
 '.rv-hint kbd,.rv-ghostbar kbd{display:inline-block;padding:0 4px;border:1px solid #c5d3c9;border-bottom-width:2px;border-radius:4px;background:#f6f8f6;color:#1f2b24;font:600 11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}',
 '.rv-hint .rv-hint-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}',
 '.rv-hint button,.rv-ghostbar button{all:unset;display:inline-flex;align-items:center;gap:5px;box-sizing:border-box;min-height:30px;padding:3px 10px;border:1px solid #c5d3c9;border-radius:6px;background:#fff;color:#1f2b24;font:600 12.5px/1.2 '+reviewFont+';cursor:pointer}',
 // After the all:unset reset above, which would otherwise inherit pointer-events:none.
 '.rv-hint button,.rv-hint .rv-why{pointer-events:auto}',
 '.rv-hint button[data-act=apply]{background:#2f6f55;border-color:#2f6f55;color:#fff}',
 '.rv-hint button[data-act=apply] kbd{background:#1f4d3a;border-color:#ffffff73;color:#fff}',
 '.rv-hint button:disabled{opacity:.45;cursor:not-allowed}',
 '.rv-hint button:focus-visible,.rv-ghostbar button:focus-visible{outline:2px solid #2f6f55;outline-offset:2px}',
 '.rv-hint .rv-why{margin-top:7px;padding-top:6px;border-top:1px dashed #d6e0d9;white-space:pre-wrap;color:#3f4a44;-webkit-user-select:text;user-select:text}',
 '.rv-hint .rv-why[hidden]{display:none}',
 '@media (max-width:520px){.rv-hint{padding:9px 11px 10px}.rv-hint button{min-height:36px;padding:4px 12px}}',
 '.rv-ghostbar{display:none;flex-wrap:wrap;align-items:center;gap:4px 6px;max-width:440px;padding:5px 6px}',
 '.rv-ghostbar .rv-ghost-label{padding:0 4px;font-size:12px;font-weight:700;color:#2f5a46;white-space:nowrap}',
 '.rv-ghostbar button[data-ghost-act=accept]{background:#2f6f55;border-color:#2f6f55;color:#fff}',
 '.rv-ghostbar button[data-ghost-act=accept] kbd{background:#1f4d3a;border-color:#ffffff73;color:#fff}',
 '[data-review-ui=ghost]{color:#9aa29c!important;-webkit-text-fill-color:#9aa29c;font-style:normal;text-decoration:none;pointer-events:none;-webkit-user-select:none;user-select:none}',
 '.rv-spinner{position:absolute;z-index:1001;width:14px;height:14px;pointer-events:none}',
 '.rv-spinner .rv-ring{display:block;box-sizing:border-box;width:14px;height:14px;border:2px solid #c5d3c9;border-top-color:#2f6f55;border-radius:50%;animation:rv-spin .8s linear infinite}',
 '@keyframes rv-spin{to{transform:rotate(360deg)}}',
 '@media (prefers-reduced-motion:reduce){.rv-spinner .rv-ring{animation-duration:2.4s}}',
 '.rv-sr{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
].join('\n');
const KIND={text:'문장 수정',format:'서식 변경',note:'구성 의견'};
const canHighlight=typeof CSS!=='undefined'&&!!CSS.highlights&&typeof Highlight==='function';
// targets: what is drawn right now ({item,mode:'inline'|'marker',p,range,el,els,warn,deferred}).
// hold: paragraphs being edited; they stay undecorated until the idle re-check.
const review={items:[],locked:false,key:'',timer:0,open:new Set(),targets:[],hl:[],hold:new Set(),composing:false};
function reviewEl(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
function paragraphOf(id){return [...document.querySelectorAll('[data-tid]')].find(p=>p.dataset.tid===id);}
// Mirrors serialize(): text nodes, <br>/block breaks as '\n', http links as one opaque chunk.
function plainMap(root){
 const chunks=[];let text='';
 const add=(kind,node,value)=>{chunks.push({kind,node,start:text.length,len:value.length});text+=value;};
 function walk(node){
  if(node.nodeType===3){if(node.textContent)add('text',node,node.textContent);return;}
  if(node.nodeType!==1||node.hasAttribute('data-review-ui'))return;
  if(node.tagName==='BR'){add('break',node,'\n');return;}
  const href=node.tagName==='A'?node.getAttribute('href')||'':'';
  if(/^https?:\/\//.test(href)){add('opaque',node,'['+node.textContent+']('+href+')');return;}
  if(['DIV','P'].includes(node.tagName)&&node!==root&&text.length&&!text.endsWith('\n'))add('block',node,'\n');
  for(const child of node.childNodes)walk(child);
 }
 for(const child of root.childNodes)walk(child);
 return {text,chunks};
}
function boundary(map,offset,isEnd){
 const at=n=>[n.parentNode,[...n.parentNode.childNodes].indexOf(n)];
 for(const c of map.chunks){
  const lo=c.start,hi=c.start+c.len;
  if(isEnd?!(offset>lo&&offset<=hi):!(offset>=lo&&offset<hi))continue;
  if(c.kind==='text')return [c.node,offset-lo];
  if(c.kind==='block')return isEnd?[c.node,0]:at(c.node);
  // A link shows only its label, so an offset inside '[label](url)' has no
  // faithful position. Only whole-link boundaries map.
  if(isEnd?offset!==hi:offset!==lo)return null;
  const b=at(c.node);return isEnd?[b[0],b[1]+1]:b;
 }
 return null;
}
function rangeOf(map,start,end){
 const a=boundary(map,start,false),b=boundary(map,end,true);if(!a||!b)return null;
 try{const r=document.createRange();r.setStart(a[0],a[1]);r.setEnd(b[0],b[1]);return r;}catch{return null;}
}
function clipText(text,limit){return text.length>limit?text.slice(0,limit)+'…':text;}
function diffView(segments){
 const box=reviewEl('div','rv-diff');
 segments.forEach((s,i)=>{
  let t=s.text;
  if(s.type==='equal'){
   const first=i===0,last=i===segments.length-1;
   if(first&&!last&&t.length>12)t='…'+t.slice(-12);
   else if(last&&!first&&t.length>12)t=t.slice(0,12)+'…';
   else if(!first&&!last&&t.length>26)t=t.slice(0,12)+'…'+t.slice(-12);
  }
  const span=reviewEl('span',s.type==='equal'?'rv-eq':s.type==='del'?'rv-del':'rv-ins',t);
  if(s.type!=='equal')span.title=s.type==='del'?'삭제':'추가';
  box.append(span);
 });
 return box;
}
function formatView(format,p){
 const css=getComputedStyle(p||document.body),box=reviewEl('div','rv-format');
 const row=(variant,runs,label)=>{
  const r=reviewEl('div','rv-format-row');r.append(reviewEl('span','rv-format-label',variant==='current'?'현재':'제안'));
  const sample=reviewEl('span','rv-sample');sample.dataset.variant=variant;sample.style.fontFamily=css.fontFamily;sample.style.fontSize=css.fontSize;
  for(const run of runs){const s=reviewEl('span','',run.text);s.style.color=run.style.color||css.color;s.style.backgroundColor=run.style.background||'transparent';s.style.fontWeight=String(run.style.weight||css.fontWeight);if(run.style.size)s.style.fontSize=run.style.size+'px';sample.append(s);}
  r.append(sample,reviewEl('span','rv-format-desc',label));return r;
 };
 box.append(row('current',format.before,format.beforeLabel),row('proposed',format.after,format.afterLabel));
 return box;
}
const isReviewNode=n=>!!n&&n.nodeType===1&&n.hasAttribute('data-review-ui');
const INLINE_UI='[data-review-ui="ins"],[data-review-ui="marker"]';
function indexIn(n){return [...n.parentNode.childNodes].indexOf(n);}
function uiNode(kind,item,data){
 const s=document.createElement('span');s.dataset.reviewUi=kind;s.dataset.pid=item.id;s.contentEditable='false';s.setAttribute('aria-hidden','true');
 for(const k in data)s.dataset[k]=data[k];return s;
}
/** Inserts a review node at a plain offset of p, before any review node already at that point. */
function insertAt(p,at,el){
 const map=plainMap(p);
 const b=boundary(map,at,true)||boundary(map,at,false)||(at<=0?[p,0]:[p,p.childNodes.length]);
 let parent,ref;
 if(b[0].nodeType===3){
  const node=b[0];parent=node.parentNode;
  ref=b[1]<=0?node:b[1]>=node.length?node.nextSibling:node.splitText(b[1]);
 }else{parent=b[0];ref=parent.childNodes[b[1]]||null;}
 while(isReviewNode(ref?ref.previousSibling:parent.lastChild))ref=ref?ref.previousSibling:parent.lastChild;
 parent.insertBefore(el,ref);
}
/** Plain-offset plan of a text proposal: deleted ranges and insertion points from its diff segments. */
function diffPlan(item,map){
 const s0=item.start,e0=item.end,del=[],ins=[];let at=s0,orig='';
 for(const s of item.segments||[]){
  if(s.type==='ins'){if(s.text)ins.push([at,s.text]);continue;}
  if(s.type==='del'&&s.text)del.push([at,at+s.text.length]);
  orig+=s.text;at+=s.text.length;
 }
 const maps=o=>!!(boundary(map,o,true)||boundary(map,o,false));
 if(orig===map.text.slice(s0,e0)&&(del.length||ins.length)&&del.every(([a,b])=>boundary(map,a,false)&&boundary(map,b,true))&&ins.every(([a])=>maps(a)))return {del,ins,exact:true};
 // Segments do not line up with the paragraph (e.g. a link boundary): strike the whole target, insert after it.
 return {del:e0>s0?[[s0,e0]]:[],ins:item.after?[[e0,item.after]]:[],exact:false};
}
function paintHighlights(){
 if(!canHighlight)return;
 for(const [name,priority] of [['rv-del',2],['rv-target',1]]){
  const ranges=review.hl.filter(h=>h.name===name).map(h=>h.range);
  if(ranges.length){const h=new Highlight(...ranges);h.priority=priority;CSS.highlights.set(name,h);}else CSS.highlights.delete(name);
 }
}
/** Selection inside one paragraph as plain offsets (review nodes skipped). */
function saveSel(){
 const sel=getSelection();if(!sel||!sel.rangeCount)return null;const r=sel.getRangeAt(0);
 const tid=n=>(n.nodeType===1?n:n.parentElement)?.closest('[data-tid]');
 const p=tid(r.startContainer);if(!p||tid(r.endContainer)!==p)return null;
 const map=plainMap(p);
 // Keep the DOM points too: plain offsets cannot express a caret inside a link label or
 // which side of a style boundary it sits on, so they are only the fallback.
 return {p,a:offsetOf(p,r.startContainer,r.startOffset,map),b:offsetOf(p,r.endContainer,r.endOffset,map),
  sc:r.startContainer,so:r.startOffset,ec:r.endContainer,eo:r.endOffset,
  // A backward selection (Shift+ArrowLeft) keeps its anchor on the right.
  back:!r.collapsed&&(sel.anchorNode!==r.startContainer||sel.anchorOffset!==r.startOffset),
  inLink:insideLink(p,r.startContainer,r.startOffset,map)||insideLink(p,r.endContainer,r.endOffset,map)};
}
function restoreSel(s){
 if(!s||!document.contains(s.p))return;
 // Removing review nodes rarely moves the live selection; re-setting an unchanged one can
 // still flip which side of a style boundary Chrome types into, so leave it alone then.
 const cur=getSelection();
 if(cur&&cur.rangeCount){const r=cur.getRangeAt(0);if(r.startContainer===s.sc&&r.startOffset===s.so&&r.endContainer===s.ec&&r.endOffset===s.eo&&s.sc.isConnected&&s.ec.isConnected)return;}
 // Only text-node points survive span insertion/removal unchanged (element child indexes shift).
 const ok=(n,o)=>n&&n.nodeType===3&&n.isConnected&&s.p.contains(n)&&!n.parentElement.closest('[data-review-ui]')&&o<=n.length;
 if(ok(s.sc,s.so)&&ok(s.ec,s.eo)){
  const r=document.createRange();
  try{r.setStart(s.sc,s.so);r.setEnd(s.ec,s.eo);if(r.toString().length===Math.abs(s.b-s.a)||s.inLink){selectRange(r,s.back);return;}}catch{}
 }
 // Inside a link label an offset maps only to the link's start: leave the caret alone.
 if(s.inLink)return;
 setCaret(s.p,s.a,s.b,false);
 if(s.back){const sel=getSelection();if(sel.rangeCount)selectRange(sel.getRangeAt(0),true);}
}
/** Selects a range, anchored at its end when back is set (keeps the selection's direction). */
function selectRange(r,back){
 const sel=getSelection();
 if(back&&!r.collapsed){sel.setBaseAndExtent(r.endContainer,r.endOffset,r.startContainer,r.startOffset);return;}
 sel.removeAllRanges();sel.addRange(r);
}
/** Removes p's in-text review nodes and re-joins the text nodes they split. */
function removeDecor(p){
 const nodes=[...p.querySelectorAll(INLINE_UI)];if(!nodes.length)return false;
 nodes.forEach(n=>n.remove());p.normalize();return true;
}
/** Before an edit: drop p's review UI at once (keeping the caret) and keep it off until the idle re-check. */
function holdParagraph(p){
 if(!review.items.length||!p||!p.matches||!p.matches('[data-tid]'))return;
 review.hold.add(p);scheduleRender();
 if(!review.targets.some(t=>t.p===p)&&!p.querySelector(INLINE_UI))return;
 if(nav.active&&nav.active.p===p)hideHint();
 const keep=saveSel();
 review.targets=review.targets.filter(t=>t.p!==p);review.hl=review.hl.filter(h=>h.p!==p);
 const changed=removeDecor(p);paintHighlights();
 if(changed&&keep&&keep.p===p)restoreSel(keep);
}
// Re-validate and redraw once typing has been idle for 400ms (never during IME composition).
function scheduleRender(){
 clearTimeout(review.timer);
 review.timer=setTimeout(()=>{if(review.composing){scheduleRender();return;}review.hold.clear();renderReview();updateNav();},400);
}
function clearReview(){
 for(const p of new Set([...document.querySelectorAll(INLINE_UI)].map(n=>n.closest('[data-tid]')).filter(Boolean)))removeDecor(p);
 document.querySelectorAll('[data-review-ui="note-row"]').forEach(e=>e.remove());
 review.targets=[];review.hl=[];paintHighlights();
 if(canHighlight)CSS.highlights.delete('rv-focus');
}
function noteAnchor(item){
 const scope=[...document.querySelectorAll('[data-bundle]')].filter(e=>e.dataset.bundle===item.bundleId);
 if(!scope.length)return null;
 const text=item.observation||'';
 for(const img of scope.flatMap(e=>[...e.querySelectorAll('img')])){
  const src=img.getAttribute('src')||'';let name='';
  try{const u=new URL(src,location.href);name=u.searchParams.get('name')||decodeURIComponent(u.pathname.split('/').pop()||'');}catch{}
  const alt=(img.getAttribute('alt')||'').trim();
  if((name&&text.includes(name))||(alt.length>=2&&text.includes(alt))){const block=img.closest('.photo-group')||img.closest('figure')||img;return {node:block,mode:'after'};}
 }
 const label=scope.map(e=>e.querySelector(':scope > .editor-bundle-label')).find(Boolean);
 return label?{node:label,mode:'after'}:{node:scope[0],mode:'before'};
}
/** Draws one paragraph's proposals. Returns true when its DOM changed. */
function decorate(p,list){
 const map=plainMap(p),text=map.text;
 const located=i=>i.start!==undefined&&i.end!==undefined&&text.slice(i.start,i.end)===i.phrase&&text.indexOf(i.phrase)===i.start&&text.indexOf(i.phrase,i.start+1)<0&&!!rangeOf(map,i.start,i.end);
 const inline=[],markers=[];
 for(const item of list){
  if(item.kind==='note'){markers.push({item,at:text.length,label:'✦ 메모',cls:'rv-note'});continue;}
  // Stale: the target text changed. Nothing is drawn; the panel says why.
  if(item.state==='changed')continue;
  if(!item.canApply){markers.push({item,at:text.length,label:'⚠ 확인 필요',cls:'rv-warn',warn:true});continue;}
  // Applicable but not at its offsets in this DOM yet: wait for the host's re-validation.
  if(!located(item))continue;
  if(item.kind==='text'&&!inline.some(o=>item.start<o.item.end&&o.item.start<item.end)){inline.push({item,plan:diffPlan(item,map)});continue;}
  markers.push({item,at:item.end,label:item.kind==='format'?'✦ 서식':'✦ 겹친 제안',cls:item.kind==='format'?'rv-format':'rv-defer',range:item.kind==='format',deferred:item.kind==='text'});
 }
 // A marker never splits an inline diff: it moves to the end of that diff.
 for(const m of markers)for(const o of inline)if(m.at>o.item.start&&m.at<o.item.end)m.at=o.item.end;
 if(!inline.length&&!markers.length)return false;
 const ops=[];
 inline.forEach((o,i)=>o.plan.ins.forEach(([at,t],k)=>ops.push({at,order:i*64+k,el:uiNode('ins',o.item,{text:t})})));
 markers.forEach((m,i)=>{m.el=uiNode('marker',m.item,{label:m.label});m.el.className='rv-marker '+m.cls;ops.push({at:m.at,order:100000+i,el:m.el});});
 // From the end so earlier offsets stay valid; at one point the later item goes in first.
 ops.sort((a,b)=>b.at-a.at||b.order-a.order);
 for(const op of ops)insertAt(p,op.at,op.el);
 const fresh=plainMap(p);
 for(const o of inline){
  const els=[...p.querySelectorAll('[data-review-ui="ins"]')].filter(e=>e.dataset.pid===o.item.id);
  for(const [a,b] of o.plan.del){const r=rangeOf(fresh,a,b);if(r)review.hl.push({p,name:'rv-del',range:r});}
  review.targets.push({item:o.item,mode:'inline',p,range:rangeOf(fresh,o.item.start,o.item.end),el:els[0]||null,els});
 }
 for(const m of markers){
  const range=m.range?rangeOf(fresh,m.item.start,m.item.end):null;
  if(range)review.hl.push({p,name:'rv-target',range});
  // The popover must also clear the phrase a marker refers to (markers can sit after it).
  const anchor=range||(m.item.kind!=='note'&&located(m.item)?rangeOf(fresh,m.item.start,m.item.end):null);
  review.targets.push({item:m.item,mode:'marker',p,range,anchor,el:m.el,els:[m.el],warn:!!m.warn,deferred:!!m.deferred});
 }
 return true;
}
/** Photo/layout notes without a paragraph: a focusable marker near the related photo or bundle. */
function decorateNote(item){
 const anchor=noteAnchor(item);if(!anchor)return;
 let row=anchor.mode==='after'?anchor.node.nextElementSibling:anchor.node.previousElementSibling;
 if(!row||row.dataset.reviewUi!=='note-row'){
  row=reviewEl('div');row.dataset.reviewUi='note-row';row.contentEditable='false';
  if(anchor.mode==='after')anchor.node.after(row);else anchor.node.before(row);
 }
 const el=uiNode('marker',item,{label:'✦ 메모'});el.className='rv-marker rv-note';
 el.removeAttribute('aria-hidden');el.setAttribute('role','button');el.tabIndex=-1;el.setAttribute('aria-label','AI 제안 · 구성 의견 열기');
 row.append(el);
 review.targets.push({item,mode:'marker',p:null,range:null,el,els:[el]});
}
function renderReview(){
 // Never touch the DOM during IME composition; compositionend schedules the redraw.
 if(review.composing)return;
 const keep=saveSel();
 const touched=new Set([...document.querySelectorAll(INLINE_UI)].map(n=>n.closest('[data-tid]')).filter(Boolean));
 clearReview();
 nav.key='';
 if(review.items.length){
  ensureReviewStyle();
  const live=review.items.filter(i=>i.state!=='applied'&&i.state!=='decided');
  const byP=new Map(),loose=[];
  for(const item of live){
   const p=item.paragraphId?paragraphOf(item.paragraphId):null;
   if(!p){if(item.kind==='note')loose.push(item);continue;}
   if(review.hold.has(p)||(ghost&&ghost.p===p))continue;
   if(!byP.has(p))byP.set(p,[]);byP.get(p).push(item);
  }
  for(const [p,list] of byP)if(decorate(p,list))touched.add(p);
  for(const item of loose)decorateNote(item);
  paintHighlights();
 }
 if(keep&&touched.has(keep.p))restoreSel(keep);
}

// ---- Keyboard suggestions ----------------------------------------------------
// Layer 1: Tab/Esc/Shift+Tab walk the review proposals above; the active one gets a
// small popover. Layer 2: a manual request ("✦ 추천 받기" or Alt+\) shows gray ghost
// text at the caret. Every element here carries data-review-ui, so serialize()/
// plainMap() skip it, and the ghost is removed (and split text re-joined) before any
// edit is reported. Nothing changes in the manuscript until the writer explicitly accepts.
const isMac=/Mac|iPhone|iPad/.test(navigator.platform||'');
const nav={focusId:'',focusP:null,focusAt:-1,after:null,timer:0,key:'',hint:null,bar:null,live:null,active:null,returnTo:null,origin:null};
const sug={pending:null,spinner:null};
function ensureReviewStyle(){if(!document.querySelector('style[data-review-ui]')){const s=document.createElement('style');s.dataset.reviewUi='style';s.textContent=reviewCss;document.head.append(s);}}
function focusHighlight(range){if(!canHighlight)return;if(range){const h=new Highlight(range);h.priority=3;CSS.highlights.set('rv-focus',h);}else CSS.highlights.delete('rv-focus');}
function announce(text){
 if(!nav.live){const l=reviewEl('div','rv-sr');l.dataset.reviewUi='live';l.setAttribute('role','status');l.setAttribute('aria-live','polite');document.body.append(l);nav.live=l;}
 nav.live.textContent=text;
}
/** Plain-text offset (same as plainMap/readInline text) of a DOM point inside paragraph p. */
function offsetOf(p,node,off,map){
 map=map||plainMap(p);let at=0;
 for(const c of map.chunks){
  if(c.kind==='text'&&c.node===node)return c.start+Math.min(off,c.len);
  const r=document.createRange();
  try{if(c.kind==='block')r.selectNodeContents(c.node);else r.selectNode(c.node);}catch{continue;}
  if(c.kind!=='block'&&r.startContainer===node&&r.startOffset===off)return c.start;
  let cmp;try{cmp=r.comparePoint(node,off);}catch{return at;}
  if(cmp<0)return c.start;
  if(cmp>0||c.kind==='block'||(r.endContainer===node&&r.endOffset===off)){at=c.start+c.len;continue;}
  if(c.kind==='opaque'){const q=document.createRange();q.setStart(c.node,0);q.setEnd(node,off);return q.toString().length>=(c.node.textContent||'').length?c.start+c.len:c.start;}
  return c.start;
 }
 return map.text.length;
}
/** True when a DOM point sits strictly inside a link label, where offsetOf() can only report the link's start. */
function insideLink(p,node,off,map){
 for(const c of (map||plainMap(p)).chunks){
  if(c.kind!=='opaque'||!c.node.contains(node))continue;
  const q=document.createRange();try{q.setStart(c.node,0);q.setEnd(node,off);}catch{return false;}
  const n=q.toString().length;return n>0&&n<(c.node.textContent||'').length;
 }
 return false;
}
/** DOM point for a plain offset; at a run boundary the caret stays with the preceding text. */
function pointAt(p,offset,map){map=map||plainMap(p);return boundary(map,offset,true)||boundary(map,offset,false)||(offset<=0?[p,0]:[p,p.childNodes.length]);}
function setCaret(p,start,end,focus){
 const map=plainMap(p);const a=start===end?pointAt(p,start,map):(boundary(map,start,false)||pointAt(p,start,map));const b=start===end?a:(boundary(map,end,true)||a);
 if(focus&&document.activeElement!==p)p.focus({preventScroll:true});
 const r=document.createRange();try{r.setStart(a[0],a[1]);r.setEnd(b[0],b[1]);}catch{return;}
 const sel=getSelection();sel.removeAllRanges();sel.addRange(r);
}
function caretRect(p,offset){
 const b=pointAt(p,offset);const r=document.createRange();
 try{r.setStart(b[0],b[1]);r.collapse(true);const rects=r.getClientRects();if(rects.length)return rects[rects.length-1];}catch{}
 // Collapsed ranges between elements have no box: measure the preceding character instead.
 if(b[0].nodeType===3&&b[1]>0){const q=document.createRange();q.setStart(b[0],b[1]-1);q.setEnd(b[0],b[1]);const x=q.getBoundingClientRect();return {left:x.right,right:x.right,top:x.top,bottom:x.bottom,height:x.height};}
 const pr=p.getBoundingClientRect(),lh=parseFloat(getComputedStyle(p).lineHeight)||20;
 return {left:pr.left,right:pr.left,top:pr.top,bottom:pr.top+lh,height:lh};
}
/** Current selection inside one [data-tid] paragraph, as plain offsets. */
function caretInfo(){
 const sel=getSelection();if(!sel||!sel.rangeCount)return null;const r=sel.getRangeAt(0);
 const tid=n=>(n.nodeType===1?n:n.parentElement)?.closest('[data-tid]');
 const p=tid(r.endContainer);if(!p||tid(r.startContainer)!==p)return null;
 const map=plainMap(p),offset=offsetOf(p,r.endContainer,r.endOffset,map);
 return {p,map,offset,collapsed:r.collapsed,start:r.collapsed?offset:offsetOf(p,r.startContainer,r.startOffset,map),inLink:insideLink(p,r.endContainer,r.endOffset,map),pi:[...document.querySelectorAll('[data-tid]')].indexOf(p)};
}
/** Floating review UI below an anchor rect, clamped to the paper; flips above when the frame would clip it. */
function placeFloating(el,rect,gap){
 const box=(document.querySelector('main')||document.body).getBoundingClientRect(),vw=document.documentElement.clientWidth;
 const lo=Math.max(4,box.left+4),hi=Math.min(vw-4,box.right-4),room=hi-lo;
 // On a phone the popover spans the paper width (a sheet under the target line).
 const narrow=room<520&&el.classList.contains('rv-hint');
 el.style.width=narrow?room+'px':'';
 el.style.maxWidth=Math.max(180,Math.min(room,440))+'px';
 const w=el.offsetWidth,h=el.offsetHeight;
 el.style.left=(narrow?lo:Math.max(lo,Math.min(rect.left,hi-w)))+'px';
 const limit=box.bottom+scrollY+(parseFloat(getComputedStyle(document.body).paddingBottom)||0);
 const below=rect.bottom+scrollY+gap,above=rect.top+scrollY-gap-h;
 el.style.top=(below+h>limit&&above>0?above:below)+'px';
}

// -- Layer 1: Tab over review proposals --
/** Drawn proposals in document order, with their current plain offsets. */
function navTargets(){
 const ps=[...document.querySelectorAll('[data-tid]')],maps=new Map(),out=[];
 const mapOf=p=>{if(!maps.has(p))maps.set(p,plainMap(p));return maps.get(p);};
 for(const t of review.targets){
  const item=t.item;
  if(item.state==='applied'||item.state==='decided')continue;
  // A deferred overlap is shown for information only: it is applied after re-validation, never from its marker.
  const blocked=!item.canApply||review.locked||!!t.warn||!!t.deferred||item.kind==='note';
  if(t.p){
   if(!t.p.isConnected||review.hold.has(t.p)||(ghost&&ghost.p===t.p))continue;
   if(t.el&&!t.p.contains(t.el))continue;
   const r=t.range&&t.p.contains(t.range.startContainer)&&t.p.contains(t.range.endContainer)?t.range:null;
   if(t.mode==='inline'&&(!r||r.collapsed))continue;
   const map=mapOf(t.p);let start,end;
   if(t.mode==='inline'){start=offsetOf(t.p,r.startContainer,r.startOffset,map);end=offsetOf(t.p,r.endContainer,r.endOffset,map);}
   else{end=offsetOf(t.p,t.el.parentNode,indexIn(t.el),map);start=r?Math.min(end,offsetOf(t.p,r.startContainer,r.startOffset,map)):end;}
   out.push({...t,range:r,pi:ps.indexOf(t.p),start,end,blocked});
  }else{
   if(!t.el||!t.el.isConnected)continue;
   // Between paragraphs: half a step before the next paragraph.
   const next=ps.findIndex(p=>t.el.compareDocumentPosition(p)&Node.DOCUMENT_POSITION_FOLLOWING);
   out.push({...t,pi:(next<0?ps.length:next)-0.5,start:0,end:0,blocked});
  }
 }
 const order=t=>review.items.indexOf(t.item);
 return out.sort((a,b)=>a.pi-b.pi||a.start-b.start||a.end-b.end||order(a)-order(b));
}
/** The proposal the caret is on: its range contains or touches the caret. */
function navState(c,list){
 if(!c||!c.collapsed)return null;
 if(nav.focusP!==c.p||nav.focusAt!==c.offset)nav.focusId='';
 const containing=list.filter(t=>t.p===c.p&&t.start<=c.offset&&c.offset<=t.end);
 return containing.find(t=>t.item.id===nav.focusId)||containing[0]||null;
}
function stepFrom(c,list,dir,on){
 if(on){const i=list.indexOf(on);return dir>0?list[i+1]:list[i-1];}
 return dir>0?list.find(t=>t.pi>c.pi||(t.pi===c.pi&&t.start>c.offset)):[...list].reverse().find(t=>t.pi<c.pi||(t.pi===c.pi&&t.start<c.offset));
}
function setActive(t){
 document.querySelectorAll('[data-review-ui].rv-active').forEach(e=>e.classList.remove('rv-active'));
 if(t)for(const e of t.els||[])e.classList.add('rv-active');
 focusHighlight(t&&(t.range||t.anchor));
}
// The popover exists only while a proposal is active; the persistent live region announces it.
function hideHint(){if(nav.hint){nav.hint.remove();nav.hint=null;}nav.key='';nav.active=null;setActive(null);}
function rectOf(t){
 const rs=[];
 for(const g of new Set([t.range,t.anchor].filter(Boolean)))for(const r of g.getClientRects())if(r.width||r.height)rs.push(r);
 for(const e of t.els||[])for(const r of e.getClientRects())if(r.width||r.height)rs.push(r);
 if(!rs.length)return t.p?caretRect(t.p,t.start):{left:0,right:0,top:0,bottom:0};
 return {left:Math.min(...rs.map(r=>r.left)),right:Math.max(...rs.map(r=>r.right)),top:Math.min(...rs.map(r=>r.top)),bottom:Math.max(...rs.map(r=>r.bottom))};
}
function reasonOf(t){
 if(review.locked)return '저장이나 검토 준비가 끝날 때까지 적용할 수 없어요.';
 if(t.warn||!t.item.canApply)return t.item.reason||'지금은 적용할 수 없어요.';
 if(t.deferred)return '본문에 표시된 다른 제안과 범위가 겹쳐요. 그 제안을 정하면 이 제안을 다시 확인해요.';
 return '';
}
function fillHint(h,t,hasNext,hasPrev){
 const item=t.item,note=item.kind==='note',reason=reasonOf(t);
 h.replaceChildren();h.dataset.pid=item.id;
 h.classList.toggle('rv-hint-blocked',t.blocked&&!note);h.classList.toggle('rv-hint-note',note);
 const head=reviewEl('div','rv-hint-head');head.append(reviewEl('span','rv-kind','AI 제안 · '+KIND[item.kind]));
 const meta=[item.severity,item.axis].filter(Boolean).join(' · ');if(meta)head.append(reviewEl('span','rv-meta',meta));
 h.append(head);
 if(note)h.append(reviewEl('div','rv-note-text',item.observation||''));
 else{
  if(reason){const l=reviewEl('div','rv-reason-line',reason);l.setAttribute('role','note');h.append(l);}
  if(item.kind==='text'){
   if(t.mode==='inline')h.append(reviewEl('p','rv-sum',clipText((item.observation||'').split('\n')[0],90)));
   else if(t.warn)h.append(reviewEl('div','rv-plain',clipText(item.before||'',80)+' → '+(item.after?clipText(item.after,80):'(삭제)')));
   else h.append(diffView(item.segments||[]));
  }else if(item.format&&!t.warn)h.append(formatView(item.format,t.p));
  else h.append(reviewEl('div','rv-plain','“'+clipText(item.phrase||'',60)+'” 서식 변경'));
 }
 const actions=reviewEl('div','rv-hint-actions');
 const button=(act,label,name,key,keys,disabled)=>{
  const b=reviewEl('button','',label);b.type='button';b.dataset.act=act;b.setAttribute('aria-label',name);
  if(key){b.append(reviewEl('kbd','',key));b.setAttribute('aria-keyshortcuts',keys);}
  b.disabled=!!disabled;actions.append(b);return b;
 };
 if(!note)button('apply','적용','적용','Tab','Tab',t.blocked);
 button('keep','유지','현재 유지','Esc','Escape',review.locked);
 const open=review.open.has(item.id);
 if(!note)button('why','이유','이유','','',false).setAttribute('aria-expanded',String(open));
 const again=button('rereview','다시 검토','다시 검토','','',review.locked);
 again.dataset.bundleId=item.bundleId;again.title='이 묶음을 다시 검토해요. 저장 전 변경이 있으면 먼저 저장해요.';
 h.append(actions);
 if(!note){
  // The full before/after stays reachable even when the popover shows a clipped line.
  const full=item.kind==='text'?'원문: '+(item.before||'')+'\n제안: '+(item.after||'(삭제)'):'';
  const why=reviewEl('div','rv-why',[item.observation,reason||item.reason,full].filter(Boolean).join('\n\n'));why.hidden=!open;h.append(why);
 }
 if((t.blocked&&hasNext)||hasPrev){
  const keys=reviewEl('div','rv-keys');
  const key=(k,label)=>{const s=reviewEl('span','rv-key');s.append(reviewEl('kbd','',k),document.createTextNode(' '+label));keys.append(s);};
  if(t.blocked&&hasNext)key('Tab','다음');
  if(hasPrev)key('Shift+Tab','이전');
  h.append(keys);
 }
}
function updateNav(){
 if(ghost||review.locked||!review.items.length){hideHint();return;}
 const a=document.activeElement;
 // Keyboard focus inside the popover keeps it as is.
 if(nav.hint&&a&&nav.hint.contains(a))return;
 const list=navTargets();let t=null,c=null;
 if(a&&a.matches&&a.matches('[data-tid]')){c=caretInfo();if(c&&c.p===a)t=navState(c,list);}
 else if(a&&a.matches&&a.matches('[data-review-ui="marker"]'))t=list.find(x=>x.el===a)||null;
 if(!t){hideHint();return;}
 const from=c||{pi:t.pi,offset:t.start};
 const hasNext=!!stepFrom(from,list,1,t),hasPrev=!!stepFrom(from,list,-1,t);
 ensureReviewStyle();
 if(!nav.hint){const h=reviewEl('div','rv-hint');h.dataset.reviewUi='hint';h.setAttribute('role','group');h.setAttribute('aria-label','AI 제안');document.body.append(h);nav.hint=h;}
 nav.active=t;
 const key=[t.item.id,t.item.sig,t.blocked,t.mode,hasNext,hasPrev,review.locked].join('|');
 if(key!==nav.key){
  nav.key=key;fillHint(nav.hint,t,hasNext,hasPrev);
  const it=t.item,what=(it.kind==='text'?(it.before||'')+' → '+(it.after||'(삭제)'):it.kind==='note'?(it.observation||'').split('\n')[0]:'“'+(it.phrase||'')+'” '+(it.format&&it.format.afterLabel?it.format.afterLabel+'(으)로 서식 변경':'서식 변경')).replace(/[.。\s]+$/,'');
  announce('AI 제안: '+what+'. '+(t.blocked?(it.kind==='note'?'Esc 유지':'적용할 수 없어요. '+(hasNext?'Tab 다음':'')):'Tab 적용, Esc 유지')+'. Alt+↓ 버튼으로 이동');
 }
 placeFloating(nav.hint,rectOf(t),6);
 setActive(t);
}
function goTo(t){
 nav.focusId=t.item.id;
 if(t.p){nav.origin=null;nav.focusP=t.p;nav.focusAt=t.mode==='inline'?t.start:t.end;setCaret(t.p,nav.focusAt,nav.focusAt,true);}
 else{
  // Remember where the writer came from: the marker can disappear (kept/decided) and focus must return to the text.
  const a=document.activeElement;if(a&&a.matches&&a.matches('[data-tid]')){const s=saveSel();if(s)nav.origin=s;}
  nav.focusP=null;nav.focusAt=-1;t.el.focus({preventScroll:true});
  // focusin only reports paragraphs: tell the host this note's bundle is now the selected one.
  const b=[...document.querySelectorAll('[data-bundle]')].find(e=>e.dataset.bundle===t.item.bundleId);
  if(b){document.querySelectorAll('.active').forEach(x=>x.classList.remove('active'));b.classList.add('active');}
  send({type:'select',bundleId:t.item.bundleId});
 }
 const rect=rectOf(t);
 send({type:'reveal',top:rect.top+scrollY,bottom:rect.bottom+scrollY+150});
 updateNav();
}
/** Apply/keep through the host's existing proposal-action path, then continue once fresh proposals arrive. */
function act(action,t){
 send({type:'proposal-action',action,id:t.item.id,sig:t.item.sig});
 clearTimeout(nav.timer);
 nav.after={id:t.item.id,pid:t.item.paragraphId,pi:t.pi,start:t.start,action,len:action==='apply'&&t.item.kind==='text'?(t.item.after||'').length:t.end-t.start};
 // The host may refuse (changed finding, busy); then nothing moves.
 nav.timer=setTimeout(()=>{nav.after=null;updateNav();},2500);
 hideHint();
}
function resolveAfter(){
 const a=nav.after;if(!a)return;
 const still=review.items.find(i=>i.id===a.id);
 if(still&&still.state!=='applied'&&still.state!=='decided')return;
 nav.after=null;clearTimeout(nav.timer);
 const next=navTargets().find(t=>t.item.id!==a.id&&(t.pi>a.pi||(t.pi===a.pi&&t.start>=a.start)));
 if(next){goTo(next);return;}
 const p=a.pid&&paragraphOf(a.pid);
 if(p&&p.isContentEditable&&a.action==='apply')setCaret(p,a.start+a.len,a.start+a.len,true);
 else{
  // The decided proposal's marker took focus with it: go back to the text instead of leaving focus on <body>.
  const f=document.activeElement;
  if(!f||f===document.body||!f.isConnected)returnToText(nav.origin,a.pi);
 }
 nav.origin=null;
 updateNav();
}
/** Focus the writer's previous caret, or else the editable paragraph nearest to slot pi. */
function returnToText(o,pi){
 if(o&&o.p&&o.p.isConnected&&o.p.isContentEditable){o.p.focus({preventScroll:true});restoreSel(o);if(!getSelection().rangeCount||!o.p.contains(getSelection().anchorNode))setCaret(o.p,o.a,o.b,false);return;}
 const ps=[...document.querySelectorAll('[data-tid]')];
 const ok=p=>p&&p.isContentEditable&&p.dataset.tid!=='$title';
 const i=Math.floor(pi);
 // The paragraph just before the note (caret at its end), else the one after it.
 let p=null;for(let k=Math.min(i,ps.length-1);k>=0&&!p;k--)if(ok(ps[k]))p=ps[k];
 for(let k=Math.max(0,i+1);k<ps.length&&!p;k++)if(ok(ps[k]))p=ps[k];
 if(!p)return;
 const end=plainMap(p).text.length;setCaret(p,end,end,true);
}
/** Panel "본문에서 보기": caret (or focus) on the proposal and its popover open. */
function revealProposal(id){
 const t=navTargets().find(x=>x.item.id===id);
 if(t){goTo(t);return;}
 const item=review.items.find(i=>i.id===id),p=item&&item.paragraphId&&paragraphOf(item.paragraphId);
 if(p)send({type:'scroll',top:p.getBoundingClientRect().top+scrollY-120});
}

// -- Layer 2: manual suggestion with ghost text --
function hideSpinner(){sug.spinner?.remove();sug.spinner=null;}
function showSpinner(p,offset){
 ensureReviewStyle();hideSpinner();
 const s=reviewEl('div','rv-spinner');s.dataset.reviewUi='spinner';s.setAttribute('role','status');s.setAttribute('aria-live','polite');
 s.append(reviewEl('i','rv-ring'),reviewEl('span','rv-sr','추천을 기다리는 중'));
 document.body.append(s);sug.spinner=s;
 const r=caretRect(p,offset),h=r.height||(r.bottom-r.top)||18;
 s.style.left=Math.max(2,Math.min(r.right+3,document.documentElement.clientWidth-18))+'px';
 s.style.top=(r.top+scrollY+Math.max(0,(h-14)/2))+'px';
}
function startSuggest(){
 if(document.documentElement.dataset.markup!=='true'){send({type:'suggest-error',message:'이 형식에서는 추천을 지원하지 않아요.'});return;}
 if(review.locked){send({type:'suggest-error',message:'저장이나 검토 준비가 끝난 뒤 다시 요청해주세요.'});return;}
 removeGhost();
 if(sug.pending){const q=sug.pending;sug.pending=null;hideSpinner();send({type:'suggest-cancel',token:q.token});}
 let c=caretInfo();
 if(!c&&selected&&savedRange&&selected.contains(savedRange.endContainer)){const map=plainMap(selected),r=savedRange,offset=offsetOf(selected,r.endContainer,r.endOffset,map);c={p:selected,map,collapsed:r.collapsed,offset,start:r.collapsed?offset:offsetOf(selected,r.startContainer,r.startOffset,map),inLink:insideLink(selected,r.endContainer,r.endOffset,map)};}
 const p=c&&c.p;
 if(!p||p.dataset.tid==='$title'||!p.isContentEditable){send({type:'suggest-error',message:'본문 문단에서 이어 쓸 위치를 클릭한 뒤 추천을 요청해주세요.'});return;}
 // Inside a link label every caret maps to the link's start, so the suggestion would land elsewhere.
 if(c.inLink){send({type:'suggest-error',message:'링크 글자 안에서는 추천할 수 없어요. 링크 앞이나 뒤에 커서를 두고 다시 요청해주세요.'});return;}
 // With a selection, the suggestion continues from its end.
 const runs=serialize(p),token=Math.random().toString(36).slice(2)+Date.now().toString(36);
 sug.pending={token,p,offset:c.offset,start:c.start,collapsed:c.collapsed,key:runsKey(runs)};
 hideHint();showSpinner(p,c.offset);
 send({type:'suggest',token,id:p.dataset.tid,runs,offset:c.offset});
}
function suggestResult(m){
 const q=sug.pending;if(!q||q.token!==m.token)return;
 sug.pending=null;hideSpinner();
 if(m.error)return;
 const list=Array.isArray(m.suggestions)?m.suggestions.filter(s=>typeof s==='string'&&s.trim()).slice(0,3):[];
 const c=caretInfo();
 // Discard when anything the request was based on moved: paragraph text, caret or selection, focus, lock or revision.
 // Focus is checked live (selected/getSelection outlive a blur), so a late answer never pulls focus back.
 const fresh=!m.stale&&document.contains(q.p)&&selected===q.p&&document.activeElement===q.p&&!review.locked&&q.p.isContentEditable&&runsKey(serialize(q.p))===q.key&&!!c&&c.p===q.p&&c.offset===q.offset&&c.start===q.start&&c.collapsed===q.collapsed&&!c.inLink;
 if(!fresh){send({type:'suggest-done',token:q.token,outcome:'stale'});return;}
 if(!list.length){send({type:'suggest-done',token:q.token,outcome:'empty'});updateNav();return;}
 showGhost(q.p,q.offset,list,0);
 send({type:'suggest-done',token:q.token,outcome:'shown',count:list.length});
}
function showGhost(p,offset,list,index){
 removeGhost();ensureReviewStyle();hideHint();
 // The ghost owns this paragraph while visible: its inline diffs step aside until it closes.
 holdParagraph(p);
 const el=document.createElement('span');el.dataset.reviewUi='ghost';el.contentEditable='false';el.setAttribute('aria-hidden','true');
 const [node,off]=pointAt(p,offset);let split=null;
 if(node.nodeType===3){
  if(off<=0)node.before(el);
  else if(off>=node.length)node.after(el);
  else{const rest=node.splitText(off);node.after(el);split=[node,rest];}
 }else node.insertBefore(el,node.childNodes[off]||null);
 ghost={p,offset,list,index:Math.min(index||0,list.length-1),el,split};
 // Keep the caret just before the ghost so typing and Tab insert there.
 const r=document.createRange(),prev=el.previousSibling;
 if(prev&&prev.nodeType===3)r.setStart(prev,prev.length);else r.setStartBefore(el);
 r.collapse(true);
 if(document.activeElement!==p)p.focus({preventScroll:true});
 const sel=getSelection();sel.removeAllRanges();sel.addRange(r);
 renderGhost();
}
function renderGhost(){
 const g=ghost;if(!g)return;const text=g.list[g.index],count=g.list.length>1?(g.index+1)+'/'+g.list.length:'';
 g.el.textContent=text;
 if(!nav.bar){const b=reviewEl('div','rv-ghostbar');b.dataset.reviewUi='ghost-bar';b.setAttribute('role','group');b.setAttribute('aria-label','AI 문장 추천');document.body.append(b);nav.bar=b;}
 const bar=nav.bar;bar.replaceChildren(reviewEl('span','rv-ghost-label','✦ 추천'+(count?' '+count:'')));
 const btn=(act,label,k,title)=>{const b=reviewEl('button','',label);b.type='button';b.dataset.ghostAct=act;b.title=title;b.append(reviewEl('kbd','',k));bar.append(b);};
 const alt=isMac?'⌥':'Alt+';
 btn('accept','수락','Tab','추천 문장을 커서 위치에 넣어요');
 btn('word','한 어절',isMac?'⌘→':'Ctrl+→','다음 어절까지만 넣어요');
 if(g.list.length>1)btn('next','다른 추천',alt+']','다른 추천을 보여줘요 ('+alt+'[ 이전)');
 btn('again','다시',alt+'\\','새 추천을 요청해요');
 btn('dismiss','닫기','Esc','추천을 닫아요. 본문은 그대로예요');
 bar.style.display='flex';
 const first=g.el.getClientRects()[0]||g.el.getBoundingClientRect(),all=g.el.getBoundingClientRect();
 placeFloating(bar,{left:first.left,top:first.top,bottom:all.bottom},6);
 const br=bar.getBoundingClientRect();send({type:'reveal',top:Math.min(first.top,br.top)+scrollY,bottom:Math.max(all.bottom,br.bottom)+scrollY});
 announce('추천'+(count?' '+count:'')+': '+text.trim()+'. Tab 수락, Esc 닫기');
}
/** Removes the ghost, re-joins the text node it split and keeps the writer's selection (as plain offsets). */
function removeGhost(){
 const g=ghost;if(!g)return null;ghost=null;
 if(nav.bar)nav.bar.style.display='none';
 const sel=getSelection();let keep=null;
 if(sel&&sel.rangeCount){const r=sel.getRangeAt(0);if(g.p.contains(r.startContainer)&&g.p.contains(r.endContainer)){const map=plainMap(g.p);keep=[offsetOf(g.p,r.startContainer,r.startOffset,map),offsetOf(g.p,r.endContainer,r.endOffset,map)];}}
 g.el.remove();
 if(g.split&&g.split[0].nextSibling===g.split[1]&&g.split[1].parentNode){g.split[0].appendData(g.split[1].data);g.split[1].remove();}
 if(keep)setCaret(g.p,keep[0],keep[1],false);
 if(review.items.length)scheduleRender();
 return g;
}
/** Inserts accepted text through execCommand (undoable, fires the normal input → change flow). */
function insertFromGhost(g,piece,rest,index){
 removeGhost();
 if(review.locked||!g.p.isContentEditable||!document.contains(g.p))return;
 setCaret(g.p,g.offset,g.offset,true);
 document.execCommand('insertText',false,piece);
 if(rest.length)showGhost(g.p,g.offset+piece.length,rest,index||0);
}
function acceptGhost(all){
 const g=ghost;if(!g)return;const text=g.list[g.index];
 const piece=all?text:((text.match(/^\s*\S+\s?/)||[text])[0]);
 const rest=text.slice(piece.length);
 insertFromGhost(g,piece,rest?[rest]:[],0);
 if(!rest)announce('추천 문장을 넣었어요.');
}
function cycleGhost(dir){const g=ghost;if(!g||g.list.length<2)return;g.index=(g.index+dir+g.list.length)%g.list.length;renderGhost();}
/** Keys while ghost text is visible. Returns true when the key was consumed. */
function ghostKey(e){
 const g=ghost;
 if(['Shift','Alt','Meta','Control','CapsLock'].includes(e.key))return true;
 const plain=!e.altKey&&!e.ctrlKey&&!e.metaKey;
 if(e.key==='Tab'&&plain&&!e.shiftKey){e.preventDefault();acceptGhost(true);return true;}
 if(e.key==='Escape'&&plain){e.preventDefault();removeGhost();announce('추천을 닫았어요.');updateNav();return true;}
 if(e.key==='ArrowRight'&&(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey){e.preventDefault();acceptGhost(false);return true;}
 if(e.altKey&&!e.ctrlKey&&!e.metaKey&&(e.code==='BracketRight'||e.code==='BracketLeft')){e.preventDefault();cycleGhost(e.code==='BracketRight'?1:-1);return true;}
 if(plain&&e.key.length===1){
  // Typing the ghost's next character keeps the rest of the suggestion.
  const matches=g.list.map((t,i)=>({t,i})).filter(x=>x.t.startsWith(e.key));
  if(matches.some(x=>x.i===g.index)){
   e.preventDefault();
   // Typing the chosen suggestion's last character finishes it; other candidates never take over.
   const current=g.list[g.index].slice(e.key.length);
   const rest=current?matches.map(x=>x.t.slice(e.key.length)).filter(Boolean):[];
   insertFromGhost(g,e.key,rest,Math.max(0,rest.indexOf(current)));
   return true;
  }
 }
 removeGhost();return false;
}
// Keys that only move the caret or switch focus never touch the manuscript.
const NAV_KEY=/^(Arrow\w+|PageUp|PageDown|Home|End|Shift|Alt|Meta|Control|CapsLock|Tab|Escape|F\d+|ContextMenu|Fn|OS)$/;
function editKey(e){
 if(NAV_KEY.test(e.key))return false;
 if(e.metaKey||e.ctrlKey)return /^[zyvxbiu]$/i.test(e.key)||e.key==='Backspace'||e.key==='Delete';
 return true;
}
const paragraphFrom=n=>n&&n.closest?n.closest('[data-tid]'):null;
document.addEventListener('keydown',e=>{
 if(e.isComposing||e.keyCode===229){
  if(!e.isComposing&&ghost)removeGhost();
  // IME is about to compose here: take the review nodes out before it starts.
  if(!e.isComposing)holdParagraph(paragraphFrom(e.target));
  return;
 }
 if(e.altKey&&!e.ctrlKey&&!e.metaKey&&e.code==='Backslash'){e.preventDefault();e.stopImmediatePropagation();startSuggest();return;}
 if(ghost&&ghostKey(e)){e.stopImmediatePropagation();return;}
 if(e.key==='Escape'&&sug.pending&&!e.altKey&&!e.ctrlKey&&!e.metaKey){const q=sug.pending;sug.pending=null;hideSpinner();e.preventDefault();send({type:'suggest-cancel',token:q.token,notify:true});return;}
 // Keyboard access to the popover controls: Alt+ArrowDown moves into it, Esc inside returns to the text.
 if(nav.hint&&nav.hint.contains(e.target)){
  if(e.key==='Escape'&&!e.altKey&&!e.ctrlKey&&!e.metaKey){e.preventDefault();returnFromHint();}
  return;
 }
 if(e.key==='ArrowDown'&&e.altKey&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey&&nav.hint&&nav.active){
  const b=nav.hint.querySelector('button:not(:disabled)');
  if(b){e.preventDefault();nav.returnTo=saveSel()||(document.activeElement&&document.activeElement.matches('[data-review-ui="marker"]')?{el:document.activeElement}:null);b.focus({preventScroll:true});return;}
 }
 // An edit is coming: remove this paragraph's review nodes before the browser touches the DOM.
 if(editKey(e)){const p=paragraphFrom(e.target);if(p&&p.isContentEditable)holdParagraph(p);return;}
 if(review.locked||e.altKey||e.ctrlKey||e.metaKey||(e.key!=='Tab'&&e.key!=='Escape'))return;
 const marker=e.target.closest&&e.target.closest('[data-review-ui="marker"]');
 const p=!marker&&paragraphFrom(e.target);
 if(!marker&&!p)return;
 const list=navTargets();if(!list.length)return;
 let on=null,from;
 if(p){const c=caretInfo();if(!c)return;on=navState(c,list);from=c;}
 else{on=list.find(t=>t.el===marker)||null;if(!on)return;from={pi:on.pi,offset:on.start};}
 if(e.key==='Escape'){if(e.shiftKey||!on)return;e.preventDefault();act('keep',on);return;}
 if(!e.shiftKey&&on&&!on.blocked){e.preventDefault();act('apply',on);return;}
 // Not on an applicable proposal: Tab moves to the next one (Shift+Tab: previous).
 // With nothing ahead/behind, Tab keeps its default so focus is never trapped.
 const t=stepFrom(from,list,e.shiftKey?-1:1,on);
 if(t){e.preventDefault();goTo(t);}
},true);
// Fallbacks for edits without a keydown (paste, drag, IME without key events, automation).
document.addEventListener('beforeinput',e=>{const p=paragraphFrom(e.target);if(p)holdParagraph(p);},true);
document.addEventListener('compositionstart',e=>{removeGhost();review.composing=true;holdParagraph(paragraphFrom(e.target));});
document.addEventListener('compositionend',()=>{review.composing=false;scheduleRender();});
document.addEventListener('dragstart',e=>{const s0=saveSel();if(s0)holdParagraph(s0.p);},true);
document.addEventListener('cut',e=>{const p=paragraphFrom(e.target);if(p){removeGhost();holdParagraph(p);}},true);
// Copy never carries review UI (inserted words live in attributes, the ghost is real text).
document.addEventListener('copy',e=>{
 const sel=getSelection();if(!sel||!sel.rangeCount||sel.isCollapsed||!e.clipboardData)return;
 // Inside one paragraph: take its review nodes out (selection kept) and let the browser copy natively,
 // which keeps the formatting of enclosing elements. Across paragraphs: strip them from a clone.
 const one=saveSel();if(one&&one.p.querySelector(INLINE_UI)){holdParagraph(one.p);if(!one.p.querySelector('[data-review-ui]'))return;}
 const r=sel.getRangeAt(0),anc=r.commonAncestorContainer,root=anc.nodeType===1?anc:anc.parentElement;
 if(!root||root.closest('[data-review-ui]'))return;
 const frag=r.cloneContents();
 if(!frag.querySelector('[data-review-ui]'))return;
 frag.querySelectorAll('[data-review-ui]').forEach(n=>n.remove());
 const box=document.createElement('div');box.style.cssText='position:fixed;left:-99999px;top:0;white-space:pre-wrap';box.append(frag);
 document.body.append(box);const text=box.innerText,html=box.innerHTML;box.remove();
 e.clipboardData.setData('text/plain',text);e.clipboardData.setData('text/html',html);e.preventDefault();
});
document.addEventListener('input',e=>{
 const q=sug.pending;if(!q||!e.target.closest||e.target.closest('[data-tid]')!==q.p)return;
 // The paragraph changed while waiting: the answer would no longer fit.
 sug.pending=null;hideSpinner();send({type:'suggest-cancel',token:q.token,stale:true});
});
document.addEventListener('selectionchange',()=>{
 if(ghost){const c=caretInfo();if(!c||c.p!==ghost.p||!c.collapsed||c.offset!==ghost.offset)removeGhost();}
 updateNav();
});
document.addEventListener('focusout',e=>{
 if(ghost&&e.target===ghost.p)removeGhost();
 // Focus moved to another element in the frame while waiting: the answer no longer belongs to the caret.
 // (A window/app switch has no relatedTarget and keeps the request.)
 const q=sug.pending;
 if(q&&e.target===q.p&&e.relatedTarget&&e.relatedTarget!==q.p){sug.pending=null;hideSpinner();send({type:'suggest-cancel',token:q.token,stale:true});}
 setTimeout(updateNav,0);
});
window.addEventListener('resize',()=>{if(ghost)renderGhost();updateNav();});
// Review controls never take focus or move the caret out of the paragraph.
document.addEventListener('mousedown',e=>{if(e.target.closest?.('[data-review-ui="hint"],[data-review-ui] button,[data-review-ui="ins"],[data-review-ui="marker"]'))e.preventDefault();},true);
document.addEventListener('click',e=>{
 const b=e.target.closest?.('[data-review-ui] button');
 if(b){
  if(b.disabled)return;
  if(b.closest('[data-review-ui="hint"]')){
   const t=nav.active;if(!t||nav.hint.dataset.pid!==t.item.id)return;
   if(b.dataset.act==='rereview'&&b.dataset.bundleId){send({type:'review-bundle',bundleId:b.dataset.bundleId});return;}
   if(b.dataset.act==='why'){
    const w=nav.hint.querySelector('.rv-why');if(!w)return;w.hidden=!w.hidden;b.setAttribute('aria-expanded',String(!w.hidden));
    if(w.hidden)review.open.delete(t.item.id);else review.open.add(t.item.id);
    placeFloating(nav.hint,rectOf(t),6);return;
   }
   // Echo the fingerprint of the proposal this popover displayed; the host refuses
   // the action if the finding changed before the click arrived.
   if((b.dataset.act==='apply'&&!t.blocked)||(b.dataset.act==='keep'&&!review.locked))if(nav.hint.contains(document.activeElement))returnFromHint();
   if(b.dataset.act==='apply'&&!t.blocked)act('apply',t);
   else if(b.dataset.act==='keep'&&!review.locked)act('keep',t);
   return;
  }
  const a=b.dataset.ghostAct;if(!a||!ghost)return;
  if(a==='accept')acceptGhost(true);
  else if(a==='word')acceptGhost(false);
  else if(a==='next')cycleGhost(1);
  else if(a==='again')startSuggest();
  else if(a==='dismiss'){removeGhost();announce('추천을 닫았어요.');ghostReturnFocus();}
  return;
 }
 // Click or tap on an inserted word / marker opens that proposal's popover.
 const ui=e.target.closest?.('[data-review-ui="ins"],[data-review-ui="marker"]');
 if(ui){e.preventDefault();const t=navTargets().find(x=>(x.els||[]).includes(ui));if(t)goTo(t);}
});
function returnFromHint(){
 const r=nav.returnTo;nav.returnTo=null;
 if(r&&r.el&&r.el.isConnected){r.el.focus({preventScroll:true});return;}
 if(r&&r.p&&r.p.isConnected){r.p.focus({preventScroll:true});restoreSel(r);updateNav();}
}
function ghostReturnFocus(){const p=selected;if(p&&p.isContentEditable&&document.activeElement!==p)p.focus({preventScroll:true});}
window.addEventListener('message',e=>{
 if(e.origin!==location.origin||e.source!==parent||!e.data?.editor)return;const m=e.data;
 if(m.type==='stickers'&&parent!==window&&Array.isArray(m.items)){
  document.querySelectorAll('[data-sticker-id]').forEach(el=>el.remove());
  for(const s of m.items){
   const bundle=[...document.querySelectorAll('.editor-bundle')].find(b=>b.dataset.bundle===s.bundleId);if(!bundle)continue;
   const before=[...bundle.querySelectorAll('[data-node-index]')].find(n=>Number(n.dataset.nodeIndex)===s.before);
   const template=document.createElement('template');template.innerHTML=s.html;
   const el=template.content.firstElementChild;if(!el)continue;el.dataset.bundle=s.bundleId;
   if(before)before.before(el);else bundle.append(el);
  }
 }
 if(m.type==='reveal-sticker'){
  const el=[...document.querySelectorAll('[data-sticker-id]')].find(n=>n.dataset.stickerId===m.id);
  if(el)send({type:'scroll',top:el.getBoundingClientRect().top+scrollY});
 }
 if(m.type==='annotations-changed')void annotationBadges();
 if(m.type==='lock'){if(m.locked){removeGhost();hideHint();if(sug.pending){sug.pending=null;hideSpinner();}}document.querySelectorAll('[data-tid]').forEach(el=>el.contentEditable=m.locked?'false':'true');}
 if(m.type==='hide-bundles'&&Array.isArray(m.ids)){document.querySelectorAll('.editor-bundle').forEach(b=>{b.hidden=m.ids.includes(b.dataset.bundle);});if(picked&&picked.hidden)pick(null);}
 if(m.type==='jump'){const b=[...document.querySelectorAll('[data-bundle]')].find(b=>b.dataset.bundle===m.id);if(b)send({type:'scroll',top:b.getBoundingClientRect().top+scrollY});}
 if(m.type==='replace'){const el=[...document.querySelectorAll('[data-tid]')].find(p=>p.dataset.tid===m.id);if(el){if(ghost&&ghost.p===el)removeGhost();if(nav.active&&nav.active.p===el)hideHint();review.targets=review.targets.filter(t=>t.p!==el);review.hl=review.hl.filter(h=>h.p!==el);paintHighlights();el.innerHTML=m.html;change(el);if(review.items.length)scheduleRender();}}
 if(m.type==='proposals'&&parent!==window&&Array.isArray(m.items)){const key=JSON.stringify(m.items)+'|'+!!m.locked;if(key!==review.key){review.key=key;review.items=m.items;review.locked=!!m.locked;renderReview();}}
 if(m.type==='proposals'&&parent!==window){resolveAfter();updateNav();}
 if(m.type==='reveal-proposal'&&typeof m.id==='string')revealProposal(m.id);
 if(m.type==='suggest-start')startSuggest();
 if(m.type==='suggest-result'&&typeof m.token==='string')suggestResult(m);
 if(m.type==='suggest-cancel'&&sug.pending&&(!m.token||m.token===sug.pending.token)){sug.pending=null;hideSpinner();}
 if(m.type==='format')formatRange(m.command,m.value);
 if(m.type==='focus'){const el=[...document.querySelectorAll('[data-tid]')].find(p=>p.dataset.tid===m.id);el?.focus();if(el)send({type:'scroll',top:el.getBoundingClientRect().top+scrollY-120});}
});
// Measure content, not the iframe viewport: viewport-based heights can retain
// empty space when text is shortened or the paper becomes wider.
const paper=document.querySelector('main');
if(paper){
 const measure=()=>{const css=getComputedStyle(document.body);send({type:'height',height:Math.ceil(paper.getBoundingClientRect().bottom+scrollY+(parseFloat(css.paddingBottom)||0)+(parseFloat(css.marginBottom)||0))+1});};
 new ResizeObserver(measure).observe(paper);
 document.fonts.ready.then(measure);
 measure();
}
send({type:'typography',styles:Object.fromEntries([...document.querySelectorAll('[data-tid]')].map(p=>{const css=getComputedStyle(p);return [p.dataset.tid,{fontFamily:css.fontFamily,fontSize:parseFloat(css.fontSize)}];}))});
send({type:'ready'});
`;

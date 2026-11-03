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
function change(el){if(ghost&&ghost.p===el)removeGhost();send({type:'change',id:el.dataset.tid,runs:serialize(el)});}
document.addEventListener('click',e=>{
 const node=e.target.closest('[data-node-index]');
 if(node&&document.documentElement.dataset.markup==='true')send({type:'sticker-anchor',bundleId:node.dataset.bundle,before:Number(node.dataset.nodeIndex)+1});
});
let picked=null;function pick(b){document.querySelectorAll('.editor-bundle.picked').forEach(x=>x.classList.remove('picked'));picked=b||null;if(picked)picked.classList.add('picked');}
document.addEventListener('focusin',e=>{const el=e.target.closest('[data-tid]');if(!el)return;pick(null);selected=el;document.querySelectorAll('.active').forEach(x=>x.classList.remove('active'));const b=el.closest('[data-bundle]');b?.classList.add('active');send({type:'select',id:el.dataset.tid,bundleId:b?.dataset.bundle});});
document.addEventListener('input',e=>{const el=e.target.closest('[data-tid]');if(!el)return;change(el);if(review.items.some(i=>i.paragraphId===el.dataset.tid))reviewPending();});
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
// Proposals arrive from the embedding editor only. Cards are inserted as
// siblings of [data-tid] paragraphs and in-text marks use CSS Custom Highlights,
// so no review UI ever enters a paragraph's DOM, serialize() or the saved body.
const reviewFont='-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",system-ui,sans-serif';
const reviewCss=[
 '::highlight(rv-del){background-color:#ffd9d6;color:#8d2219;text-decoration:line-through}',
 '::highlight(rv-target){background-color:#fff1b8}',
 '::highlight(rv-focus){background-color:#ffe08a}',
 '.rv-stack{display:flex;flex-direction:column;gap:8px;box-sizing:border-box;width:auto;max-width:100%;min-width:0;margin:6px 0 18px;padding:0;text-align:left;text-indent:0;font:13px/1.5 '+reviewFont+';color:#1f2b24;letter-spacing:normal;word-break:keep-all;overflow-wrap:anywhere;-webkit-user-select:none;user-select:none}',
 '.rv-stack .rv-card{display:block;box-sizing:border-box;max-width:100%;min-width:0;margin:0;padding:9px 11px;border:1px solid #d6e0d9;border-left:3px solid #5b8875;border-radius:8px;background:#fbfcfb;box-shadow:0 1px 3px #0000000f;font:13px/1.5 '+reviewFont+';color:#1f2b24;transition:box-shadow .2s}',
 '.rv-stack .rv-card.rv-blocked{border-left-color:#c58a2b;background:#fffaf0}',
 '.rv-stack .rv-card.rv-note{border-left-color:#7a8fb3;background:#f6f8fc}',
 '.rv-stack .rv-card.rv-flash{box-shadow:0 0 0 3px #ffe08a}',
 '.rv-stack .rv-head{display:flex;flex-wrap:wrap;gap:2px 8px;align-items:baseline;margin:0 0 4px}',
 '.rv-stack .rv-kind{font-size:12px;font-weight:700;color:#2f5a46}',
 '.rv-stack .rv-card.rv-blocked .rv-kind{color:#8a5a12}',
 '.rv-stack .rv-meta{font-size:12px;color:#6b7a70}',
 '.rv-stack .rv-diff{font-size:15px;line-height:1.6;white-space:pre-wrap}',
 '.rv-stack .rv-eq{color:#5b6660}',
 '.rv-stack .rv-del{background:#ffd9d6;color:#8d2219;text-decoration:line-through}',
 '.rv-stack .rv-ins{background:#d6f2dc;color:#14532d;text-decoration:underline;text-decoration-color:#4f9a64}',
 '.rv-stack .rv-format{display:grid;gap:6px}',
 '.rv-stack .rv-format-row{display:grid;grid-template-columns:auto minmax(0,1fr);gap:0 8px;align-items:baseline}',
 '.rv-stack .rv-format-label{font-size:11px;font-weight:700;color:#6b7a70}',
 '.rv-stack .rv-sample{min-width:0;white-space:pre-wrap;line-height:1.5}',
 '.rv-stack .rv-format-desc{grid-column:2;font-size:11px;color:#6b7a70}',
 '.rv-stack .rv-reason-line{margin:0 0 3px;font-size:12.5px;color:#8a5a12}',
 '.rv-stack .rv-plain{white-space:pre-wrap;color:#4b5650}',
 '.rv-stack .rv-note-text{white-space:pre-wrap}',
 '.rv-stack .rv-overlap{margin-top:4px;font-size:12px;color:#6b5a1e}',
 '.rv-stack .rv-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}',
 '.rv-stack .rv-actions button{all:unset;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-height:32px;padding:5px 12px;border:1px solid #c5d3c9;border-radius:6px;background:#fff;color:#1f2b24;font:600 13px/1.2 '+reviewFont+';cursor:pointer}',
 '.rv-stack .rv-actions button[data-act=apply]{background:#2f6f55;border-color:#2f6f55;color:#fff}',
 '.rv-stack .rv-actions button:disabled{opacity:.45;cursor:not-allowed}',
 '.rv-stack .rv-actions button:focus-visible{outline:2px solid #2f6f55;outline-offset:2px}',
 '.rv-stack .rv-why{margin-top:6px;padding-top:6px;border-top:1px dashed #d6e0d9;white-space:pre-wrap;color:#3f4a44;-webkit-user-select:text;user-select:text}',
 '.rv-stack .rv-why[hidden]{display:none}',
 '.rv-stack .rv-card.rv-focus{border-left-color:#c9a227;box-shadow:0 0 0 2px #f3d27a}',
 // Keyboard suggestion UI: Tab hint over review proposals, manual ghost text.
 '.rv-hint,.rv-ghostbar{position:absolute;z-index:1001;box-sizing:border-box;width:max-content;margin:0;text-align:left;text-indent:0;letter-spacing:normal;word-break:keep-all;overflow-wrap:anywhere;font:12.5px/1.5 '+reviewFont+';color:#1f2b24;background:#fff;border:1px solid #d6e0d9;border-radius:8px;box-shadow:0 4px 14px #0000001f;-webkit-user-select:none;user-select:none}',
 '.rv-hint{display:block;max-width:360px;padding:7px 10px 8px;border-left:3px solid #5b8875;pointer-events:none}',
 '.rv-hint.rv-hint-blocked{border-left-color:#c58a2b;background:#fffaf0}',
 '.rv-hint .rv-hint-head{display:flex;flex-wrap:wrap;gap:2px 8px;align-items:baseline;margin:0 0 2px}',
 '.rv-hint .rv-kind{font-size:12px;font-weight:700;color:#2f5a46}',
 '.rv-hint.rv-hint-blocked .rv-kind{color:#8a5a12}',
 '.rv-hint .rv-meta{font-size:11.5px;color:#6b7a70}',
 '.rv-hint .rv-diff{font-size:14px;line-height:1.55;white-space:pre-wrap}',
 '.rv-hint .rv-eq{color:#5b6660}',
 '.rv-hint .rv-del{background:#ffd9d6;color:#8d2219;text-decoration:line-through}',
 '.rv-hint .rv-ins{background:#d6f2dc;color:#14532d;text-decoration:underline;text-decoration-color:#4f9a64}',
 '.rv-hint .rv-plain{white-space:pre-wrap;color:#4b5650}',
 '.rv-hint .rv-reason-line{margin:0 0 2px;font-size:12px;color:#8a5a12}',
 '.rv-hint .rv-keys{display:flex;flex-wrap:wrap;align-items:center;gap:3px 10px;margin-top:5px;font-size:12px;color:#4b5650}',
 '.rv-hint kbd,.rv-ghostbar kbd{display:inline-block;padding:0 4px;border:1px solid #c5d3c9;border-bottom-width:2px;border-radius:4px;background:#f6f8f6;color:#1f2b24;font:600 11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}',
 '.rv-hint .rv-hint-actions{display:flex;gap:6px;margin-top:6px}',
 '.rv-hint button,.rv-ghostbar button{all:unset;pointer-events:auto;display:inline-flex;align-items:center;gap:5px;box-sizing:border-box;min-height:28px;padding:3px 9px;border:1px solid #c5d3c9;border-radius:6px;background:#fff;color:#1f2b24;font:600 12px/1.2 '+reviewFont+';cursor:pointer}',
 '.rv-hint button:disabled{opacity:.45;cursor:not-allowed}',
 '.rv-hint button:focus-visible,.rv-ghostbar button:focus-visible{outline:2px solid #2f6f55;outline-offset:2px}',
 '.rv-ghostbar{display:none;flex-wrap:wrap;align-items:center;gap:4px 6px;max-width:440px;padding:5px 6px}',
 '.rv-ghostbar .rv-ghost-label{padding:0 4px;font-size:12px;font-weight:700;color:#2f5a46;white-space:nowrap}',
 '.rv-ghostbar button[data-ghost-act=accept]{background:#2f6f55;border-color:#2f6f55;color:#fff}',
 '.rv-ghostbar button[data-ghost-act=accept] kbd{background:#ffffff26;border-color:#ffffff66;color:#fff}',
 '[data-review-ui=ghost]{color:#9aa29c!important;-webkit-text-fill-color:#9aa29c;font-style:normal;text-decoration:none;pointer-events:none;-webkit-user-select:none;user-select:none}',
 '.rv-spinner{position:absolute;z-index:1001;width:14px;height:14px;pointer-events:none}',
 '.rv-spinner .rv-ring{display:block;box-sizing:border-box;width:14px;height:14px;border:2px solid #c5d3c9;border-top-color:#2f6f55;border-radius:50%;animation:rv-spin .8s linear infinite}',
 '@keyframes rv-spin{to{transform:rotate(360deg)}}',
 '@media (prefers-reduced-motion:reduce){.rv-spinner .rv-ring{animation-duration:2.4s}}',
 '.rv-sr{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
].join('\n');
const KIND={text:'문장 수정',format:'서식 변경',note:'구성 의견'};
const canHighlight=typeof CSS!=='undefined'&&!!CSS.highlights&&typeof Highlight==='function';
const review={items:[],locked:false,key:'',ranges:new Map(),timer:0,pending:false,open:new Set()};
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
 const css=getComputedStyle(p),box=reviewEl('div','rv-format');
 const row=(variant,runs,label)=>{
  const r=reviewEl('div','rv-format-row');r.append(reviewEl('span','rv-format-label',variant==='current'?'현재':'제안'));
  const sample=reviewEl('span','rv-sample');sample.dataset.variant=variant;sample.style.fontFamily=css.fontFamily;sample.style.fontSize=css.fontSize;
  for(const run of runs){const s=reviewEl('span','',run.text);s.style.color=run.style.color||css.color;s.style.backgroundColor=run.style.background||'transparent';s.style.fontWeight=String(run.style.weight||css.fontWeight);if(run.style.size)s.style.fontSize=run.style.size+'px';sample.append(s);}
  r.append(sample,reviewEl('span','rv-format-desc',label));return r;
 };
 box.append(row('current',format.before,format.beforeLabel),row('proposed',format.after,format.afterLabel));
 return box;
}
function reviewCard(item,p,blocked,reason){
 const card=reviewEl('div','rv-card rv-'+item.kind+' rv-'+item.state+(blocked?' rv-blocked':''));
 card.dataset.reviewUi='card';card.dataset.proposal=item.id;card.setAttribute('role','group');card.setAttribute('aria-label','AI 제안 · '+KIND[item.kind]);
 const head=reviewEl('div','rv-head');head.append(reviewEl('span','rv-kind','AI 제안 · '+KIND[item.kind]));
 const meta=[item.severity,item.axis].filter(Boolean).join(' · ');if(meta)head.append(reviewEl('span','rv-meta',meta));
 card.append(head);
 if(item.kind==='note')card.append(reviewEl('div','rv-note-text',item.observation));
 else if(blocked){
  const line=reviewEl('div','rv-reason-line',reason);line.setAttribute('role','status');card.append(line);
  const plain=reviewEl('div','rv-plain',item.kind==='text'?clipText(item.before||'',80)+' → '+(item.after?clipText(item.after,80):'(삭제)'):'“'+clipText(item.phrase||'',60)+'” 서식 변경');
  if(item.kind==='text')plain.title=(item.before||'')+' → '+(item.after||'(삭제)');
  card.append(plain);
 }else if(item.kind==='text')card.append(diffView(item.segments||[]));
 else if(item.format)card.append(formatView(item.format,p));
 else card.append(reviewEl('div','rv-plain','“'+clipText(item.phrase||'',60)+'” 서식 변경'));
 if(item.overlaps?.length&&!blocked)card.append(reviewEl('div','rv-overlap','다른 제안과 범위가 겹쳐요. 하나를 적용하면 나머지를 다시 확인해요.'));
 const actions=reviewEl('div','rv-actions');
 const button=(act,label,disabled)=>{const b=reviewEl('button','',label);b.type='button';b.dataset.act=act;b.disabled=disabled;actions.append(b);return b;};
 if(item.kind!=='note')button('apply','적용',blocked||!item.canApply||review.locked);
 button('keep','현재 유지',review.locked);
 if(item.kind!=='note'){
  // The full before/after stays reachable even when the card shows a clipped line.
  const full=item.kind==='text'?'원문: '+(item.before||'')+'\n제안: '+(item.after||'(삭제)'):'';
  const why=reviewEl('div','rv-why',[item.observation,reason,full].filter(Boolean).join('\n\n'));
  const open=review.open.has(item.id);why.hidden=!open;
  const b=button('why','이유',false);b.setAttribute('aria-expanded',String(open));
  card.append(actions,why);
 }else card.append(actions);
 const range=review.ranges.get(item.id);
 if(range&&canHighlight){
  const on=()=>{const h=new Highlight(range);h.priority=3;CSS.highlights.set('rv-focus',h);};
  const off=()=>focusHighlight(nav.focusRange);
  card.addEventListener('mouseenter',on);card.addEventListener('mouseleave',off);
  card.addEventListener('focusin',on);card.addEventListener('focusout',off);
 }
 return card;
}
function clearReview(){
 document.querySelectorAll('.rv-stack[data-review-ui]').forEach(e=>e.remove());
 if(canHighlight)['rv-del','rv-target','rv-focus'].forEach(n=>CSS.highlights.delete(n));
 review.ranges=new Map();
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
function renderReview(){
 // Restore keyboard focus only while this frame holds focus; never pull it from the host.
 const active=document.hasFocus()?document.activeElement?.closest?.('[data-review-ui] button'):null;
 const order=[...document.querySelectorAll('.rv-card[data-proposal]')].map(c=>c.dataset.proposal);
 const restore=active?{id:active.closest('[data-proposal]')?.dataset.proposal,act:active.dataset.act}:null;
 const activeItem=restore?review.items.find(i=>i.id===restore.id):null;
 clearReview();
 if(!review.items.length)return;
 ensureReviewStyle();
 const del=[],target=[],stacks=[];
 const stackFor=(node,mode)=>{
  const found=stacks.find(s=>s.node===node&&s.mode===mode);if(found)return found.el;
  const s=reviewEl('div','rv-stack');s.dataset.reviewUi='stack';s.contentEditable='false';
  if(mode==='after')node.after(s);else node.before(s);
  stacks.push({node,mode,el:s});return s;
 };
 const live=review.items.filter(i=>i.state!=='applied'&&i.state!=='decided');
 const byParagraph=new Map();
 for(const item of live){if(item.kind==='note'||!item.paragraphId)continue;if(!byParagraph.has(item.paragraphId))byParagraph.set(item.paragraphId,[]);byParagraph.get(item.paragraphId).push(item);}
 for(const [id,list] of byParagraph){
  const p=paragraphOf(id);if(!p)continue;
  const map=plainMap(p);
  list.sort((a,b)=>(a.start??Infinity)-(b.start??Infinity));
  for(const item of list){
   let blocked=!item.canApply,reason=item.reason;
   if(item.start!==undefined&&item.end!==undefined){
    const unique=map.text.slice(item.start,item.end)===item.phrase&&map.text.indexOf(item.phrase)===item.start&&map.text.indexOf(item.phrase,item.start+1)<0;
    const range=unique?rangeOf(map,item.start,item.end):null;
    if(!range){blocked=true;reason='위치를 확인하는 중이에요. 본문 변경을 반영한 뒤 다시 표시할게요.';}
    else if(!blocked){
     review.ranges.set(item.id,range);
     const cuts=item.kind==='text'?(item.deleted||[]).map(([s,e])=>rangeOf(map,s,e)):[];
     if(cuts.length&&cuts.every(Boolean))del.push(...cuts);else target.push(range);
    }
   }else if(!blocked){blocked=true;reason='대상 구절 위치를 확정할 수 없어요. 다시 검토해주세요.';}
   stackFor(p,'after').append(reviewCard(item,p,blocked,reason));
  }
 }
 for(const item of live){
  if(item.kind!=='note')continue;
  const anchor=noteAnchor(item);if(!anchor)continue;
  stackFor(anchor.node,anchor.mode).append(reviewCard(item,null,false,item.reason));
 }
 if(canHighlight){
  if(del.length){const h=new Highlight(...del);h.priority=2;CSS.highlights.set('rv-del',h);}
  if(target.length){const h=new Highlight(...target);h.priority=1;CSS.highlights.set('rv-target',h);}
 }
 if(restore?.id){
  const card=[...document.querySelectorAll('.rv-card[data-proposal]')].find(c=>c.dataset.proposal===restore.id);
  let b=card?.querySelector('button[data-act="'+restore.act+'"]:not(:disabled)')||card?.querySelector('button:not(:disabled)');
  if(!card){
   // The decided card is gone: continue with the next proposal (or the previous
   // one), then fall back to the target paragraph so focus never drops to body.
   const cards=[...document.querySelectorAll('.rv-card[data-proposal]')];
   const at=order.indexOf(restore.id);
   const next=cards.find(c=>order.indexOf(c.dataset.proposal)>at)||cards.filter(c=>{const i=order.indexOf(c.dataset.proposal);return i>=0&&i<at;}).at(-1)||cards[0];
   b=next?.querySelector('button[data-act="apply"]:not(:disabled)')||next?.querySelector('button:not(:disabled)');
   if(!b){const p=activeItem?.paragraphId&&paragraphOf(activeItem.paragraphId);if(p?.isContentEditable)b=p;}
  }
  b?.focus({preventScroll:true});
 }
}
// After an edit the host recomputes and resends proposals; until then live ranges
// follow the text. Re-verify locally only if no update arrives.
function reviewPending(){review.pending=true;clearTimeout(review.timer);review.timer=setTimeout(()=>{review.pending=false;renderReview();updateNav();},400);}
document.addEventListener('mousedown',e=>{if(e.target.closest?.('[data-review-ui] button'))e.preventDefault();},true);
document.addEventListener('click',e=>{
 const b=e.target.closest?.('[data-review-ui] button');if(!b||b.disabled)return;
 const card=b.closest('[data-proposal]'),id=card?.dataset.proposal;if(!id)return;
 if(b.dataset.act==='why'){const w=card.querySelector('.rv-why');if(!w)return;w.hidden=!w.hidden;b.setAttribute('aria-expanded',String(!w.hidden));if(w.hidden)review.open.delete(id);else review.open.add(id);return;}
 // Echo the fingerprint of the proposal this card displayed; the host refuses
 // the action if the finding changed before the click arrived.
 const item=review.items.find(i=>i.id===id);
 if(item&&(b.dataset.act==='apply'||b.dataset.act==='keep'))send({type:'proposal-action',action:b.dataset.act,id,sig:item.sig});
});
function revealProposal(id){
 const card=[...document.querySelectorAll('.rv-card[data-proposal]')].find(c=>c.dataset.proposal===id);if(!card)return;
 send({type:'scroll',top:card.getBoundingClientRect().top+scrollY-120});
 card.classList.add('rv-flash');setTimeout(()=>card.classList.remove('rv-flash'),1600);
 card.querySelector('button:not(:disabled)')?.focus({preventScroll:true});
}
// ---- Keyboard suggestions ----------------------------------------------------
// Layer 1: Tab/Esc/Shift+Tab walk the review proposals above. Layer 2: a manual
// request ("✦ 추천 받기" or Alt+\) shows gray ghost text at the caret. Every
// element here carries data-review-ui, so serialize()/plainMap() skip it, and the
// ghost is removed (and split text re-joined) before any edit is reported.
// Nothing changes in the manuscript until the writer explicitly accepts.
const isMac=/Mac|iPhone|iPad/.test(navigator.platform||'');
const nav={focusId:'',focusP:null,focusAt:-1,focusRange:null,after:null,timer:0,key:'',hint:null,bar:null,live:null};
const sug={pending:null,spinner:null};
function ensureReviewStyle(){if(!document.querySelector('style[data-review-ui]')){const s=document.createElement('style');s.dataset.reviewUi='style';s.textContent=reviewCss;document.head.append(s);}}
function focusHighlight(range){nav.focusRange=range||null;if(!canHighlight)return;if(range){const h=new Highlight(range);h.priority=3;CSS.highlights.set('rv-focus',h);}else CSS.highlights.delete('rv-focus');}
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
 const lo=Math.max(4,box.left+4),hi=Math.min(vw-4,box.right-4);
 el.style.maxWidth=Math.max(180,Math.min(hi-lo,440))+'px';
 const w=el.offsetWidth,h=el.offsetHeight;
 el.style.left=Math.max(lo,Math.min(rect.left,hi-w))+'px';
 const limit=box.bottom+scrollY+(parseFloat(getComputedStyle(document.body).paddingBottom)||0);
 const below=rect.bottom+scrollY+gap,above=rect.top+scrollY-gap-h;
 el.style.top=(below+h>limit&&above>0?above:below)+'px';
}

// -- Layer 1: Tab over review proposals --
/** Live, located proposals in document order. Offsets follow live highlight ranges while the host recomputes. */
function navTargets(){
 const ps=[...document.querySelectorAll('[data-tid]')],maps=new Map(),out=[];
 for(const item of review.items){
  if(item.kind==='note'||item.state==='applied'||item.state==='decided'||!item.paragraphId)continue;
  const pi=ps.findIndex(p=>p.dataset.tid===item.paragraphId);if(pi<0)continue;
  const p=ps[pi];if(!maps.has(p))maps.set(p,plainMap(p));const map=maps.get(p);
  const r=review.ranges.get(item.id),live=r&&!r.collapsed&&p.contains(r.startContainer)&&p.contains(r.endContainer)?r:null;
  let start=item.start,end=item.end;
  if(live){start=offsetOf(p,live.startContainer,live.startOffset,map);end=offsetOf(p,live.endContainer,live.endOffset,map);}
  if(start===undefined||end===undefined)continue;
  out.push({item,p,pi,start,end,range:live,blocked:!item.canApply||review.locked||!live});
 }
 return out.sort((a,b)=>a.pi-b.pi||a.start-b.start||a.end-b.end);
}
/** The proposal the caret is on (its range contains the caret), else the next one in the same paragraph. */
function navState(c,list){
 if(!c||!c.collapsed)return null;
 if(nav.focusP!==c.p||nav.focusAt!==c.offset)nav.focusId='';
 const here=list.filter(t=>t.p===c.p),containing=here.filter(t=>t.start<=c.offset&&c.offset<=t.end);
 const on=containing.find(t=>t.item.id===nav.focusId)||containing[0];
 if(on)return {t:on,on:true};
 const ahead=here.find(t=>t.start>c.offset);
 return ahead?{t:ahead,on:false}:null;
}
function stepFrom(c,list,dir,on){
 if(on){const i=list.indexOf(on);return dir>0?list[i+1]:list[i-1];}
 return dir>0?list.find(t=>t.pi>c.pi||(t.pi===c.pi&&t.start>c.offset)):[...list].reverse().find(t=>t.pi<c.pi||(t.pi===c.pi&&t.start<c.offset));
}
function setActiveCard(id){document.querySelectorAll('.rv-card[data-proposal]').forEach(card=>card.classList.toggle('rv-focus',card.dataset.proposal===id));}
// The hint exists only while a proposal is active; the persistent live region announces it.
function hideHint(){if(nav.hint){nav.hint.remove();nav.hint=null;}nav.key='';setActiveCard(null);focusHighlight(null);}
function fillHint(h,t,mode,hasNext,hasPrev){
 h.replaceChildren();h.classList.toggle('rv-hint-blocked',mode==='blocked');
 const head=reviewEl('div','rv-hint-head');head.append(reviewEl('span','rv-kind','AI 제안 · '+KIND[t.item.kind]));
 if(mode==='ahead')head.append(reviewEl('span','rv-meta','이 문단의 다음 제안'));
 h.append(head);
 if(mode==='blocked')h.append(reviewEl('div','rv-reason-line',review.locked?'저장이나 검토 준비가 끝날 때까지 적용할 수 없어요.':(t.item.reason||'지금은 적용할 수 없어요.')));
 if(t.item.kind==='text')h.append(diffView(t.item.segments||[]));
 else h.append(reviewEl('div','rv-plain','“'+clipText(t.item.phrase||'',40)+'” '+(t.item.format&&t.item.format.afterLabel?'→ '+t.item.format.afterLabel:'서식 변경')));
 const keys=reviewEl('div','rv-keys');
 const key=(k,label)=>{const s=reviewEl('span','rv-key');s.append(reviewEl('kbd','',k),document.createTextNode(' '+label));keys.append(s);};
 if(mode==='apply'){key('Tab','적용');key('Esc','유지');}
 else if(mode==='blocked'){if(hasNext)key('Tab','다음');if(!review.locked)key('Esc','유지');}
 else key('Tab','이 제안으로 이동');
 if(hasPrev)key('Shift+Tab','이전');
 h.append(keys);
 const actions=reviewEl('div','rv-hint-actions'),b=reviewEl('button','','다시 검토');
 b.type='button';b.dataset.hintAct='rereview';b.dataset.bundleId=t.item.bundleId;b.disabled=review.locked;
 b.title='이 묶음을 다시 검토해요. 저장 전 변경이 있으면 먼저 저장해요.';
 actions.append(b);h.append(actions);
}
function updateNav(){
 const act=document.activeElement;
 if(ghost||review.locked||!act||!act.matches||!act.matches('[data-tid]')||!review.items.length){hideHint();return;}
 const c=caretInfo();if(!c||c.p!==act){hideHint();return;}
 const list=navTargets(),s=navState(c,list);
 if(!s){hideHint();return;}
 const t=s.t,mode=s.on?(t.blocked?'blocked':'apply'):'ahead';
 const hasNext=!!stepFrom(c,list,1,s.on?t:null),hasPrev=!!stepFrom(c,list,-1,s.on?t:null);
 ensureReviewStyle();
 if(!nav.hint){const h=reviewEl('div','rv-hint');h.dataset.reviewUi='hint';h.setAttribute('role','status');h.setAttribute('aria-live','polite');document.body.append(h);nav.hint=h;}
 const key=[t.item.id,t.item.sig,mode,hasNext,hasPrev,review.locked].join('|');
 if(key!==nav.key){nav.key=key;fillHint(nav.hint,t,mode,hasNext,hasPrev);announce('AI 제안: '+(t.item.kind==='text'?(t.item.before||'')+' → '+(t.item.after||'(삭제)'):KIND[t.item.kind])+'. '+(mode==='apply'?'Tab 적용, Esc 유지':mode==='blocked'?'적용할 수 없어요. '+(hasNext?'Tab 다음':''):'Tab 이 제안으로 이동'));}
 placeFloating(nav.hint,t.range?t.range.getBoundingClientRect():caretRect(t.p,t.start),6);
 setActiveCard(t.item.id);focusHighlight(t.range);
}
function goTo(t){
 nav.focusId=t.item.id;nav.focusP=t.p;nav.focusAt=t.start;
 setCaret(t.p,t.start,t.start,true);
 const rect=t.range?t.range.getBoundingClientRect():caretRect(t.p,t.start);
 send({type:'reveal',top:rect.top+scrollY,bottom:rect.bottom+scrollY+120});
 updateNav();
}
/** Apply/keep through the host's existing proposal-action path, then continue once fresh proposals arrive. */
function act(action,t){
 send({type:'proposal-action',action,id:t.item.id,sig:t.item.sig});
 clearTimeout(nav.timer);
 nav.after={id:t.item.id,pid:t.item.paragraphId,pi:t.pi,start:t.start,action,len:action==='apply'&&t.item.kind==='text'?(t.item.after||'').length:t.end-t.start};
 // The host may refuse (changed finding, busy); then nothing moves.
 nav.timer=setTimeout(()=>{nav.after=null;},2500);
 hideHint();
}
function resolveAfter(){
 const a=nav.after;if(!a)return;
 const still=review.items.find(i=>i.id===a.id);
 if(still&&still.state!=='applied'&&still.state!=='decided')return;
 nav.after=null;clearTimeout(nav.timer);
 const next=navTargets().find(t=>t.pi>a.pi||(t.item.paragraphId===a.pid&&t.start>=a.start));
 if(next){goTo(next);return;}
 const p=paragraphOf(a.pid);
 if(p&&p.isContentEditable&&a.action==='apply')setCaret(p,a.start+a.len,a.start+a.len,true);
 updateNav();
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
 sug.pending={token,p,offset:c.offset,start:c.start,collapsed:c.collapsed,key:JSON.stringify(runs)};
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
 const fresh=!m.stale&&document.contains(q.p)&&selected===q.p&&document.activeElement===q.p&&!review.locked&&q.p.isContentEditable&&JSON.stringify(serialize(q.p))===q.key&&!!c&&c.p===q.p&&c.offset===q.offset&&c.start===q.start&&c.collapsed===q.collapsed&&!c.inLink;
 if(!fresh){send({type:'suggest-done',token:q.token,outcome:'stale'});return;}
 if(!list.length){send({type:'suggest-done',token:q.token,outcome:'empty'});updateNav();return;}
 showGhost(q.p,q.offset,list,0);
 send({type:'suggest-done',token:q.token,outcome:'shown',count:list.length});
}
function showGhost(p,offset,list,index){
 removeGhost();ensureReviewStyle();hideHint();
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
document.addEventListener('keydown',e=>{
 if(e.isComposing||e.keyCode===229){if(!e.isComposing&&ghost)removeGhost();return;}
 if(e.altKey&&!e.ctrlKey&&!e.metaKey&&e.code==='Backslash'){e.preventDefault();e.stopImmediatePropagation();startSuggest();return;}
 if(ghost&&ghostKey(e)){e.stopImmediatePropagation();return;}
 if(e.key==='Escape'&&sug.pending&&!e.altKey&&!e.ctrlKey&&!e.metaKey){const q=sug.pending;sug.pending=null;hideSpinner();e.preventDefault();send({type:'suggest-cancel',token:q.token,notify:true});return;}
 if(review.locked||e.altKey||e.ctrlKey||e.metaKey||(e.key!=='Tab'&&e.key!=='Escape'))return;
 if(!e.target.closest||!e.target.closest('[data-tid]'))return;
 const c=caretInfo();if(!c)return;
 const list=navTargets();if(!list.length)return;
 const s=navState(c,list),on=s&&s.on?s.t:null;
 if(e.key==='Escape'){if(e.shiftKey||!on)return;e.preventDefault();act('keep',on);return;}
 if(!e.shiftKey&&on&&!on.blocked){e.preventDefault();act('apply',on);return;}
 // Not on an applicable proposal: Tab moves to the next one (Shift+Tab: previous).
 // With nothing ahead/behind, Tab keeps its default so focus is never trapped.
 const t=stepFrom(c,list,e.shiftKey?-1:1,on);
 if(t){e.preventDefault();goTo(t);}
},true);
document.addEventListener('compositionstart',()=>removeGhost());
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
document.addEventListener('click',e=>{
 const b=e.target.closest?.('[data-review-ui] button');if(!b||b.disabled)return;
 if(b.dataset.hintAct==='rereview'&&b.dataset.bundleId){send({type:'review-bundle',bundleId:b.dataset.bundleId});return;}
 const a=b.dataset.ghostAct;if(!a||!ghost)return;
 if(a==='accept')acceptGhost(true);
 else if(a==='word')acceptGhost(false);
 else if(a==='next')cycleGhost(1);
 else if(a==='again')startSuggest();
 else if(a==='dismiss'){removeGhost();announce('추천을 닫았어요.');ghostReturnFocus();}
});
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
 if(m.type==='replace'){const el=[...document.querySelectorAll('[data-tid]')].find(p=>p.dataset.tid===m.id);if(el){if(ghost&&ghost.p===el)removeGhost();el.innerHTML=m.html;change(el);if(review.items.length)reviewPending();}}
 if(m.type==='proposals'&&parent!==window&&Array.isArray(m.items)){const key=JSON.stringify(m.items)+'|'+!!m.locked;if(key!==review.key||review.pending){clearTimeout(review.timer);review.pending=false;review.key=key;review.items=m.items;review.locked=!!m.locked;renderReview();}}
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

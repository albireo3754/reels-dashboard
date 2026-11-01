/** Runs only inside the same-origin, dedicated editor frame. Never evaluates article HTML. */
export const frameScript = String.raw`
const send=(data)=>parent.postMessage({editor:true,...data},location.origin);
let selected, savedRange;
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
  if(node.nodeType!==1)return;
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
function change(el){send({type:'change',id:el.dataset.tid,runs:serialize(el)});}
document.addEventListener('focusin',e=>{const el=e.target.closest('[data-tid]');if(!el)return;selected=el;document.querySelectorAll('.active').forEach(x=>x.classList.remove('active'));const b=el.closest('[data-bundle]');b?.classList.add('active');send({type:'select',id:el.dataset.tid,bundleId:b?.dataset.bundle});});
document.addEventListener('input',e=>{const el=e.target.closest('[data-tid]');if(el)change(el);});
document.addEventListener('paste',e=>{if(!e.target.closest('[data-tid]'))return;e.preventDefault();document.execCommand('insertText',false,e.clipboardData.getData('text/plain').replace(/\n\s*\n/g,'\n'));});
document.addEventListener('drop',e=>e.preventDefault());
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'&&!e.isComposing){e.preventDefault();send({type:'review',scope:e.shiftKey?'changed':'selected'});}else if(e.key==='Enter'&&e.target.closest('[data-tid]')){e.preventDefault();if(e.target.dataset.tid!=='$title')document.execCommand('insertLineBreak');}});
document.addEventListener('click',e=>{if(e.target.closest('a'))e.preventDefault();const b=e.target.closest('[data-bundle]');if(b)send({type:'select',bundleId:b.dataset.bundle});});
function formatRange(command,value){if(!selected||!savedRange||savedRange.collapsed||selected.contentEditable!=='true')return;
  const range=savedRange.cloneRange();selected.focus();const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
  document.execCommand('styleWithCSS',false,'true');
  if(command==='size'&&[11,13,15,16,19,24,26,28,30,32,34,38,45].includes(Number(value))){
   document.execCommand('fontSize',false,'7');
   selected.querySelectorAll('[style],font[size="7"]').forEach(el=>{if(el.style.fontSize==='xxx-large'||el.getAttribute('size')==='7'){el.style.fontSize=Number(value)+'px';el.removeAttribute('size');}});
  }else if(command==='clearBackground')document.execCommand('hiliteColor',false,'transparent');
  else if(['bold','foreColor','hiliteColor','removeFormat'].includes(command))document.execCommand(command,false,value);
  change(selected);selectionState();
 }
window.addEventListener('message',e=>{
 if(e.origin!==location.origin||e.source!==parent||!e.data?.editor)return;const m=e.data;
 if(m.type==='annotations-changed')void annotationBadges();
 if(m.type==='lock'){document.querySelectorAll('[data-tid]').forEach(el=>el.contentEditable=m.locked?'false':'true');}
 if(m.type==='jump'){const b=[...document.querySelectorAll('[data-bundle]')].find(b=>b.dataset.bundle===m.id);if(b)send({type:'scroll',top:b.getBoundingClientRect().top+scrollY});}
 if(m.type==='replace'){const el=[...document.querySelectorAll('[data-tid]')].find(p=>p.dataset.tid===m.id);if(el){el.innerHTML=m.html;change(el);}}
 if(m.type==='format')formatRange(m.command,m.value);
 if(m.type==='focus'){const el=[...document.querySelectorAll('[data-tid]')].find(p=>p.dataset.tid===m.id);el?.focus();if(el)send({type:'scroll',top:el.getBoundingClientRect().top+scrollY-120});}
});
new ResizeObserver(()=>send({type:'height',height:Math.ceil(document.documentElement.getBoundingClientRect().height)})).observe(document.documentElement);
send({type:'typography',styles:Object.fromEntries([...document.querySelectorAll('[data-tid]')].map(p=>{const css=getComputedStyle(p);return [p.dataset.tid,{fontFamily:css.fontFamily,fontSize:parseFloat(css.fontSize)}];}))});
send({type:'ready'});
`;

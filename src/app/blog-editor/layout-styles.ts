import {readFile,realpath} from 'node:fs/promises';
import path from 'node:path';

/** Preserve the layout's CSS order, including explicitly linked local stylesheets. */
export async function layoutStyles(layout:string,file:string):Promise<string>{
  const root=path.dirname(file),styles:string[]=[];
  for(const match of layout.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>|<link\b[^>]*>/gi)){
    if(match[1]!==undefined){styles.push(match[1]);continue;}
    const attrs=Object.fromEntries([...match[0].matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)].map(m=>[m[1].toLowerCase(),m[2]]));
    if(!attrs.rel?.toLowerCase().split(/\s+/).includes('stylesheet'))continue;
    const href=attrs.href??'';
    const target=path.resolve(root,href);
    if(!href.endsWith('.css')||path.isAbsolute(href)||/^[a-z][\w+.-]*:/i.test(href)||!target.startsWith(root+path.sep)||await realpath(target)!==target)throw new Error('레이아웃 CSS는 같은 폴더 안의 로컬 파일이어야 해요.');
    let css=await readFile(target,'utf8');
    if(/@import\b/i.test(css))throw new Error('레이아웃 CSS의 @import 대신 HTML에서 스타일 파일을 직접 연결해주세요.');
    css=css.replace(/url\(\s*(["']?)([^)'"\s]+)\1\s*\)/g,(_,quote,url)=>{
      if(/^(?:[a-z][\w+.-]*:|\/|#)/i.test(url))return `url(${quote}${url}${quote})`;
      return `url(${quote}${path.relative(root,path.resolve(path.dirname(target),url))}${quote})`;
    });
    styles.push(attrs.media?`@media ${attrs.media}{${css}}`:css);
  }
  return styles.join('\n');
}

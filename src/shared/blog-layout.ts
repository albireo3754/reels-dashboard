import path from "node:path";
import {escapeHtml} from "./canonical-blog";

/**
 * Puts the manuscript title into a layout's `<title>` and the page heading: the first `<h1>`
 * before the article (the article itself is rendered from the manuscript).
 */
export function retitleLayout(html:string,title:string){
  const text=escapeHtml(title);
  let out=html.replace(/<title>[\s\S]*?<\/title>/,()=>`<title>${text}</title>`);
  const article=out.search(/<article(?:\s[^>]*)?>/);
  const head=article<0?out:out.slice(0,article),rest=article<0?"":out.slice(article);
  out=head.replace(/(<h1(?:\s[^>]*)?>)[\s\S]*?(<\/h1>)/,(_,open:string,close:string)=>open+text+close)+rest;
  return out;
}

/** A layout copied from `from` to `to`: relative `url(...)` references keep pointing at the same files. */
export function relocateLayout(html:string,from:string,to:string){
  const fromDir=path.dirname(path.resolve(from)),toDir=path.dirname(path.resolve(to));
  return html.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g,(whole,quote:string,ref:string)=>{
    if(/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(ref))return whole;
    const moved=path.relative(toDir,path.resolve(fromDir,ref)).split(path.sep).join("/");
    return `url(${quote}${moved}${quote})`;
  });
}

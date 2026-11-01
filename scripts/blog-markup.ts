import {AnnotationStore} from "../src/app/blog-editor/annotations";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, serialize, validate, legend } from "../src/shared/blog-markup";
import { bundleHashes, merge3, reviewFresh } from "../src/shared/blog-markup-source";
import { renderHtml, MARKUP_STYLE_CSS } from "../src/shared/blog-markup-render";
import { convertLayers } from "../src/shared/blog-markup-convert";
const [command,file,...args]=process.argv.slice(2);
const read=(f:string)=>readFile(f,"utf8");
async function main(){
  if(!file)throw new Error("Usage: blog-markup.ts check|view|render|hash|merge|convert-layers <file> [arguments]");
  const source=await read(file);
  if(command==="merge"){
    if(args.length!==2)throw new Error("merge <base> <mine> <current>");
    console.log(JSON.stringify(merge3(source,await read(args[0]),await read(args[1])),null,2));return;
  }
  if(command==="convert-layers"){
    // Manifest paths are relative to the manifest. Output goes to stdout for explicit review.
    const spec=JSON.parse(source),resolve=(p:string)=>path.resolve(path.dirname(file),p);
    const json=async(p:string)=>JSON.parse(await read(resolve(p)));
    const [canonical,grouping,bundles,emphasis]=await Promise.all([read(resolve(spec.source)),json(spec.grouping),json(spec.bundles),json(spec.emphasis)]);
    process.stdout.write(serialize(convertLayers({...spec,source:canonical,layout:grouping.layout,bundles:bundles.bundles,emphasis:emphasis.emphasis})));return;
  }
  const doc=parse(source);
  if(command==="check"){const issues=validate(doc);console.log(JSON.stringify(issues,null,2));if(issues.some(i=>i.level==="error"))process.exitCode=1;return;}
  if(command==="view"){
    let rules="";
    if(typeof doc.metadata?.notes==="string"){
      const notes=await read(path.resolve(path.dirname(file),doc.metadata.notes));
      rules=notes.match(/^## 규칙\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]??"";
      if(!rules)throw new Error("Notes requires ## 규칙");
    }
    const annotations=await new AnnotationStore(file).list();
    console.log(legend()+"\n\n"+(rules?"## 규칙\n"+rules+"\n":"")+serialize(doc)+(annotations.length?"\n## 사용자 주석 (비공개)\n"+JSON.stringify(annotations,null,2)+"\n":"")+"\n"+validate(doc).map(i=>`※ ${i.where} ${i.message}`).join("\n"));return;
  }
  if(command==="hash"){
    const hashes=bundleHashes(doc);
    const review=args[0]?JSON.parse(await read(args[0])):null;
    console.log(JSON.stringify({hashes,reviews:review?.reviews?.map((r:any)=>({...r,findings:r.findings.map((f:any)=>({...f,fresh:!!hashes[r.bundleId]&&reviewFresh(f.axis,f.basedOn??r.basedOn,hashes[r.bundleId])}))}))},null,2));return;
  }
  if(command==="render"){
    const output=args[0];if(!output)throw new Error("render <source.md> <existing-layout.html>");
    const html=await read(output);
    if((html.match(/<article(?:\s[^>]*)?>/g)??[]).length!==1)throw new Error("Expected exactly one article");
    const media=typeof doc.metadata?.media==="string"?path.relative(path.dirname(output),path.resolve(path.dirname(file),doc.metadata.media)).split(path.sep).join("/")+"/":undefined;
    const rendered=html.replace(/<article(?:\s[^>]*)?>[\s\S]*?<\/article>/,()=>renderHtml(doc,{media}));
    await writeFile(output+".before-markup",html,{flag:"wx"});
    const clean=rendered.replace(/<style id="blog-markup-theme">[\s\S]*?<\/style>/g,"");
    const themed=clean.includes("</head>")?clean.replace("</head>",MARKUP_STYLE_CSS+"</head>"):clean.replace("<body",MARKUP_STYLE_CSS+"<body");
    await writeFile(output,themed);return;
  }
  throw new Error("Unknown command "+command);
}
main().catch(e=>{console.error(String(e));process.exitCode=1;});

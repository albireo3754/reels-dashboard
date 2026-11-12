import {readFile,writeFile} from "node:fs/promises";
import path from "node:path";

type Connection={[key:string]:unknown;canon:string;layout?:string;layers?:string;requests?:string;review?:string;mediaEvidence?:string;reviewGuidance?:string[]};
const CONVENTION=(dir:string,layers:string)=>({layout:path.join(dir,"publishing","smarteditor-draft-layout.html"),layers:path.join(dir,"reviews"),requests:path.join(layers,"requests"),review:path.join(layers,"bundle-review.json")});

/**
 * Registers blog projects the way the app finds them: a content card in dashboard.json whose
 * document resource is the manuscript. Paths that differ from the folder conventions are
 * written into the manuscript's frontmatter `editor:` map, as a real manuscript would.
 */
export async function writeBlogCards(profile:string,projects:Array<{id:string;title:string;config:Connection}>,{manuscripts="write"}:{manuscripts?:"write"|"untouched"}={}){
  // `untouched`: a real private manuscript is only linked; it must already resolve by itself.
  for(const {config} of manuscripts==="write"?projects:[]){
    const dir=path.dirname(config.canon),layers=config.layers??path.join(dir,"reviews"),convention=CONVENTION(dir,layers);
    const editor:Record<string,unknown>={};
    for(const key of ["layout","layers","requests","review"] as const)
      if(config[key]&&path.resolve(config[key]!)!==convention[key])editor[key]=path.relative(dir,config[key]!)||".";
    if(config.mediaEvidence)editor.mediaEvidence=path.relative(dir,config.mediaEvidence);
    if(config.reviewGuidance)editor.reviewGuidance=config.reviewGuidance.map(f=>path.relative(dir,f));
    const source=await readFile(config.canon,"utf8"),cleaned=source.replace(/^editor: .*\n/m,"");
    const next=Object.keys(editor).length?cleaned.replace(/\n---\n/,`\neditor: ${JSON.stringify(editor)}\n---\n`):cleaned;
    if(next!==source)await writeFile(config.canon,next);
  }
  const file=path.join(profile,"dashboard.json");
  let dashboard:{schemaVersion:1;updatedAt:string;projects:Array<{id:string}>}={schemaVersion:1,updatedAt:"",projects:[]};
  try{dashboard=JSON.parse(await readFile(file,"utf8"));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  const ids=new Set(projects.map(p=>p.id));
  dashboard.projects=[...dashboard.projects.filter(p=>!ids.has(p.id)),...projects.map(({id,title,config})=>({
    id,title,date:"2026-11-12",stage:"editing",nextAction:"",publicURL:"",shared:false,
    resources:[{role:"document",path:config.canon,label:"블로그 원고"}],
  }))];
  dashboard.updatedAt=new Date().toISOString();
  await writeFile(file,JSON.stringify(dashboard));
}

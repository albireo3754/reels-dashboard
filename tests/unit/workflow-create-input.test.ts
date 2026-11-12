import {test} from "node:test";
import assert from "node:assert/strict";
import {createRunInput} from "../../src/features/workflow/model/create-input";

const form=(fields:Record<string,string>)=>{const f=new FormData();for(const[k,v]of Object.entries(fields))f.set(k,v);return f;};
const base={title:"T",workspace:"/ws",instructions:"do it",files:" a.txt \n\n b.txt\n",maxRevisions:"3"};

test("createRunInput without a definition collects experience and omits definition fields",()=>{
 const out=createRunInput(form({...base,experience:"on",guideFile:"g.md",skipCompleted:"on"}),{usesDefinition:false,builtinDefinition:"",definitionFile:""});
 assert.deepStrictEqual(out,{title:"T",workspace:"/ws",instructions:"do it",trackedFiles:["a.txt","b.txt"],maxRevisions:3,collectExperience:true});
 assert.deepStrictEqual(Object.keys(out),["title","workspace","instructions","trackedFiles","maxRevisions","collectExperience"]);
});

test("createRunInput with a builtin definition sends builtinDefinition and never experience",()=>{
 const out=createRunInput(form({...base,experience:"on"}),{usesDefinition:true,builtinDefinition:"blog",definitionFile:"ignored.json"});
 assert.deepStrictEqual(out,{title:"T",workspace:"/ws",instructions:"do it",trackedFiles:["a.txt","b.txt"],maxRevisions:3,collectExperience:false,builtinDefinition:"blog",skipCompleted:false});
 assert.deepStrictEqual(Object.keys(out),["title","workspace","instructions","trackedFiles","maxRevisions","collectExperience","builtinDefinition","skipCompleted"]);
});

test("createRunInput with a definition file and every optional field keeps the payload order",()=>{
 const out=createRunInput(form({...base,guideFile:"guide.md",skipCompleted:"on",projectId:"p1"}),{usesDefinition:true,builtinDefinition:"",definitionFile:"def.json"});
 assert.deepStrictEqual(out,{title:"T",workspace:"/ws",instructions:"do it",trackedFiles:["a.txt","b.txt"],maxRevisions:3,collectExperience:false,definitionFile:"def.json",guideFile:"guide.md",skipCompleted:true,projectId:"p1"});
 assert.deepStrictEqual(Object.keys(out),["title","workspace","instructions","trackedFiles","maxRevisions","collectExperience","definitionFile","guideFile","skipCompleted","projectId"]);
});

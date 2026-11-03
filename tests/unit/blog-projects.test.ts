import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readBlogProjects} from '../../src/desktop/blog-projects';

test('blog registry requires unique explicit projects and absolute source paths',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'blog-projects-'));
  const file=path.join(root,'blog-projects.json');
  const config={format:'markup',canon:'/a/article.md',layers:'/a/layers',layout:'/a/layout.html',media:'/a/media'};
  const project={id:'a',title:'Article A',config};
  try{
    assert.deepEqual(await readBlogProjects(root),[]);
    const save=async(projects:unknown[])=>writeFile(file,JSON.stringify({version:1,projects}));
    await save([project]);assert.deepEqual(await readBlogProjects(root),[project]);
    await save([project,{...project,id:'b'}]);await assert.rejects(readBlogProjects(root),/중복/);
    await save([project,{...project,config:{...config,canon:'/b/article.md'}}]);await assert.rejects(readBlogProjects(root),/중복/);
    await save([{...project,config:{...config,canon:'relative.md'}}]);await assert.rejects(readBlogProjects(root),/절대 경로/);
    await writeFile(file,'invalid');await assert.rejects(readBlogProjects(root));
  }finally{await rm(root,{recursive:true,force:true});}
});

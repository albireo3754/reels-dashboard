import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm,symlink,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {layoutStyles} from '../../src/app/blog-editor/layout-styles';
import {markupFixture} from '../fixtures/markup-editor';
import {MarkupStore} from '../../src/app/blog-editor/markup-store';

test('local linked CSS preserves ordering, relative font paths and font allowlist',async()=>{
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'layout-styles-')));
  try{
    const config=await markupFixture(root);
    await mkdir(path.join(root,'styles'));
    await writeFile(path.join(root,'styles/body.css'),'@font-face{font-family:example;src:url("example.woff2")}article{color:red}');
    await writeFile(path.join(root,'styles/example.woff2'),'synthetic font');
    const layout='<link rel="stylesheet" href="styles/body.css"><style>article{color:blue}</style>';
    await writeFile(config.layout,layout);
    assert.match(await layoutStyles(layout,config.layout),/url\("styles\/example.woff2"\).*color:red[\s\S]*color:blue/);
    const store=new MarkupStore(config),doc=await store.load();
    assert.match(doc.fontCss!,/kind=font/);
    assert.equal(await store.asset('font','example.woff2'),path.join(root,'styles/example.woff2'));
    await assert.rejects(store.asset('font','unlisted.woff2'),/연결되지/);
    await writeFile(path.join(root,'styles/body.css'),'article{color:green}');
    assert.notEqual((await store.load()).frameVersion,doc.frameVersion);
    for(const href of ['../outside.css','https://example.org/style.css'])await assert.rejects(layoutStyles(`<link rel="stylesheet" href="${href}">`,config.layout),/로컬 파일/);
    await symlink(path.join(root,'styles/body.css'),path.join(root,'linked.css'));
    await assert.rejects(layoutStyles('<link rel="stylesheet" href="linked.css">',config.layout),/로컬 파일/);
  }finally{await rm(root,{recursive:true,force:true});}
});

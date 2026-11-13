import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmod,mkdir,mkdtemp,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {MarkupStore} from '../../src/app/blog-editor/markup-store';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readBlogProjects,scanBlogProjects} from '../../src/desktop/blog-projects';
import {markupFixture} from '../fixtures/markup-editor';
import {writeBlogCards} from '../fixtures/blog-cards';
import {relocateLayout,retitleLayout} from '../../src/shared/blog-layout';

const temp=async(t:import('node:test').TestContext)=>{
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'blog-projects-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return root;
};
const card=(id:string,documents:string[],extra:object={})=>({id,title:`${id} card`,date:'2026-11-12',stage:'editing',nextAction:'',publicURL:'',shared:false,
  resources:documents.map(p=>({role:'document',path:p,label:'doc'})),...extra});
const dashboard=(root:string,projects:object[])=>writeFile(path.join(root,'dashboard.json'),JSON.stringify({schemaVersion:1,updatedAt:'2026-11-12T00:00:00.000Z',projects}));

test('blog projects are the content cards whose document is a blog-markup manuscript',async t=>{
  const root=await temp(t),article=path.join(root,'a');await mkdir(article);
  const config=await markupFixture(article);
  await writeFile(path.join(root,'BLOG.md'),'# guidance');
  const plain=path.join(root,'plain.md');await writeFile(plain,'---\ntitle: x\n---\nplain');
  await dashboard(root,[card('reel',[plain]),card('none',[]),card('blog',[plain,config.canon,path.join(root,'missing.md')])]);
  const projects=await readBlogProjects(root);
  assert.deepEqual(projects,[{id:'blog',title:'blog card',published:false,config:{
    projectId:'blog',format:'markup',canon:config.canon,layers:config.layers,layout:config.layout,media:config.media,
    review:path.join(config.layers,'bundle-review.json'),requests:config.requests,reviewGuidance:[path.join(root,'BLOG.md')],
  }}]);
  assert.deepEqual(await readBlogProjects(path.join(root,'empty')),[]);
});

test('blog completion follows its channel and keeps stage-only completed cards available',async t=>{
  const root=await temp(t);
  const states=[
    {id:'draft',extra:{}},
    {id:'blog-live',extra:{publications:[{channel:'blog',status:'published',url:''},{channel:'naver-clip',status:'planned',url:''}]}},
    {id:'other-live',extra:{stage:'published',publications:[{channel:'naver-clip',status:'published',url:''}]}},
    {id:'blog-planned',extra:{stage:'published',publications:[{channel:'blog',status:'planned',url:''}]}},
    {id:'stage-only',extra:{stage:'published'}},
    {id:'no-channels',extra:{stage:'published',publications:[]}},
  ];
  const cards=[];
  for(const {id,extra} of states){
    const article=path.join(root,id);await mkdir(article);
    const config=await markupFixture(article);
    cards.push(card(id,[config.canon],extra));
  }
  await dashboard(root,cards);
  const {projects,issues}=await scanBlogProjects(root);
  assert.deepEqual(issues,[]);
  assert.deepEqual(projects.map(({id,published})=>({id,published})),[
    {id:'draft',published:false},
    {id:'blog-live',published:true},
    {id:'other-live',published:false},
    {id:'blog-planned',published:false},
    {id:'stage-only',published:true},
    {id:'no-channels',published:true},
  ]);
});

test('frontmatter editor paths override the folder conventions',async t=>{
  const root=await temp(t),article=path.join(root,'a');await mkdir(article);
  const config=await markupFixture(article);
  const elsewhere=path.join(root,'old-loop');
  const moved={...config,layout:path.join(elsewhere,'layout.html'),layers:path.join(elsewhere,'layers'),requests:path.join(article,'editor-requests'),
    review:path.join(elsewhere,'review.json'),mediaEvidence:path.join(elsewhere,'results.json'),reviewGuidance:[path.join(elsewhere,'GUIDE.md')]};
  await writeBlogCards(root,[{id:'old',title:'Old',config:moved}]);
  assert.match(await readFile(config.canon,'utf8'),/^editor: \{"layout":"\.\.\/old-loop\/layout.html"/m);
  const [project]=await readBlogProjects(root);
  const {port:_,...expected}=moved;
  assert.deepEqual(project.config,{...expected,projectId:"old"});
});

test('cards that cannot be opened are reported, not listed',async t=>{
  const root=await temp(t);
  const [a,b]=await Promise.all(['a','b'].map(async id=>{const dir=path.join(root,id);await mkdir(dir);return markupFixture(dir);}));
  const noMedia=path.join(root,'no-media.md');await writeFile(noMedia,'---\nmarkup: 1\ntitle: x\n---\n');
  const badEditor=path.join(root,'bad.md');await writeFile(badEditor,'---\nmarkup: 1\nmedia: ./\neditor: {unknown: x}\n---\n');
  await dashboard(root,[card('two',[a.canon,b.canon]),card('first',[a.canon]),card('dup',[a.canon]),card('nomedia',[noMedia]),card('bad',[badEditor])]);
  const {projects,issues}=await scanBlogProjects(root);
  assert.deepEqual(projects.map(p=>p.id),['first']);
  assert.deepEqual(issues.map(i=>i.id),['two','dup','nomedia','bad']);
  assert.match(issues[0].reason,/여러 개/);assert.match(issues[1].reason,/first/);assert.match(issues[2].reason,/media/);assert.match(issues[3].reason,/editor/);
});

test('one unreadable or broken document reports its card and leaves the others listed',async t=>{
  const root=await temp(t),article=path.join(root,'a');await mkdir(article);
  const config=await markupFixture(article);
  const locked=path.join(root,'locked.md');await writeFile(locked,'---\nmarkup: 1\n---\n');await chmod(locked,0);
  t.after(()=>chmod(locked,0o600).catch(()=>{}));
  const broken=path.join(root,'broken.md');await writeFile(broken,'---\nmarkup: 1\nmedia: [\n---\n');
  await dashboard(root,[card('locked',[locked]),card('broken',[broken]),card('ok',[config.canon])]);
  const {projects,issues}=await scanBlogProjects(root);
  assert.deepEqual(projects.map(p=>p.id),['ok']);
  assert.deepEqual(issues.map(i=>i.id),['locked','broken']);
  assert.match(issues[1].reason,/YAML/);
});

test('a card naming the manuscript through a linked folder opens at its real path',async t=>{
  const root=await temp(t),article=path.join(root,'a');await mkdir(article);
  const config=await markupFixture(article);
  await symlink(article,path.join(root,'alias'));
  await dashboard(root,[card('linked',[path.join(root,'alias','article.md')]),card('same',[config.canon])]);
  const {projects,issues}=await scanBlogProjects(root);
  assert.equal(projects[0].config.canon,config.canon);
  assert.match(issues[0].reason,/linked/);
  assert.ok((await new MarkupStore(projects[0].config).load()).paragraphs.length>0);
});

test('a broken evidence pointer leaves the project listed without the photo picker',async t=>{
  const root=await temp(t),article=path.join(root,'a');await mkdir(article);
  const config=await markupFixture(article);
  await mkdir(config.layers,{recursive:true});await writeFile(path.join(config.layers,'media-evidence.json'),'{oops');
  await writeBlogCards(root,[{id:'p',title:'P',config}]);
  const [project]=await readBlogProjects(root);
  assert.equal(project.config.mediaEvidence,undefined);
});

test('linked media behind referenced photos and videos become allowed asset files',async t=>{
  const root=await temp(t),article=path.join(root,'a');await mkdir(article);
  const config=await markupFixture(article);
  const store=path.join(root,'library');await mkdir(store);
  for(const name of ['real.jpg','clip.mp4','poster.jpg','unused.jpg'])await writeFile(path.join(store,name),name);
  for(const name of ['real.jpg','clip.mp4','poster.jpg','unused.jpg'])await symlink(path.join(store,name),path.join(config.media,name));
  const text=(await readFile(config.canon,'utf8')).replace('<Photo file="photo.png" alt="Example photo"/>','<Photo file="photo.png" alt="Example photo"/>\n<Photo file="real.jpg" alt="Linked"/>\n<Video file="clip.mp4" poster="poster.jpg" alt="Clip"/>');
  await writeFile(config.canon,text);
  await writeBlogCards(root,[{id:'p',title:'P',config}]);
  const [project]=await readBlogProjects(root);
  assert.deepEqual(project.config.assetFiles,['clip.mp4','poster.jpg','real.jpg'].map(n=>path.join(store,n)));
});

test('render helpers retitle the page heading and keep relative urls when a layout is copied',()=>{
  const html='<html><head><title>Old</title><style>@font-face{src:url(../fonts/a.woff2)}b{background:url("https://x/y.png")}</style></head><body><header><h1 class="t">Old</h1></header><article><h1>Inside</h1></article></body></html>';
  const retitled=retitleLayout(html,'New & <b>');
  assert.match(retitled,/<title>New &amp; &lt;b&gt;<\/title>/);
  assert.match(retitled,/<h1 class="t">New &amp; &lt;b&gt;<\/h1>/);
  assert.match(retitled,/<article><h1>Inside<\/h1>/);
  const moved=relocateLayout(html,'/v/research/one/publishing/layout.html','/v/research/two/deeper/publishing/layout.html');
  assert.match(moved,/url\(\.\.\/\.\.\/\.\.\/one\/fonts\/a\.woff2\)/);
  assert.match(moved,/url\("https:\/\/x\/y\.png"\)/);
});

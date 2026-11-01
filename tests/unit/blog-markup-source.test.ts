import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse, serialize } from "../../src/shared/blog-markup";
import { textOf, classify, bundleHashes, reviewFresh, merge3, normalize } from "../../src/shared/blog-markup-source";
import { load, save } from "../../src/shared/blog-markup-store";
import { renderHtml } from "../../src/shared/blog-markup-render";
const source = '<Bundle id="B1" name="test" question="q">\n\n¶ P1\n⟦alpha⟧^1  \nbeta\ngamma\n  ^1 적갈 · focus\n</Bundle>\n';
test("normalization preserves text whitespace, YAML comments/order, omits derived notes",()=>{
  const raw='---\n# keep\ntitle: "Title" # title comment\nmarkup: 1\ncustom: [a, b]\n---\n'+source;
  const doc=parse(raw);doc.metadata!.title="Changed";
  const out=serialize(doc);
  assert.match(out,/# keep/);assert.match(out,/# title comment/);
  assert.ok(out.indexOf("title:")<out.indexOf("markup:"));
  assert.match(out,/⟧¹  \n/);assert.equal(normalize(out),out);
  assert.deepEqual(textOf(doc),["Changed","alpha  ","beta","gamma"]);
});
test("classification and axis-specific freshness",()=>{
  const before=parse(source), format=parse(source.replace("적갈","갈색"));
  assert.equal(classify(before,before).document,"none");
  assert.equal(classify(before,format).paragraphs.P1,"format");
  assert.equal(classify(before,parse(source.replace("beta","different"))).document,"text");
  assert.equal(classify(before,parse(source.replace('name="test"','name="other"'))).document,"structure");
  const a=bundleHashes(before).B1,z=bundleHashes(format).B1;
  assert.equal(a.textHash,z.textHash);assert.notEqual(a.fullHash,z.fullHash);
  assert.equal(reviewFresh("말투",a,z),true);assert.equal(reviewFresh("강조",a,z),false);
});
test("3-way handles independent, identical, adjacent, conflicting and normalized edits",()=>{
  const m=source.replace("alpha","ALPHA"),c=source.replace("gamma","GAMMA");
  const result=merge3(source,m,c);assert.ok(result.ok);assert.match(result.text,/ALPHA/);assert.match(result.text,/GAMMA/);
  assert.equal(merge3(source,m,m).ok,true);
  assert.equal(merge3(source,m,source.replace("alpha","other")).ok,false);
  assert.equal(merge3(source,normalize(source),c).ok,true);
  const adjacent=merge3(source,source.replace("beta","B"),source.replace("gamma","C"));assert.ok(adjacent.ok);
  const duplicate=merge3(source,source.replace("beta","⟦beta⟧²").replace("  ^1","  ² 굵게 · b\n  ^1"),source.replace("gamma","⟦gamma⟧²").replace("</Bundle>","  ² 굵게 · g\n</Bundle>"));
  assert.equal(duplicate.ok,false);
  assert.equal(merge3(source,source+"invalid",source).ok,false);
});
test("store guards agent text, preserves concurrent user edits, locking/history/external changes",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"markup-"));const file=path.join(dir,"draft.md");
  try{
    await writeFile(file,normalize(source));const base=await load(file);
    await assert.rejects(save(file,source.replace("beta","bad"),base,{actor:"agent"}),/TEXT_GUARD/);
    assert.equal(await readFile(file,"utf8"),base.text);
    await writeFile(file,normalize(source.replace("gamma","user changed")));
    const result=await save(file,source.replace("적갈","갈색"),base,{actor:"agent"});assert.ok(result.ok);
    assert.match(await readFile(file,"utf8"),/user changed/);
    assert.deepEqual((await load(file)).warnings,[]);
    assert.equal((await readdir(path.join(dir,".history","draft.md"))).length,2);
    await writeFile(file+".lock","");
    await assert.rejects(save(file,source,base,{actor:"user"}),/BUSY/);
    await rm(file+".lock");
    await writeFile(file,base.text);assert.equal((await load(file)).warnings.length,1);
    const invalid=await save(file,source.replace("적갈","up20"),await load(file),{actor:"user"});assert.equal(invalid.ok,false);
    const conflictBase=await load(file);await writeFile(file,source.replace("beta","disk"));
    const conflict=await save(file,source.replace("beta","mine"),conflictBase,{actor:"user"});assert.equal(conflict.ok,false);
    assert.match(await readFile(file,"utf8"),/disk/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("renderer snapshot, escaping, media paths, component structure",()=>{
  assert.equal(renderHtml(parse(source)), '<article><p data-bundle="B1" data-bundle-start data-bundle-name="test" class="paragraph"><span style="color: #a64132;">alpha</span>  <br>beta<br>gamma</p></article>');
  const doc=parse('<Bundle id="b" name="n" question="q">\n<Photo file="a.jpg" alt="&quot;x&quot;"/>\n<Heading>&lt;caption&gt;</Heading>\n<Map place="x" href="javascript:alert(1)"/>\n</Bundle>');
  const html=renderHtml(doc,{media:"../media/"});assert.match(html,/src="..\/media\/a.jpg"/);assert.ok(!html.includes("javascript:"));assert.ok(html.includes('class="section-heading"'));
});
test("layout reorder is structural and preserves agent wording guard",async()=>{
  const first='<Bundle id="b" name="n" question="q">\n\n¶ P1\nfirst\n\n¶ P2\nsecond\n</Bundle>\n';
  const reordered='<Bundle id="b" name="n" question="q">\n\n¶ P2\nsecond\n\n¶ P1\nfirst\n</Bundle>\n';
  assert.equal(classify(parse(first),parse(reordered)).document,"structure");
  const dir=await mkdtemp(path.join(os.tmpdir(),"markup-reorder-")),file=path.join(dir,"draft.md");
  try{
    await writeFile(file,first);
    assert.equal((await save(file,reordered,await load(file),{actor:"agent"})).ok,true);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("renderer preserves valid external links and rejects script URLs",()=>{
  const doc=parse('<Bundle id="b" name="n" question="q">\n<Map place="Example" href="https://example.com/place/1"/>\n</Bundle>');
  assert.match(renderHtml(doc),/href="https:\/\/example.com\/place\/1"/);
});

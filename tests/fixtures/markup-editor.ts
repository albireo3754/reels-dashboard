import {mkdir,writeFile,realpath} from "node:fs/promises";
import path from "node:path";
export async function markupFixture(root:string){
  root=await realpath(root);
  const media=path.join(root,"media");await mkdir(media,{recursive:true});
  await writeFile(path.join(media,"photo.png"),Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDZkAAAAASUVORK5CYII=","base64"));
  const canon=path.join(root,"article.md"),layout=path.join(root,"publishing","smarteditor-draft-layout.html"),layers=path.join(root,"reviews");
  await mkdir(path.dirname(layout),{recursive:true});
  await writeFile(canon,'---\ntitle: "Example article"\nmarkup: 1\nmedia: ./media/\nnotes: article.notes.md\nstyle: {bodyPx: 16, mobileBodyPx: 17}\n---\n\n<Bundle id="B1" name="First" question="why">\n<Photo file="photo.png" alt="Example photo"/>\n\n¶ P1\n⟦First⟧¹ line\n  ¹ 적갈 up19 · main\n\n¶ P2\nSecond line\n</Bundle>\n');
  await writeFile(path.join(root,"article.notes.md"),"## 규칙\nKeep facts.\n\n## 이력\nPrivate history.\n");
  await writeFile(layout,'<!doctype html><html><head><style>article{font:16px/1.8 sans-serif}.photo-block img{width:100px}main{max-width:800px;margin:auto}</style></head><body><article></article></body></html>');
  // The manuscript folder follows the blog-project conventions (src/desktop/blog-projects.ts).
  return {format:"markup" as const,canon,layout,media,layers,requests:path.join(layers,"requests"),port:0};
}

import { sha256Hex } from '../shared/lib/hash';
import { lstat, mkdir, open, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { blogDraft, type BlogDraft } from '../shared/blog';
import { ContentLibrary } from '../features/content-library';
import { LocalStore } from '../shared/lib/storage';
const hash = sha256Hex;
export class BlogLibrary {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private store:LocalStore, private library:ContentLibrary) {}
  private file(id:string) {return path.join(this.store.root,'blog-drafts',hash(id)+'.json');}
  async readDocument(projectId:string, documentPath:string) {
    z.string().min(1).max(160).parse(projectId); z.string().startsWith('/').max(4096).parse(documentPath);
    const {project} = await this.library.get(projectId);
    if (!project.resources?.some(r => r.role === 'document' && r.path === documentPath) || !/\.md$/i.test(documentPath)) throw new Error('연결된 Markdown 문서를 선택해주세요.');
    if (path.resolve(documentPath)!==documentPath || await realpath(documentPath)!==documentPath || (await lstat(documentPath)).isSymbolicLink()) throw new Error('문서 경로가 변경됐어요. 다시 연결해주세요.');
    const handle=await open(documentPath,'r');
    try {const info=await handle.stat(); if(!info.isFile() || info.size>2*1024*1024) throw new Error('2MB 이하의 문서를 선택해주세요.'); const content=await handle.readFile(); return {text:content.toString('utf8'),fingerprint:hash(content.toString('base64'))};} finally {await handle.close();}
  }
  async load(projectId:string):Promise<BlogDraft> {
    z.string().min(1).max(160).parse(projectId); await this.library.get(projectId);
    try {const result=blogDraft.parse(JSON.parse(await readFile(this.file(projectId),'utf8'))); if(result.projectId!==projectId) throw new Error('프로젝트가 일치하지 않아요.'); return result;}
    catch(e) {if((e as NodeJS.ErrnoException).code==='ENOENT') return {projectId,revision:0,blocks:[]}; throw e;}
  }
  async save(value:unknown) {
    const input=blogDraft.parse(value);
    const work=this.queue.then(async()=>{
      const file=this.file(input.projectId); await mkdir(path.dirname(file),{recursive:true,mode:0o700});
      const lock=file+'.lock';
      try {await writeFile(lock,String(process.pid),{flag:'wx',mode:0o600});} catch(e) {if((e as NodeJS.ErrnoException).code==='EEXIST') throw new Error('BLOG_BUSY: 다른 저장이 진행 중이거나 중단된 잠금이 남았어요.');throw e;}
      try {
        const current=await this.load(input.projectId);
        if(current.revision!==input.revision) throw new Error('STALE_BLOG: 다른 곳에서 변경했어요. 다시 불러와주세요.');
        for(const block of input.blocks) if(block.type==='image') {const media=await this.library.resolveMedia(input.projectId,block.path); if(!media.info.isFile() || !/\.(jpe?g|png|webp|heic)$/i.test(block.path)) throw new Error('연결된 사진을 선택해주세요.');}
        const result={...input,revision:input.revision+1};
        await this.store.atomic(file,result); return result;
      } finally {await unlink(lock); }
    });
    this.queue=work.catch(()=>{}); return work;
  }
}

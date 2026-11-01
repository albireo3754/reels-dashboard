import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReferences,blockLink,blockKind} from '../../src/features/blog-workspace/model/references';
const rect={x:0,y:-300,width:600,height:200};
const block={order:0,id:'',anchorId:'group-child',className:'se-component se-imageGroup se-l-collage',rect,css:{},paragraphs:[],images:[]};
const ref={name:'fixture',url:'https://blog.naver.com/fixture/1',pageUrl:'https://blog.naver.com/PostView.naver?blogId=fixture&logNo=1',width:600,blocks:[block]};
test('reference markdown preserves group child anchor and negative viewport coordinate',()=>{const [r]=parseReferences('```json\n'+JSON.stringify([ref])+'\n```');assert.equal(blockKind(r.blocks[0]),'이미지 그룹');assert.equal(new URL(blockLink(r,r.blocks[0])!).hash,'#group-child');assert.equal(r.blocks[0].rect.y,-300)});
test('unanchored selection has no navigation target, not a page-top URL',()=>{const [r]=parseReferences(JSON.stringify([ref]));assert.equal(blockLink(r,{...r.blocks[0],anchorId:null,id:''}),null);assert.equal(new URL(blockLink(r,{...r.blocks[0],anchorId:null,id:'text-id'})!).hash,'#text-id')});
test('untrusted reference URLs and broken payloads are rejected',()=>{for(const pageUrl of ['javascript:alert(1)','https://blog.naver.com.evil.test/post','file:///etc/passwd','https://user:pass@blog.naver.com/a'])assert.throws(()=>parseReferences(JSON.stringify([{...ref,pageUrl}])));assert.throws(()=>parseReferences('[null]'));assert.throws(()=>parseReferences('[]'));});

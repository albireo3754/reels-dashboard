import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error dependency-free Node SDK
import {InstagramInsightsClient,instagramShortcode} from '../../packages/instagram-insights/index.mjs';
const response=(data:unknown,status=200)=>Response.json(data,{status});
test('verifies expected owner, resolves permalink from owned media and sends credentials only in header',async()=>{
 const calls:string[]=[];
 const client=new InstagramInsightsClient({accessToken:'fixture-private-token',fetchImpl:async(url:URL,init:RequestInit)=>{
  calls.push(url.toString());assert.ok(!url.toString().includes('fixture-private-token'));assert.equal((init.headers as Record<string,string>).Authorization,'Bearer fixture-private-token');assert.equal(init.redirect,'error');
  if(url.pathname.endsWith('/me'))return response({data:[{user_id:'17841400000000001',username:'rosy_trip2'}]});
  if(url.pathname.endsWith('/media'))return response({data:[{id:'18000000000000001',permalink:'https://www.instagram.com/p/Example01/',media_product_type:'REELS'}]});
  return response({data:[{name:url.searchParams.get('metric'),period:'lifetime',values:[{value:0}]}]});
 }});
 const result=await client.inspectPermalink('https://www.instagram.com/rosy_trip2/reel/Example01/');assert.equal(result.insights.mediaId,'18000000000000001');assert.equal(result.insights.metrics[0].status,'available');assert.equal(result.insights.metrics[0].value,0);assert.equal(calls.length,8);
});
test('wrong account is rejected before requesting media',async()=>{
 let calls=0;const client=new InstagramInsightsClient({accessToken:'fixture',fetchImpl:async()=>{calls++;return response({user_id:'123',username:'someone_else'});}});await assert.rejects(client.inspectPermalink('https://www.instagram.com/reel/Example01/'),/ACCOUNT_MISMATCH/);assert.equal(calls,1);
});
test('missing metrics and denied metrics are not turned into zero and errors redact server messages',async()=>{
 const client=new InstagramInsightsClient({accessToken:'secret',fetchImpl:async(url:URL)=>url.searchParams.get('metric')==='views'?response({data:[]}):response({error:{code:200,message:'secret echo'}},400)});
 const r=await client.insights({id:'123',permalink:'https://www.instagram.com/reel/Example01/'},['views','saved']);assert.equal(r.metrics[0].status,'unavailable');assert.equal(r.metrics[0].value,null);assert.equal(r.metrics[1].status,'permission_denied');assert.ok(!JSON.stringify(r).includes('secret'));
});
test('permalink and pagination do not allow arbitrary origins or credential-bearing next URLs',async()=>{
 assert.throws(()=>instagramShortcode('https://evil.example/reel/abc/'));
 let count=0;const urls:string[]=[];const client=new InstagramInsightsClient({accessToken:'fixture',fetchImpl:async(url:URL)=>{urls.push(url.toString());count++;return count===1?response({data:[],paging:{next:'https://evil.example/?access_token=leak',cursors:{after:'cursor'}}}):response({data:[]});}});
 await client.media({userId:'123',username:'rosy_trip2'});assert.equal(urls.length,2);assert.ok(urls.every(u=>u.startsWith('https://graph.instagram.com/')));assert.ok(urls[1].includes('after=cursor'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {InstagramInsightsClient,instagramShortcode} from '../../packages/instagram-insights/index.mjs';
const response=(data:unknown,status=200)=>Response.json(data,{status});
test('verifies expected owner, resolves permalink from owned media and sends credentials only in header',async()=>{
 const calls:string[]=[];
 const client=new InstagramInsightsClient({expectedUsername:'creator_demo',accessToken:'fixture-private-token',fetchImpl:async(url:URL,init:RequestInit)=>{
  calls.push(url.toString());assert.ok(!url.toString().includes('fixture-private-token'));assert.equal((init.headers as Record<string,string>).Authorization,'Bearer fixture-private-token');assert.equal(init.redirect,'error');
  if(url.pathname.endsWith('/me'))return response({data:[{user_id:'17841400000000001',username:'creator_demo'}]});
  if(url.pathname.endsWith('/media'))return response({data:[{id:'18000000000000001',permalink:'https://www.instagram.com/p/Example01/',media_product_type:'REELS',media_type:'VIDEO',timestamp:'2026-10-01T10:00:00+0000'}]});
  return response({data:url.searchParams.get('metric')!.split(',').map(name=>({name,period:'lifetime',values:[{value:0}]}))});
 }});
 const result=await client.inspectPermalink('https://www.instagram.com/creator_demo/reel/Example01/');assert.equal(result.insights.mediaId,'18000000000000001');assert.equal(result.insights.metrics[0].status,'available');assert.equal(result.insights.metrics[0].value,0);assert.equal(calls.length,3);
});
test('wrong account is rejected before requesting media',async()=>{
 let calls=0;const client=new InstagramInsightsClient({expectedUsername:'creator_demo',accessToken:'fixture',fetchImpl:async()=>{calls++;return response({user_id:'123',username:'someone_else'});}});await assert.rejects(client.inspectPermalink('https://www.instagram.com/reel/Example01/'),/ACCOUNT_MISMATCH/);assert.equal(calls,1);
});
test('missing metrics and denied metrics are not turned into zero and errors redact server messages',async()=>{
 const client=new InstagramInsightsClient({expectedUsername:'creator_demo',accessToken:'secret',fetchImpl:async(url:URL)=>url.searchParams.get('metric')==='views'?response({data:[]}):response({error:{code:200,message:'secret echo'}},400)});
 const r=await client.insights({id:'123',permalink:'https://www.instagram.com/reel/Example01/'},['views','saved']);assert.equal(r.metrics[0].status,'unavailable');assert.equal(r.metrics[0].value,null);assert.equal(r.metrics[1].status,'permission_denied');assert.ok(!JSON.stringify(r).includes('secret'));
});
test('permalink and pagination do not allow arbitrary origins or credential-bearing next URLs',async()=>{
 assert.throws(()=>instagramShortcode('https://evil.example/reel/abc/'));
 let count=0;const urls:string[]=[];const client=new InstagramInsightsClient({expectedUsername:'creator_demo',accessToken:'fixture',fetchImpl:async(url:URL)=>{urls.push(url.toString());count++;return count===1?response({data:[],paging:{next:'https://evil.example/?access_token=leak',cursors:{after:'cursor'}}}):response({data:[]});}});
 await client.media({userId:'123',username:'creator_demo'});assert.equal(urls.length,2);assert.ok(urls.every(u=>u.startsWith('https://graph.instagram.com/')));assert.ok(urls[1].includes('after=cursor'));
});

/* Only a generic offline page is persisted; never cache private HTML, API, media or auth. */
const CACHE='rosy-briefing-offline-v2';
const OFFLINE='/offline';
self.addEventListener('install',event=>event.waitUntil((async()=>{
 const response=await fetch(OFFLINE,{cache:'reload'});
 if(!response.ok||response.redirected||new URL(response.url).pathname!==OFFLINE||!response.headers.get('content-type')?.includes('text/html'))throw new Error('Offline asset unavailable');
 const body=await response.clone().text();
 if(!body.includes('data-briefing-offline'))throw new Error('Unexpected offline response');
 await (await caches.open(CACHE)).put(OFFLINE,response);
 await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
 for(const key of await caches.keys())if(key.startsWith('rosy-briefing-offline-')&&key!==CACHE)await caches.delete(key);
 await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 if(event.request.method!=='GET'||event.request.mode!=='navigate'||url.origin!==self.location.origin||url.pathname!=='/')return;
 event.respondWith((async()=>{
  try{return await fetch(event.request);}catch{
   return (await caches.match(OFFLINE,{cacheName:CACHE}))??new Response('인터넷 연결 후 다시 열어주세요.',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
  }
 })());
});

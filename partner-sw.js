const version = 'printbee-partner-preview-v2';
const shell = ['/partner?preview=1','/partner.css','/partner.js','/studio.css?v=mobile-touch','/clay.css','/portal-login.js','/printbee-header-bee.webp','/partner.webmanifest','/partner-icon-192.png','/partner-icon-512.png','/printbee-tab-bee.png','/manrope-latin-400-normal.woff2','/manrope-latin-800-normal.woff2'];
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(version).then(cache=>cache.addAll(shell)));
});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('printbee-partner-preview-') && key!==version).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  const key=url.pathname+url.search;
  if(event.request.method!=='GET'||url.origin!==self.location.origin||!shell.includes(key)) return;
  event.respondWith(fetch(event.request).catch(async()=>{
    const cache=await caches.open(version);
    return (await cache.match(event.request)) || Response.error();
  }));
});

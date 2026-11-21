const version = 'printbee-partner-preview-v17-inbox-power';
const shell = ['/printbee-sleeping-bee.png','/partner?preview=1','/partner.css?v=sleeping-bee','/partner.js?v=inbox-power','/hive-theme.css?v=page-beige','/hive-theme.js?v=sun-moon','/portal-login.js','/staff-dock.css?v=inbox-power','/staff-dock.js?v=inbox-power','/warehouse-inter.woff2','/printbee-header-bee.webp','/partner.webmanifest','/partner-icon-192.png','/partner-icon-512.png','/printbee-tab-bee.png','/manrope-latin-400-normal.woff2','/manrope-latin-700-normal.woff2','/manrope-latin-800-normal.woff2'];
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

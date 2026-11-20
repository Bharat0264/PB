// Run with: node tools/test_theme_preferences.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const rootPath = path.resolve(__dirname, '..');
const storage = entries => {
  const values = new Map(entries);
  return {getItem:key=>values.get(key) ?? null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};
};
async function boot(email, local = storage([]), session = storage([])) {
  const root = {dataset:{},classList:{add(){}}};
  const document = {documentElement:root,readyState:'complete',head:{append(el){queueMicrotask(()=>el.onload?.());}},
    querySelector:()=>null,querySelectorAll:()=>[],createElement:()=>({dataset:{},remove(){}})};
  const ctx = {document,localStorage:local,sessionStorage:session,navigator:{},console,
    matchMedia:()=>({matches:true}),MutationObserver:class {observe(){}},addEventListener(){},
    setTimeout(){},fetch:async()=>({ok:true,json:async()=>({email})})};
  ctx.window=ctx;
  vm.createContext(ctx);
  for(const file of ['theme-registry.js','theme-engine.js'])vm.runInContext(fs.readFileSync(path.join(rootPath,file),'utf8'),ctx);
  assert.equal(root.dataset.pbTheme,'printbee','First paint must use the normal theme');
  await new Promise(resolve=>setImmediate(resolve));
  return ctx;
}
(async()=>{
  const legacy = storage([['printbee-theme','wildfire'],['printbee-admin-theme','dark']]);
  const guest = await boot(null,legacy);
  assert.equal(guest.PrintBeeThemes.current(),'printbee');
  assert.equal(guest.document.documentElement.dataset.theme,'light','Dark OS and legacy browser mode cannot affect a new guest');
  await guest.PrintBeeThemes.apply('wildfire');
  assert.equal(guest.sessionStorage.getItem('printbee-theme-guest'),'wildfire');
  await guest.PrintBeeThemes.resetGuest();
  assert.equal(guest.PrintBeeThemes.current(),'printbee');
  assert.equal(guest.document.documentElement.dataset.theme,'light');
  assert.equal(guest.sessionStorage.getItem('printbee-theme-guest'),null);
  const alice = await boot('alice@example.test',legacy);
  assert.equal(alice.PrintBeeThemes.current(),'printbee','New account must not inherit legacy choice');
  await alice.PrintBeeThemes.apply('wildfire');
  assert.equal(legacy.getItem('printbee-theme:alice%40example.test'),'wildfire');
  assert.equal((await boot('bob@example.test',legacy)).PrintBeeThemes.current(),'printbee','Different accounts must not share a theme');
  assert.equal((await boot('alice@example.test',legacy)).PrintBeeThemes.current(),'wildfire','Explicit signed-in choice should be restored');
  assert.equal((await boot(null,legacy)).PrintBeeThemes.current(),'printbee','Guests must not inherit a signed-in theme');
  const blocked={getItem(){throw Error('blocked')},setItem(){throw Error('blocked')},removeItem(){throw Error('blocked')}};
  assert.equal((await boot(null,blocked,blocked)).PrintBeeThemes.current(),'printbee');
  console.log('Theme defaults, guest reset, account isolation and blocked storage passed.');
})().catch(error=>{console.error(error);process.exitCode=1});

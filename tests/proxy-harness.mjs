// Exercises api/[...path].js (the Vercel proxy) against a real PrintBee server.
// Run through test_vercel_proxy.py, or:  node tests/proxy-harness.mjs
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import net from 'node:net';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const freePort = () => new Promise(done => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => done(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (ok, name, detail = '') => { console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : '  ' + detail)); if (!ok) failures++; };

const handler = require(join(root, 'api', '[...path].js'));
const proxyPort = await freePort(), backendPort = await freePort();
const origin = `http://127.0.0.1:${proxyPort}`;

// 1. Not configured: a clear JSON 503, never a crash.
delete process.env.PRINTBEE_BACKEND_URL;
const web = createServer((req, res) => (req.url.startsWith('/api/') ? handler(req, res) : (res.statusCode = 404, res.end())));
await new Promise(r => web.listen(proxyPort, '127.0.0.1', r));
let r = await fetch(origin + '/api/status-model');
check(r.status === 503 && (await r.json()).error.includes('PRINTBEE_BACKEND_URL'), 'unconfigured proxy answers 503 with a clear message');

// 2. Real backend behind the proxy (demo mode needs test payments and a local origin).
const dir = mkdtempSync(join(tmpdir(), 'printbee-proxy-'));
const server = spawn('python', [join(root, 'server.py'), '--port', String(backendPort)], {
  cwd: root, stdio: 'ignore',
  env: {...process.env, PRINTBEE_ORIGIN: origin, PRINTBEE_DEMO: '1', PRINTBEE_PAYMENT_MODE: 'test', PRINTBEE_DATA_DIR: dir},
});
process.env.PRINTBEE_BACKEND_URL = `http://127.0.0.1:${backendPort}/`;
for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${backendPort}/api/status-model`)).ok) break; } catch {} await sleep(250); }

try {
  r = await fetch(origin + '/api/status-model');
  const model = await r.json();
  check(r.status === 200 && model.statuses.packed.label === 'Ready for pickup', 'GET passes through (status model)');

  // 3. Signing in routes each role to its own portal, and the cookie survives the proxy.
  const cookies = {};
  for (const [role, destination] of [['customer', '/index.html'], ['warehouse', '/warehouse'], ['partner', '/partner'], ['admin', '/admin'], ['all', '/admin']]) {
    r = await fetch(`${origin}/api/dev/login?role=${role}`, {redirect: 'manual'});
    const jar = r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    check(r.status === 303 && r.headers.get('location') === destination && jar.length > 20, `sign in as ${role} -> ${destination}`, `${r.status} ${r.headers.get('location')}`);
    cookies[role] = jar;
  }
  r = await fetch(origin + '/api/auth/me', {headers: {Cookie: cookies.admin}});
  const me = await r.json();
  check(me.current === 'admin' && me.roles.includes('admin'), 'session cookie works through the proxy (admin is signed in)');
  r = await fetch(origin + '/api/admin', {headers: {Cookie: cookies.admin}});
  check(r.status === 200 && 'finance' in await r.json(), 'admin data is available to the admin session');
  r = await fetch(origin + '/api/admin');
  check(r.status === 403, 'admin data is refused without a session');
  r = await fetch(origin + '/api/admin', {headers: {Cookie: cookies.warehouse}});
  check(r.status === 403, 'admin data is refused to a warehouse session');

  // 4. POST bodies and the Origin check pass through (switch portal, then a 120 KB upload).
  r = await fetch(origin + '/api/auth/switch', {method: 'POST', headers: {'Content-Type': 'application/json', Origin: origin, Cookie: cookies.all}, body: JSON.stringify({portal: 'warehouse'})});
  check(r.status === 200 && (await r.json()).path === '/warehouse' && r.headers.getSetCookie().length === 1, 'POST + Origin + Set-Cookie (switch portal)');
  r = await fetch(origin + '/api/auth/switch', {method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'https://evil.example', Cookie: cookies.all}, body: JSON.stringify({portal: 'warehouse'})});
  check(r.status === 403, 'a foreign Origin is still refused by the backend');
  const big = Buffer.alloc(120_000, 7);
  r = await fetch(origin + '/api/checkout/pages?format=pdf', {method: 'POST', headers: {Origin: origin}, body: big});
  check([200, 400].includes(r.status) && (r.headers.get('content-type') || '').includes('json'), 'a 120 KB request body reaches the backend', String(r.status));

  // 5. The live feed streams through the proxy.
  const controller = new AbortController();
  r = await fetch(origin + '/api/events?as=warehouse', {headers: {Cookie: cookies.warehouse}, signal: controller.signal});
  const reader = r.body.getReader();
  const first = await Promise.race([reader.read(), sleep(5000).then(() => null)]);
  const text = first ? new TextDecoder().decode(first.value) : '';
  check(r.status === 200 && r.headers.get('content-type').includes('text/event-stream') && text.includes('event: hello'), 'live feed (SSE) streams through the proxy');
  controller.abort();
  r = await fetch(origin + '/api/events?as=admin', {headers: {Cookie: cookies.customer}});
  check(r.status === 403, 'live feed refuses the wrong role');

  // 6. Backend down: a clear 502.
  process.env.PRINTBEE_BACKEND_URL = 'http://127.0.0.1:1';
  r = await fetch(origin + '/api/status-model');
  check(r.status === 502 && (await r.json()).error.includes('could not be reached'), 'unreachable backend answers 502 with a clear message');
} finally {
  server.kill();
  web.close();
  await sleep(500);
  try { rmSync(dir, {recursive: true, force: true}); } catch { /* Windows may still hold the database file */ }
}
console.log(failures ? `${failures} FAILED` : 'ALL OK');
process.exit(failures ? 1 : 0);

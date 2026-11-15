/* Vercel serverless function: forwards every /api/* request to the PrintBee backend.
 *
 * Vercel hosts only the static site; the Python server (server.py, SQLite) runs elsewhere (see
 * DEPLOY-VERCEL.md). Set PRINTBEE_BACKEND_URL in the Vercel project (for example
 * https://printbee-api.example.com) and this function proxies sign-in, orders and the live feed,
 * so the browser only ever talks to the Vercel origin (cookies and the same-origin checks keep working).
 * On the backend, set PRINTBEE_ORIGIN to the Vercel site's URL.
 *
 * Limits of a serverless function: request bodies up to about 4.5 MB (large print files should go
 * straight to the backend host) and responses end after maxDuration; the live feed then reconnects
 * by itself and catches up from Last-Event-ID.
 */
const { Readable } = require('node:stream');

const SKIP_REQUEST = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'proxy-authorization', 'content-length', 'accept-encoding', 'x-vercel-id', 'x-vercel-forwarded-for']);
const SKIP_RESPONSE = new Set(['transfer-encoding', 'connection', 'keep-alive', 'content-encoding', 'content-length']);

function reply(res, status, error) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error }));
}

module.exports = async function proxy(req, res) {
  const backend = (process.env.PRINTBEE_BACKEND_URL || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(backend)) {
    return reply(res, 503, 'The PrintBee backend is not connected yet. Set PRINTBEE_BACKEND_URL for this Vercel project.');
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) if (!SKIP_REQUEST.has(name)) headers[name] = value;
  headers['x-forwarded-host'] = req.headers.host || '';
  headers['x-forwarded-proto'] = 'https';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);
  req.on('close', () => controller.abort());
  let upstream;
  try {
    upstream = await fetch(backend + req.url, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) || !body.length ? undefined : body,
      redirect: 'manual',            // sign-in answers 303s; the browser must follow them itself
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    return reply(res, 502, 'The PrintBee server could not be reached. Please try again shortly.');
  }

  res.statusCode = upstream.status;
  for (const [name, value] of upstream.headers) {
    if (!SKIP_RESPONSE.has(name) && name !== 'set-cookie') res.setHeader(name, value);
  }
  const cookies = upstream.headers.getSetCookie ? upstream.headers.getSetCookie() : [];
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  if (!upstream.body) {
    clearTimeout(timer);
    return res.end();
  }
  res.flushHeaders?.();
  const stream = Readable.fromWeb(upstream.body);
  stream.on('error', () => res.end());
  res.on('close', () => { clearTimeout(timer); controller.abort(); });
  stream.pipe(res);
};

module.exports.config = { api: { bodyParser: false } };

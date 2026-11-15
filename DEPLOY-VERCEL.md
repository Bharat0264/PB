# Deploying PrintBee on Vercel (pb-lake.vercel.app)

Vercel hosts the **website** (HTML, CSS, JS). The **backend** (`server.py` + SQLite: sign-in, orders,
warehouse, partners, admin) is a Python server that needs a disk, so it runs on a separate host. The site
calls it through the `/api/*` proxy in `api/[...path].js`, so the browser only ever talks to
`https://pb-lake.vercel.app`.

## What visitors see

1. Opening `https://pb-lake.vercel.app/` goes to the **sign-in page** (`/welcome.html`).
2. They sign in (Google, or an email link for customers). The server decides where they land:
   * email in `PRINTBEE_GOOGLE_ADMIN_EMAILS` → **/admin**
   * email in `PRINTBEE_GOOGLE_WAREHOUSE_EMAILS` → **/warehouse**
   * email in `PRINTBEE_GOOGLE_PARTNERS` (or an enrolled phone) → **/partner**
   * anyone else → the customer app
3. Someone with several roles gets a **Switch portal** menu inside each portal.
4. Opening `/admin`, `/warehouse` or `/partner` while signed out shows only a sign-in card, never data.
5. If the backend is not connected, the sign-in page says so instead of showing dead buttons.

## Make sign-in work: four steps

1. **Host the backend** (Docker, see the `Dockerfile` and README) on any HTTPS host with a persistent
   volume. Note its public URL, for example `https://printbee-api.example.com`.
2. **Backend environment** (never commit these):

   ```
   PRINTBEE_ORIGIN=https://pb-lake.vercel.app          # the Vercel site, not the backend's own URL
   PRINTBEE_GOOGLE_CLIENT_ID=...
   PRINTBEE_GOOGLE_CLIENT_SECRET=...
   PRINTBEE_GOOGLE_ADMIN_EMAILS=you@gmail.com
   PRINTBEE_GOOGLE_WAREHOUSE_EMAILS=staff@gmail.com
   PRINTBEE_GOOGLE_PARTNERS={"rider@gmail.com":"rider-1"}
   PRINTBEE_PAYMENT_MODE=razorpay                      # or disabled
   ```
3. **Google Cloud console** → OAuth client → add the authorised redirect URI
   `https://pb-lake.vercel.app/api/auth/google/callback`.
4. **Vercel** → Project → Settings → Environment Variables: `PRINTBEE_BACKEND_URL=https://printbee-api.example.com`,
   then redeploy.

Verify: `https://pb-lake.vercel.app/api/status-model` returns JSON (not a 404 or 503).

## Limits to know

* A Vercel function accepts request bodies up to about **4.5 MB**. Print files can be up to 50 MB. If customers
  upload larger files, replace the function with an edge rewrite: delete `api/[...path].js` and add to
  `vercel.json` `rewrites`: `{"source": "/api/:path*", "destination": "https://printbee-api.example.com/api/:path*"}`.
* The live feed (SSE) through a function ends after 60 seconds; the browser reconnects and catches up by itself,
  and falls back to polling if needed.
* Only the website is deployed to Vercel (`.vercelignore` keeps `*.py`, tests and docs out of the public site).
* `localhost` demo mode (`python demo.py`) is refused on any non-local origin.

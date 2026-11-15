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

## Fly.io walkthrough (step 1 in detail)

Config is in `fly.toml`; the image is the repo's `Dockerfile` (it fixes the data volume's ownership on start,
because Fly mounts volumes as root). You need a Fly.io account with a card on file. Run these in PowerShell
inside the repo folder.

1. Install and sign in:

       iwr https://fly.io/install.ps1 -useb | iex
       fly auth login

2. Pick a unique app name (Fly names are global) and create the app without deploying yet:

       fly launch --no-deploy --copy-config --name printbee-yourname --region bom

   Make sure `app = "printbee-yourname"` in `fly.toml` matches.
3. Create the 1 GB volume that holds the database and staff keys (keep exactly one machine; SQLite is one file):

       fly volumes create printbee_data --size 1 --region bom

4. Put your secrets in a file **outside git**, for example `C:\secure\printbee.env`, one `NAME=value` per line:

       PRINTBEE_GOOGLE_CLIENT_ID=...
       PRINTBEE_GOOGLE_CLIENT_SECRET=...
       PRINTBEE_GOOGLE_ADMIN_EMAILS=you@gmail.com
       PRINTBEE_GOOGLE_WAREHOUSE_EMAILS=staff@gmail.com
       PRINTBEE_GOOGLE_PARTNERS={"rider@gmail.com":"rider-1"}

   then load them and deploy:

       fly secrets import < C:\secure\printbee.env
       fly deploy

5. Check `https://printbee-yourname.fly.dev/api/status-model` returns JSON.
6. In Vercel set `PRINTBEE_BACKEND_URL=https://printbee-yourname.fly.dev` and redeploy.
7. Google Cloud console → APIs & Services → Credentials → *Create credentials* → *OAuth client ID* → *Web application*,
   authorised redirect URI `https://pb-lake.vercel.app/api/auth/google/callback`. Copy the client ID and secret
   into the secrets file above (then `fly secrets import` again).

Warehouse print agent (on the print room PC): get its key with
`fly ssh console -C "python server.py --show-staff-keys"`, then run
`set PRINTBEE_PRINT_AGENT_KEY=<print-agent key>` and
`python print_agent.py --origin https://printbee-yourname.fly.dev --printer "<printer name>" --sumatra "<path to SumatraPDF.exe>"`.
Use `--mock-printer` instead of `--printer` for a dry run.

Not yet verified: the Docker image build (Docker was not running where this was written) and a real Fly deploy.

## Limits to know

* A Vercel function accepts request bodies up to about **4.5 MB**. Print files can be up to 50 MB. If customers
  upload larger files, replace the function with an edge rewrite: delete `api/[...path].js` and add to
  `vercel.json` `rewrites`: `{"source": "/api/:path*", "destination": "https://printbee-api.example.com/api/:path*"}`.
* The live feed (SSE) through a function ends after 60 seconds; the browser reconnects and catches up by itself,
  and falls back to polling if needed.
* Only the website is deployed to Vercel (`.vercelignore` keeps `*.py`, tests and docs out of the public site).
* `localhost` demo mode (`python demo.py`) is refused on any non-local origin.

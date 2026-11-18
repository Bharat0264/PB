# Deploy PrintBee on Render (lowest cost: about $7 to $8 a month plus your domain)

One Render service runs the whole site: the pages, the API and the SQLite database on a small disk.
No separate frontend host is needed, so there is no upload-size limit and no second bill. This handles a few hundred people
online at the same time, which is plenty for a 10,000-customer base. If it ever feels slow at peak
hours, switch the plan from Starter to Standard (about $25) in the Render dashboard.

## Steps

1. **Render account** (render.com) → *New* → *Blueprint* → connect GitHub → pick the `PB` repo.
   Render reads `render.yaml`, creates the service and a 1 GB disk, and asks for these values:
   * `PRINTBEE_ORIGIN` = your site address, for example `https://printbee.co.in`
   * `PRINTBEE_GOOGLE_CLIENT_ID` and `PRINTBEE_GOOGLE_CLIENT_SECRET` (step 3)
   * `PRINTBEE_GOOGLE_ADMIN_EMAILS` = your admin Gmail (opens `/admin`). **This is the only access list you keep in the environment.**
   * Delivery partners and warehouses are added by the admin inside the app: open `/admin`, go to *Delivery Partners* →
     *Add verified partner*, or *Warehouses* → *Add warehouse* (the staff email you enter there can sign in to `/warehouse`).
     Access is saved in the database, so no environment change or redeploy is needed.
   * `PRINTBEE_GOOGLE_WAREHOUSE_EMAILS` and `PRINTBEE_GOOGLE_PARTNERS` are optional now. Anything already set keeps working.
2. **Your domain**: Render → the service → *Settings* → *Custom Domains* → add `printbee.co.in` (and `www`).
   Render shows the DNS records to create at your domain registrar (a CNAME for `www`, and an A record or
   ALIAS for the bare domain). HTTPS is added automatically after DNS updates (can take a few minutes to hours).
3. **Google sign-in**: Google Cloud console → *APIs & Services* → *Credentials* → *Create credentials* →
   *OAuth client ID* → *Web application* → authorised redirect URI
   `https://YOUR-DOMAIN/api/auth/google/callback`. Paste the client ID and secret into Render.
4. **Open your domain.** It goes to the sign-in page. Signing in with the admin Gmail opens `/admin`, a
   warehouse Gmail opens `/warehouse`, a partner Gmail opens `/partner`, anyone else gets the customer app.
5. **Safety before real customers**
   * Render → the disk → turn on daily snapshots (kept for a few days).
   * Set up S3 or Cloudflare R2 (`PRINTBEE_S3_BUCKET`, see the README) so uploaded print files do not fill the
     1 GB disk. Until then, raise the disk size.
   * Keep payments on `disabled` or `test` until you add the Razorpay keys, then set `PRINTBEE_PAYMENT_MODE=razorpay`.
6. **Print room PC**: get the print-agent key from Render → *Shell*: `python server.py --show-staff-keys`, then run
   `python print_agent.py --origin https://YOUR-DOMAIN --printer "<printer name>" --sumatra "<SumatraPDF.exe path>"`
   with `PRINTBEE_PRINT_AGENT_KEY` set.

## Speed

* The service runs in **Singapore** (closest Render region to India). Paid Render services never sleep, so there is no cold start.
* Put your domain on **Cloudflare (free plan)**: it caches images, CSS and JavaScript close to each visitor and
  protects against floods of traffic. At your registrar change the nameservers to Cloudflare's, keep the
  Render DNS records, and leave the proxy (orange cloud) on. Do not cache `/api/*`.

## Cost (estimate: check render.com/pricing)

| Item | Per month |
|---|---|
| Render Starter web service | about $7 |
| 1 GB persistent disk | about $0.25 |
| Cloudflare R2 for files (free allowance covers small use) | about $0 to $2 |
| Domain | you already have it |

Not included: Razorpay's fee per payment, and any SMS you send for partner phone sign-in.

## Limits

One service means one database file, so the site is limited to roughly a few hundred simultaneous users.
For thousands at once, move to Postgres and several servers (a separate project).

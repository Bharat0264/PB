# PrintBee platform upgrade

Install dependencies with `python -m pip install -r requirements.txt`, run
`python server.py`, and open http://127.0.0.1:4188/. Use
`python -m unittest -v` for the automated tests.

## Deploying shared pricing

Cheapest option (one service, your own domain, about $7/month): [DEPLOY-RENDER.md](DEPLOY-RENDER.md).
Serve the site and its API from the same PrintBee Python server. To put it online, see
[DEPLOY-RENDER.md](DEPLOY-RENDER.md).
Live Admin uses /api/admin/pricing and customers read /api/checkout. Both need
the same running server and persistent SQLite data.

1. Deploy one instance on an HTTPS-enabled Docker host, or run server.py
   behind an HTTPS reverse proxy. Set PRINTBEE_ORIGIN to that public origin and
   configure Google sign-in and PRINTBEE_GOOGLE_ADMIN_EMAILS using
   [EMAIL-SIGN-IN.md](EMAIL-SIGN-IN.md).
2. Keep the database and staff keys on persistent storage. With Docker, create
   and reuse a named volume. Keep the server environment file outside Git.

       docker build -t printbee .
       docker volume create printbee-data
       docker run -d --name printbee --restart unless-stopped \
         --env-file /secure/printbee.env -p 127.0.0.1:4188:4188 \
         --mount source=printbee-data,target=/var/lib/printbee printbee

   Point the host's HTTPS reverse proxy at 127.0.0.1:4188. For a direct Python
   deployment, set PRINTBEE_DATA_DIR to your persistent data directory. The
   default bind is 127.0.0.1 on port 4188. If you already have live orders,
   migrate the existing SQLite database and staff keys before switching hosts.
3. Open /api/checkout on the public origin and verify it returns JSON.
   Sign into /admin#pricing and publish a change. An open /pricing.html on the
   same origin updates within about five seconds.

The login-free admin preview provides an **Open customer pricing preview** link.
Saving preview rates updates that page in the same browser. Checkout uses the
server's published prices.

## Phase 1: Audit and foundation

The existing site uses HTML, CSS, browser JavaScript, Python and SQLite. The customer
flow already supports local file review, per-file print options, one cart bill,
email/Google sign-in, and a saved address with a location pin. The loader uses
Three.js and GSAP. The shared staff portal uses warehouse and delivery keys.

This phase preserves that stack, adds reusable clay styling in `clay.css`, applies
it to the staff console, and extracts the server's pricing and role-bound order
transitions into `order_rules.py`.

## Phase 2: Customer checkout

New placed orders appear on the Orders page on any device signed in to the
same account. Orders placed before account history was added remain visible
on the original browser. Pending checkouts are excluded from order history.

The upload page counts PDF pages and validates selected ranges against the file
at checkout. JPG and PNG are single-page formats. Install LibreOffice and set
`PRINTBEE_SOFFICE` to its executable path for DOCX page counts. Without a
renderer, buyers can enter the DOCX page count manually. Run document conversion
on an isolated service account with limited filesystem and network access when
accepting files from the public.

Checkout quotes come from the server. Set `PRINTBEE_CHECKOUT_TERMS` to configure
delivery slot labels, fees and fixed-value coupon codes using integer paise.
Tax is expressed in basis points. Defaults preserve the existing print prices
without charging additional fees. The bill is saved before payment starts.
Optional `paperRates` entries for A3 and A5 take four integer paise values
in the order B&W single-sided, B&W double-sided, colour single-sided and colour
double-sided. Optional `bindingRates` enables `spiral` and `staple`. Set the
rates and confirm availability with the print shop before offering them.

Set `PRINTBEE_MAPS_BROWSER_KEY` and `PRINTBEE_MAPS_MAP_ID` for address search
and map pins. Enable Maps JavaScript API and Places API (New), and restrict the
browser key to the site's origins. Manual address entry works without a map key.

Set `PRINTBEE_S3_BUCKET` to a private bucket with S3 public access blocked.
Use IAM credentials from the AWS SDK environment and grant access to the
`printbee/orders/` and `printbee/support/` prefixes (print files and support
ticket attachments). An optional S3-compatible endpoint is configurable.
The application checks order ownership before returning a file or creating a
one-minute signed link. Without S3, the local app stores files in SQLite.
Existing SQLite files remain readable with either configuration.

After the assigned partner successfully verifies the delivery OTP, the same database
transaction removes that order's uploaded print files. Wrong, expired, locked or
unauthorized OTP attempts do not delete anything. Order history, file names/print
settings, receipts and partner earnings remain available. Delivered files return
HTTP 410 and cannot be downloaded or reordered; a new print order needs a new upload.
The browser also removes legacy cached order-file copies when it sees the delivered
status. This does not delete originals or copies already saved on a customer's device.

For S3, a durable deletion job commits with the delivery. A background worker removes
the entire order prefix (including replaced uploads, object versions and delete
markers), wakes immediately after OTP verification, and retries storage outages every
30 seconds and after restarts. SQLite uses secure deletion for its active database
pages. The worker also cleans older delivered uploads when a successful
`delivery_completed` audit exists. Support-ticket attachments use their separate
retention policy and are not removed by delivery cleanup.

Storage credentials need `s3:ListBucket`, `s3:ListBucketVersions`, `s3:DeleteObject`
and `s3:DeleteObjectVersion` for the order prefix, in addition to upload/download
permissions. Configure independent database/object-store backups and any Object Lock
retention consistently: application deletion cannot erase external backups or
override a provider retention lock. Failed cloud deletions remain in `file_deletions`
with an attempt count and an error type (no secret values), rather than being marked complete.

Placed orders show delivery stages and refresh while open. Customers can
download an order PDF or, before verified delivery, copy available files and print
settings into the cart to review them at current prices. The PDF is an order receipt or local test
summary. Merchant tax registration details are needed for GST invoices.

Payments default to disabled. For a local demo, export
`PRINTBEE_PAYMENT_MODE=test`. For Razorpay, export the settings in
`.env.example`, use `PRINTBEE_PAYMENT_MODE=razorpay`, and start with Razorpay
test keys. Configure automatic capture and a `payment.captured` webhook to
`/api/webhooks/razorpay` on the public HTTPS endpoint. The webhook secret is
separate from the API key secret. The signed capture commits the paid state
before the warehouse can see the order. Retrying checkout on the same tab
for the same cart and details reuses its order reference.

## Remaining production work

| Phase | Scope and dependencies |
| --- | --- |
| 2 | Verify Razorpay test checkout against a public webhook, configure and verify Google Maps and the private bucket, and test DOCX pagination with the production renderer. Configure merchant details for tax invoices. |
| 3 | Validate the agent on the warehouse printer, add automated mixed-colour submission and label printing, printer supplies, and per-user warehouse accounts. |
| 4 | Verify Twilio enrollment and delivery on real phones. Add distance-based dispatch, live route and ETA, earnings and payouts, KYC, and photo proof. |
| 5 | Validate refunds in Razorpay test mode, add partner management and settlements, detailed finance and GST reporting, and additional pricing rules. |
| 6 | Configure the status email worker and verify mail delivery. Add push and SMS status notifications. Verify deployment, production security, and accessibility. |

Production provider accounts, deployment settings, and warehouse printer details
are still needed for live integrations. Keep credentials outside Git. Existing
browser-local carts and saved orders need a migration plan before changing storage.

## Mobile bottom navigation

The customer tabs are Home (`/home`), Orders (`/orders`), Upload
(`/upload`), Cart (`/cart`), and Address (`/address`). Use the profile icon in
the header to open your profile. Orders includes tracking. Home and Upload link to
Pricing. The layout keeps same-origin screens mounted to retain their
scroll and form state between tab switches. Account and order data
require the Python API.

- Touch feedback uses icon compression with a dark keyboard focus ring.
- The raised bubble sits above a visible fixed bar with room around its edges.
- One SVG path draws the circular notch and tangent fillets at the bubble's x.
- The clay surface follows the path across the full bar and safe-area inset.
- The existing JavaScript spring uses the shared constants in `nav-tokens.js`.
  It drives the notch and bubble together. Screens slide 24px over 280ms.
  Reduced motion snaps the bubble and crossfades screens over 150ms.
- The route determines the active tab on load and browser history navigation.

The site root opens the welcome page. Continue as guest enters the customer
site. Google sign-in from the welcome page routes verified emails by the
configured lists in Admin, Warehouse, Partner order. Other accounts enter
the customer site. Google staff sessions are scoped to one portal. After
upgrading, existing Google staff sessions require sign-in again.

## Local operations

Use Python with SQLite 3.35 or later. Open `/warehouse`, `/partner` or
`/admin` and choose **Continue with Google**. Use the same OAuth client and
callback as the customer login in `EMAIL-SIGN-IN.md`. Set only the admin email
list in `PRINTBEE_GOOGLE_ADMIN_EMAILS`. Admins then add delivery partners and
warehouse staff inside `/admin` (their access is stored in the database).
`PRINTBEE_GOOGLE_WAREHOUSE_EMAILS` and `PRINTBEE_GOOGLE_PARTNERS` (a JSON object
mapping Google email addresses to partner IDs) are still read if set. To preserve partner order
history, use the existing partner ID, including `delivery` for the default
operator. Customer sign-in sessions do not grant portal access.

Staff API keys (the `X-Staff-Key` header) are OFF by default: staff sign in with Google. To use the keys,
for example for a script or a warehouse workstation, set `PRINTBEE_ALLOW_STAFF_KEYS=1` and run
`python server.py --show-staff-keys` to obtain them. Keys never expire, so keep this off unless you need it.

Printing is manual. The warehouse opens each file (Preview or Download), prints it on the print-room
printer, and presses **Mark printed** for that file or for all of them. Once every file is
marked, the order moves straight to Ready for pickup. A downloadable PDF label is optional.
There is no print agent and no printer software to install.

Set `PRINTBEE_PARTNER_KEYS` to a JSON object mapping partner IDs to unique
random tokens for individual assignments. The original delivery key remains
available for the default operator. A partner accepts a packed order and
confirms pickup. The signed-in customer
can then see a four-digit code and the latest shared position on Orders.
The code expires after two hours and locks after three wrong attempts.
An admin can renew it from the dashboard. Open account order details receive
status and delivery updates using Server-Sent Events. The reverse proxy must
pass these responses unbuffered. Partner location sharing uses the browser's
permission prompt. Customers can copy a status-only tracking link for guests.
The link grants access to the reference and status without disclosing files,
location, addresses or the delivery code.

For phone login, set `PRINTBEE_PARTNER_PHONES` to a JSON object mapping E.164
phone numbers to unique partner IDs, and set the Twilio Verify service,
account and token in the environment. Admin pricing's `autoDispatch` option
assigns newly packed orders to an available idle partner. Availability expires
after 15 minutes unless the partner renews it.

The admin dashboard shows order counts, captured Razorpay totals, a recent
order CSV export, and operational audit events. Published pricing is stored
as a new version and is available to subsequently loaded checkouts. Existing
paid orders retain their quoted amounts.

Set `partnerPayout` in checkout pricing to record fixed delivery earnings
in integer paise. Completed deliveries get one earnings entry. Admins can
record an externally completed transfer against a specific earning using
its reference. The dashboard records the settlement without moving money.
Signed-in customers can also read their fulfilment and refund updates on
the Orders page.

For optional status email, configure the SMTP settings from
`EMAIL-SIGN-IN.md` and the public HTTPS origin. Run one scheduled instance of
`python send_order_updates.py`. Its first run starts at the current event
cursor to avoid sending historical mail. Later runs send up to 50 new
updates and resume from the last successful send.

### Scheduling the email worker

`send_order_updates.py` is a short job, not a server. It sends order updates
**and** the "support replied to your ticket" emails (`support_notify.py`), then
exits. Run it every minute or two, one copy at a time, with the same
environment variables as the website (`PRINTBEE_ORIGIN`, `PRINTBEE_DATA_DIR` or
the database settings, and the `PRINTBEE_SMTP_*` variables).

- **Linux or macOS (cron)**, every minute:
  `* * * * * cd /path/to/PrintBee && /usr/bin/env python3 send_order_updates.py >> email-worker.log 2>&1`
  (put the `PRINTBEE_*` variables in the crontab or load them from your env file first).
- **Windows (Task Scheduler)**: create a task with trigger "Daily, repeat every
  1 minute for 1 day", action "Start a program" = `python.exe`, arguments
  `send_order_updates.py`, "Start in" = the PrintBee folder, and set the
  `PRINTBEE_*` values as user environment variables. Under "Settings" choose
  "Do not start a new instance" so two copies never overlap.
- **Render**: add a Cron Job service running `python send_order_updates.py` on the
  schedule `* * * * *` with the same environment group as the web service. The
  database and file storage must be shared with the web service (use a
  persistent disk or an external database).

**`PRINTBEE_ORIGIN` must be set** to the public HTTPS address customers use (for
example `https://printbee.co.in`, no trailing slash). The worker refuses to run
without an HTTPS origin, and the link inside a support-reply email is built from
it (`PRINTBEE_ORIGIN/help.html#/ticket/<id>`), so a wrong value sends customers to a
broken page. The email never contains the reply itself; customers sign in and
read it on the site. To check mail and storage settings before relying on them,
run `python check_support_services.py you@example.com`.

### Owner alerts for support tickets

Set `PRINTBEE_OWNER_EMAIL` to the address that should hear about problems. With SMTP and
`PRINTBEE_ORIGIN` configured, the owner is emailed straight away when a ticket is **urgent**
(including every Bee Runner safety report) or when **Buzz escalates** a ticket, and by the
scheduled worker when a ticket has had **no staff reply** for longer than the limit (default
4 hours; change it in Admin > Support > Saved replies and response alerts). The email names the
ticket and the reason and links to it; it never quotes the conversation. Each ticket triggers
each kind of alert once. Without `PRINTBEE_OWNER_EMAIL` nothing is sent, but the in-app bell in
the admin portal still shows new, urgent and replied tickets.

### Support, who sees what

- **Customers** see their own tickets, replies from "PrintBee Support" and a bell with unread
  updates. Notifications only say what happened to a ticket number.
- **Admins** see every ticket (and internal notes, which customers never see), the order panel
  (status, Bee Runner, invoice, delivery code state but never the code), saved replies and the
  first-response time of each ticket.
- **Warehouse staff** see only tickets assigned to them and print quality tickets, with the
  order's print options and a reply box. No phone numbers, customer emails, addresses or
  internal notes.
- **Bee Runners** can report a problem on their own active delivery (customer not answering,
  wrong address, pickup problem, safety issue). It becomes an admin ticket with a Runner badge;
  safety reports are urgent automatically. Customers never see runner reports.
- **Buzz** (the chatbot, not built yet) uses `support.create_buzz_ticket(...)`,
  `support.buzz_find_tickets(db, customer_email)` and `support.buzz_get_ticket(db, customer_email, id)`.
  The email must come from the signed-in customer's session, never from chat text; these functions
  can only return that customer's own tickets and never internal notes.

The admin may cancel an unprinted local test order or request a full refund
on an unprinted captured Razorpay order. A refund request pauses fulfilment
and uses a stable receipt reference. Configure the HTTPS Razorpay webhook to
also receive `refund.processed` and `refund.failed`. A pending request can be
reconciled from the dashboard if the initial API response is lost.

### Practice a delivery on the live site

In **Admin → Orders → Create test delivery**, select the partner account that will test the flow.
The new `PB-TEST-…` order is ready for pickup and visible only to that partner. It uses the normal
acceptance, pickup and delivery-code checks. Stay at the pickup location: this is a practice handover
with no real customer, parcel, printing, payment or travel. GPS sharing is disabled for practice orders.

The partner goes online, accepts the test order, confirms arrival and pickup, then completes the
handover steps. In the admin's **Test delivery orders** list, open the same order and press
**Refresh status / OTP** after pickup to get the code. Use **Renew test OTP** if it expires or locks.
After delivery, the order stays in the test list and another test can be created. Repeated creation
returns the existing unfinished test for that partner. Test orders do not enter sales, warehouse
revenue, normal order counts, customer history, financial ledgers or partner earnings.

This feature creates synthetic practice data; it never copies customer files or contact details.
The admin-only endpoints are `POST /api/admin/test-deliveries` with `{"partner":"registered-partner-id"}`
and `GET /api/admin/test-deliveries/{id}`. The latter exposes an OTP only for practice orders after pickup.

### Buzz, the support chatbot (backend)

Buzz answers FAQs, prices, upload help and order questions, and drafts support tickets. It uses the existing
support tickets (`support.create_buzz_ticket`, `buzz_find_tickets`, `buzz_get_ticket`); there is no separate tickets table.

- Routes: `POST /api/support/chat` (a message, or `action: "confirm"` / `"human"`) and `POST /api/support/chat/feedback`.
- Environment (the provider settings are only these three):
  - `PRINTBEE_SUPPORT_PROVIDER` = `mock` (the default) or `gemini`. `gemini` without `GEMINI_API_KEY`, or any other value
    (for example the removed `anthropic`), falls back to `mock` and writes one warning to the log.
  - `GEMINI_API_KEY`: your Google AI Studio key. Read only from the environment on the server, never logged, never sent to the browser.
  - `PRINTBEE_GEMINI_MODEL`: the model name (default `gemini-3.5-flash-lite`). Check which names your key can use in Google AI Studio
    (https://aistudio.google.com) or on https://ai.google.dev/gemini-api/docs/models.
  - All model calls go through one small adapter (`buzz_providers.py`), so the tools and guardrails live in our own code.
- Limits (not provider settings): `PRINTBEE_CHAT_DAILY_CAP_USD` (default 5), `PRINTBEE_CHAT_RETENTION_DAYS` (default 30),
  and `PRINTBEE_BUZZ_MOCK=1` to force `mock` whatever the provider setting says.
- `mock` mode: canned answers built from the same live pricing, FAQ and order data, no model and no outside call.
- Data minimisation (essential on Gemini's free tier, which may use what it is sent): the model only
  sees order numbers, statuses, timelines, ETAs and ticket numbers. It never sees names, emails, phone numbers, addresses,
  payment ids, file names, amounts or order keys. What a customer types is redacted (emails, UPI ids, phone and card-like
  numbers, payment ids, file names, order keys, delivery codes) before the model call and before it is stored. Tickets are
  created by the server under the customer's own session, which fills the personal fields. A guest's order number and key are
  checked by the server, so the key never reaches the model. Names or addresses a customer types in plain words cannot be
  detected, which is why the chat shows "AI assistant. Please don't share personal or payment details."
- If the provider is rate-limited or down, Buzz shows a friendly message and offers "Create a ticket" instead of failing.
- Edit what Buzz knows in `kb/faq.md`. Any section with a `TODO:` line is treated as unconfirmed and Buzz says
  "I'm not sure" about it. Buzz's rules live in `buzz_prompt.md`.
- The chat button is an animated 3D bee (`buzz-bee3d.js`, Three.js r187 copied into `vendor/three/` with its MIT licence, no build step).
  The model is `buzz-bee.glb`, made from the original `Bee.glb` (58 MB, 1.9 million triangles) with `gltf-transform simplify --ratio 0.01
  --error 0.02` and `resize --width 512 --height 512`: 0.8 MB and about 19,000 triangles. It is loaded only when the page is idle, not on
  data-saving or 2g connections, and if 3D is not possible the still bee (`buzz-bee-idle-1x/2x/3x.webp`, with `wave` and `typing` poses, made by `tools/make_bee_pictures.py`) is shown instead. The still bee also shows while the 3D one loads, in exactly the same place, so nothing jumps. The launcher is a round clay badge with the bee floating above it and a soft contact shadow that squashes with the 3 second float. The loop runs at 30 frames a
  second while the bee floats, speeds up only for a hover, a hop or a click, stops while the tab is hidden, and with "reduce motion" the bee is
  drawn once and does not move. The model is a single solid mesh with no animation, so the wings do not flap on their own.
  Its surface is `buzz-bee-clay.webp`, the model's colour texture retouched into the soft clay style of the PrintBee logo mascot
  (`python tools/make_clay_bee_texture.py ORIGINAL.jpg` makes it) and drawn with a matte clay material. The canvas has extra room above and
  beside the bee, and `probeEdges()` in `buzz-bee3d.js` draws every extreme pose to prove nothing touches the edge.
- The model can only draft a ticket. The customer presses Confirm, which creates exactly one ticket per draft.
- Chats are stored redacted (emails, phone and card-like numbers, codes) in `chat_sessions` / `chat_messages` and deleted after the retention period.

## Connected portals

One order travels through the customer, warehouse, partner and admin portals with live status. See
[docs/connected-workflow/CONNECTED-PORTALS.md](docs/connected-workflow/CONNECTED-PORTALS.md) for the workflow map,
configuration (local vs production) and `python demo.py` for a one-command local demo.

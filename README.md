# PrintBee platform upgrade

Install dependencies with `python -m pip install -r requirements.txt`, run
`python server.py`, and open http://127.0.0.1:4188/. Use
`python -m unittest -v` for the automated tests.

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
`printbee/orders/` prefix. An optional S3-compatible endpoint is configurable.
The application checks order ownership before returning a file or creating a
one-minute signed link. Without S3, the local app stores files in SQLite.
Existing SQLite files remain readable with either configuration.

Placed orders show delivery stages and refresh while open. Customers can
download an order PDF or copy its files and print settings into the cart to
review them at current prices. The PDF is an order receipt or local test
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
| 6 | Configure push/SMS/email status notifications. Verify deployment, production security, and accessibility. |

Production provider accounts, deployment settings, and warehouse printer details
are still needed for live integrations. Keep credentials outside Git. Existing
browser-local carts and saved orders need a migration plan before changing storage.

## Local operations

Use Python with SQLite 3.35 or later and run `python server.py --show-staff-keys`
to obtain distinct warehouse, delivery, admin and agent credentials. Existing
warehouse and delivery keys are preserved. Open `/warehouse`, `/partner` or
`/admin` on the local server and enter the corresponding key.

The warehouse can queue individual files or print all, retry failed
jobs, or confirm a manually printed file. Packing requires every file to be
confirmed. Packed orders offer a downloadable PDF label with an order QR code.
Start the agent with `PRINTBEE_PRINT_AGENT_KEY` set to the agent
credential and run `python print_agent.py --printer "Printer name"`. On
Windows also pass `--sumatra "C:\path\to\SumatraPDF.exe"`. Linux and macOS
use the CUPS `lp` command. DOCX conversion needs LibreOffice on the agent,
and images use Pillow. Use `--origin` for a deployed HTTPS endpoint and
`--once` for one queued job. Successful submission reports completion
at the spooler. If a job is interrupted, inspect the real spooler before using
`POST /api/admin/print-jobs/<id>/recover` with the admin key and retrying.

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

The admin may cancel an unprinted local test order or request a full refund
on an unprinted captured Razorpay order. A refund request pauses fulfilment
and uses a stable receipt reference. Configure the HTTPS Razorpay webhook to
also receive `refund.processed` and `refund.failed`. A pending request can be
reconciled from the dashboard if the initial API response is lost.

# Connected portals: final report

Audit and gap list: [AUDIT.md](AUDIT.md). How it works: [CONNECTED-PORTALS.md](CONNECTED-PORTALS.md).
No secrets are printed or committed anywhere in this work.

## What is connected now

| Hand-off | Status |
|---|---|
| Payment → warehouse queue | Live: appears over the event feed within about a second (measured < 5 s in the test, ~2 s in a real browser) |
| Print result → order status | Print agent (mock or real) reports each file; the order becomes Ready when all are done |
| Ready → partner list | Live; first accept wins (verified with two simultaneous accepts) |
| Accept → warehouse and customer see the partner | Yes: partner name, ETA from live location, timeline |
| Pickup → OTP created, customer notified | Yes: in-app notification, email with the code, code card on Orders |
| Deliver → every portal updates | Customer, warehouse, partner and admin; partner earnings added; revenue and profit update |
| Cancel, refund, failed print, undeliverable, reassign | All exist and are tested (undeliverable and reassign are new; local refund in test mode is new) |
| Pricing | Versioned; new orders only; old orders keep their snapshot; stale quotes refused |
| Roles, switch portal, one logout | New; the menu shows only roles the person holds |
| One status vocabulary | Server model + shared client; labels and badges match in all four portals |

## What changed (by commit)

1. **Audit** (`docs/connected-workflow/AUDIT.md`).
2. **Status model, `order_events`, live feed**: `order_status.py` (statuses, transitions, DB triggers),
   `event_feed.py`, `/api/events` (SSE + polling fallback + catch-up), `/api/status-model`.
3. **Portals connected**: `live.js`, `status-model.js/.css`, wiring in warehouse, partner, admin and customer
   pages; customer timeline/partner/ETA; notifications from real changes; undeliverable + reassign; admin
   finance block (`finance.py`); email worker on `order_events` with the OTP.
4. **Accounts and demo**: `/api/auth/me`, `/api/auth/switch`, one logout, preview gating, local canonical host,
   `demo.py`, mock print agent, `test_e2e_workflow.py`.

## Bugs fixed

* **First price change on a fresh database was rejected** (default A4 rates were a tuple, validation required
  a list). Found by the end-to-end test.
* **Customers never received a "Printing" notification** (the audit action was `print_queued`, the filter
  looked for `printing`). Notifications now follow real status changes.
* **Logout left sessions behind** (customer session survived a portal logout and the reverse).
* **Sample-data screens were served on every origin**, including production.
* Admin had no revenue/profit in test mode (it only knew Razorpay "captured").
* Refund was impossible in local test mode and impossible after a failed delivery.

## Still mock-only or not verified

* **Preview screens** (`?preview=1`, `/admin-preview.html`) are sample data by design, local only now. The admin
  *dashboard* preview (`admin-dashboard.js`) still shows fixtures; the live admin is `/admin`.
* **Razorpay live mode, Google sign-in, SMTP, Twilio and a physical printer** were not exercised (no credentials
  here). Test payments, the mock printer and demo sign-in replace them locally. The Razorpay code paths are
  unchanged apart from the shared event log.
* **Email sending** was not run against an SMTP server; message building (including the OTP) is straightforward
  but untested end to end.
* **Browser coverage**: the customer, warehouse, partner and admin flows were driven in a real browser in demo
  mode (see the demo run); only the happy path. The customer ordering screens (upload → checkout) were exercised
  through the API, not by clicking.

## Decisions for you

1. **`READY` is stored as `packed`; `PRINTED`, `ASSIGNED`, `PICKED_UP` are derived.** Splitting them into stored
   statuses would bring back the manual pack step that a recent commit removed on purpose. Say if you want it.
2. **No guest checkout.** Ordering requires an email sign-in (existing behaviour); "guest" on the welcome page
   only means browsing.
3. **Profit definition** excludes paper/toner/rent. With default fees a partner payout can exceed an order's
   total (the demo showed this), which the admin figures now make visible.
4. **Refunds after printing**: only paid or undeliverable orders can be refunded; a printed but undelivered
   order must go through "undeliverable" first (existing rule, extended, not relaxed).

## Remaining risks

* The SSE feed holds one thread and one SQLite connection per open browser tab (stdlib `ThreadingHTTPServer`).
  Fine for a campus print shop; for hundreds of simultaneous staff tabs, put the feed behind a small async
  gateway or poll.
* Event ids come from the audit table's rowid. All writes that matter use `BEGIN IMMEDIATE`, so ids commit in
  order; a future write path that does not could be missed by a connected client until the safety sync (≤ 45 s).
* Other sessions are changing the same repo concurrently (the history shows staff-portal and theme work);
  `studio.js`, `warehouse.js`, `partner.js` and `operations.js` were touched minimally, but expect merge
  conflicts if those files are edited elsewhere.
* The email worker's cursor starts at "now" the first time it runs, so it will not email past orders.

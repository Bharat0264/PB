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
at checkout. JPG and PNG are single-page formats. DOCX still uses manual page
counts because pagination depends on document rendering.

Checkout quotes come from the server. Set `PRINTBEE_CHECKOUT_TERMS` to configure
delivery slot labels, fees and fixed-value coupon codes using integer paise.
Tax is expressed in basis points. Defaults preserve the existing print prices
without charging additional fees. The bill is saved before payment starts.

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
| 2 | Provider-side verification with Razorpay test keys and a public webhook, Google Places and a map picker, private object storage, DOCX rendering for page counts, paper-size and additional binding rates, reorder, and invoice downloads. |
| 3 | Warehouse dashboard, durable print jobs, printer agent, packing labels, and per-user audit logs. Validate the agent on the actual warehouse printer before rollout. |
| 4 | Partner accounts and assignment, Google Maps, location tracking, and OTP delivery confirmation with a configured SMS provider. |
| 5 | Admin roles, versioned pricing, partner management, reporting, refunds, and payouts. |
| 6 | Realtime tracking, notifications, production security and accessibility checks, end-to-end QA, and deployment. |

Production provider accounts, deployment settings, and warehouse printer details
are still needed for live integrations. Keep credentials outside Git. Existing
browser-local carts and saved orders need a migration plan before changing storage.

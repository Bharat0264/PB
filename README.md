# PrintBee platform upgrade

Run locally with `python server.py` and open http://127.0.0.1:4188/. Use
`python -m unittest -v` for the pricing and state transition tests.

## Phase 1: Audit and foundation

The existing site uses HTML, CSS, browser JavaScript, Python and SQLite. The customer
flow already supports local file review, per-file print options, one cart bill,
email/Google sign-in, and a saved address with a location pin. The loader uses
Three.js and GSAP. The shared staff portal uses warehouse and delivery keys.

This phase preserves that stack, adds reusable clay styling in `clay.css`, applies
it to the staff console, and extracts the server's pricing and role-bound order
transitions into `order_rules.py`.

## Phase 2: Customer order history

New placed orders appear on the Orders page on any device signed in to the
same account. Orders placed before account history was added remain visible
on the original browser. Pending checkouts are excluded from order history.

## Remaining production work

| Phase | Scope and dependencies |
| --- | --- |
| 2 | Private object storage, validated document page counts, delivery options, and Razorpay checkout with verified webhooks. The existing payment is a local test payment. |
| 3 | Warehouse dashboard, durable print jobs, printer agent, packing labels, and per-user audit logs. Validate the agent on the actual warehouse printer before rollout. |
| 4 | Partner accounts and assignment, Google Maps, location tracking, and OTP delivery confirmation with a configured SMS provider. |
| 5 | Admin roles, versioned pricing, partner management, reporting, refunds, and payouts. |
| 6 | Realtime tracking, notifications, production security and accessibility checks, end-to-end QA, and deployment. |

Production provider accounts, deployment settings, and warehouse printer details
are still needed for live integrations. Keep credentials outside Git. Existing
browser-local carts and saved orders need a migration plan before changing storage.

# Customer order tracking

Open **Your orders** at `/orders` or an individual order at `/orders/<id>`. Checkout opens the individual tracker when payment is confirmed. Existing links using `/orders.html#track=<id>.<key>` continue to work. A shared link shows the order number and public status only, even in the order owner's signed-in browser.

## Status mapping

| Backend status or event | Customer presentation |
| --- | --- |
| `pending` | Awaiting payment when the existing order key grants access. |
| `paid` | Order placed, with the recorded payment time and file and page counts when available. |
| `printing` | Printing your pages, with print specs and a paper-feed illustration. The page total comes from the order. |
| `print_failed` during `printing` | Printing needs attention, with a support action. A later print completion or recovery clears the state. |
| `packed` | Packed & ready. |
| `packed` with a delivery assignment | Helper assigned, using campus wording when applicable. The delivery ticket explains when the code will be available. |
| `out_for_delivery` | On the way. Shows the current server-provided code, ETA, and location only when supplied. |
| `delivered` | Delivered stamp, with the timestamp if the server recorded a delivery event. |
| `undeliverable` | Delivery needs attention, with a support action. |
| `cancelled`, `refund_pending`, `refunded`, `refund_failed` | Cancellation or refund status. A failed refund offers support. |
| `delivery_reassigned` | Private in-app message and refreshed helper details. |
| Connection loss | Last-known state with a reconnection banner and update time. Active delivery codes are concealed until a fresh response arrives. |

## Changelog

- Added active and past order groups, filters, progress indicators, invoice links, and reorder actions for past orders.
- Added the honeycomb journey, animated bee, printing panel, mobile delivery sheet, and receipt summary. The tracker uses the existing customer event stream and a 10-second status refresh while the document is visible.
- Kept the existing order detail endpoint and status values. Added owner-only receipt fields and list amounts and dates from the stored order. Shared requests are explicitly filtered before any owner-only fields are built.
- The embedded map loads on demand when the existing Google Maps configuration and a recent helper location are available. The destination pin uses the saved order address, when present.

## Data limits

The current backend does not record a file-review, Arrived, Delayed, or Payment Failed stage. It has no live print-page counter, mapped route geometry, helper photos, ratings, vehicle or masked contact fields, or customer push subscription endpoint. The tracker omits those fields and uses existing support and notification data. A delivery code belongs to **Out for delivery** under the existing pickup and expiry rules.

The review screenshots use synthetic QA fixtures for recorded states. They cover 1440, 1024 and 390 px, light and dark themes, and campus and outside-campus orders. The delivery-code screenshot represents an order out for delivery. The attention screenshot represents an undeliverable order.

# Delivery address changelog

## Current service area

Delivery is limited to a **5 km straight-line radius** around **12.822949, 80.044780**, the point in the [approved Google Maps link](https://maps.app.goo.gl/S8uDxefB1KYZGsKd6). This coverage check is separate from per-kilometre fees and the selected warehouse pickup.

The published `/api/checkout` catalog includes `terms.serviceArea`. Quotes and new orders require a final `Delivery pin: latitude, longitude` address line and reject missing, invalid, or outside-area pins for both standard and campus delivery. Existing orders retain their fulfillment and payment flow. Older saved pricing cannot override coverage.

Customers can use current location or paste coordinates on the Address page; existing saved addresses without pins must be edited before checkout. Google Maps checkout shows the coverage circle when Maps is configured. No Maps API key is required to paste coordinates or validate coverage on the server.

| Area | Change |
| --- | --- |
| Address page | Added a responsive address book and composer, campus and outside-campus forms, inline validation, a live parcel label, and a location suggestion. |
| Saved addresses | Added labels, editing, deletion, a default star, and a separate delivery selection. Older saved addresses become outside-campus addresses and retain their existing checkout address. |
| Checkout | Quotes and order creation use the selected campus when the saved address is used. The existing delivery address string, print settings, and handover OTP still flow through checkout. |
| Pricing | Configured campus rates are validated on the server. A campus flat fee applies only when the saved delivery pin falls within its configured radius. Outside-campus delivery uses the existing rates. |

## Campus configuration

Set the optional `campuses` array in `PRINTBEE_CHECKOUT_TERMS`. The first item is the primary campus. Each entry takes an `id`, `name`, `locality`, `city`, `region`, and six-digit `pin`. The optional `blocks` list populates suggestions and customers can enter another block.

Use the approved delivery centre and service radius as `latitude`, `longitude`, and `radiusMeters` to enable the location suggestion. To use a campus flat fee, add `delivery` in integer paise. An optional `eta` string displays with the campus choice at checkout. The fee replaces the standard flat and per-kilometre delivery charges for qualifying campus pins.

The built-in SRM Kattankulathur entry supplies postal fields and supports free-text block entry. [SRM Kattankulathur Dental College and Hospital](https://dental.srmist.edu.in/affiliating-university-and-details-of-the-vice-chancellor-and-registrar/)

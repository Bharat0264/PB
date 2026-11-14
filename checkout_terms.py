"""Server-controlled delivery choices and order charges for checkout."""

import json
import os


def configured_terms():
    raw = json.loads(os.environ.get("PRINTBEE_CHECKOUT_TERMS", "{}"))
    terms = {key: raw.get(key, 0) for key in ("packing", "platform", "delivery", "taxBasisPoints")}
    if any(type(value) is not int or value < 0 for value in terms.values()) or terms["taxBasisPoints"] > 10000:
        raise ValueError("Checkout fees must be nonnegative integer paise and tax must be 0–10000 basis points.")
    slots = raw.get("slots", [])
    if not isinstance(slots, list) or any(not isinstance(slot, str) or not 0 < len(slot) <= 100 for slot in slots):
        raise ValueError("Delivery slots must be a list of labels (up to 100 characters each).")
    terms["slots"] = slots
    coupons = raw.get("coupons", {})
    if not isinstance(coupons, dict) or any(
        not 0 < len(code) <= 30 or code != code.upper() or type(value) is not int or value <= 0
        for code, value in coupons.items()
    ):
        raise ValueError("Coupons must map uppercase codes to positive integer paise discounts.")
    terms["coupons"] = coupons
    return terms


def bill_for(subtotal, binding, coupon, terms):
    printing = subtotal - binding
    charges = {key: terms[key] for key in ("packing", "platform", "delivery")}
    net = printing + binding + sum(charges.values())
    discount = min(terms["coupons"].get(coupon, 0), max(0, net - 100))
    tax = ((net - discount) * terms["taxBasisPoints"] + 5000) // 10000
    return {"printing": printing, "binding": binding, **charges, "discount": discount,
            "tax": tax, "total": net - discount + tax}

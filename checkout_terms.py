"""Server-controlled delivery choices and order charges for checkout."""

import json
import os

from order_rules import BINDING_RATES, RATES


def configured_terms():
    raw = json.loads(os.environ.get("PRINTBEE_CHECKOUT_TERMS", "{}"))
    return validate_terms(raw)


def validate_terms(raw):
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
    paper = raw.get("paperRates", {})
    binding = raw.get("bindingRates", {})
    if not isinstance(paper, dict) or any(
        key not in ("A4", "A3", "A5") or not isinstance(rates, list) or len(rates) != 4
        or any(type(rate) is not int or rate < 100 for rate in rates)
        for key, rates in paper.items()
    ):
        raise ValueError("Provide four integer paise rates per supported paper size.")
    if not isinstance(binding, dict) or any(
        key not in ("glossy", "blue", "spiral", "staple") or type(rate) is not int or rate < 0
        for key, rate in binding.items()
    ):
        raise ValueError("Provide integer paise rates for supported bindings.")
    terms["paperRates"] = {"A4": RATES, **paper}
    terms["bindingRates"] = {**BINDING_RATES, **binding}
    terms["autoDispatch"] = raw.get("autoDispatch", False)
    if type(terms["autoDispatch"]) is not bool:
        raise ValueError("autoDispatch must be true or false.")
    return terms


def bill_for(subtotal, binding, coupon, terms):
    printing = subtotal - binding
    charges = {key: terms[key] for key in ("packing", "platform", "delivery")}
    net = printing + binding + sum(charges.values())
    discount = min(terms["coupons"].get(coupon, 0), max(0, net - 100))
    tax = ((net - discount) * terms["taxBasisPoints"] + 5000) // 10000
    return {"printing": printing, "binding": binding, **charges, "discount": discount,
            "tax": tax, "total": net - discount + tax}

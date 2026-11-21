"""Server-controlled delivery choices and order charges for checkout."""

import json
import math
import os
import re

from order_rules import BINDING_RATES, BOND_RATES, RATES


# Approved delivery area: https://maps.app.goo.gl/S8uDxefB1KYZGsKd6
# Coverage is straight-line distance, independent of warehouse pickup and delivery fees.
SERVICE_AREA = {"latitude": 12.822949, "longitude": 80.044780, "radiusMeters": 5000,
                "mapUrl": "https://maps.app.goo.gl/S8uDxefB1KYZGsKd6"}


DEFAULT_CAMPUSES = [
    {"id": "srm-ktr", "name": "SRM Kattankulathur", "locality": "SRM Nagar",
     "city": "Kattankulathur", "region": "Tamil Nadu", "pin": "603203", "blocks": []},
]


def validate_campuses(campuses):
    if not isinstance(campuses, list) or not 1 <= len(campuses) <= 30:
        raise ValueError("Provide at least one campus.")
    ids = set()
    result = []
    for campus in campuses:
        text_fields = ("id", "name", "locality", "city", "region", "pin")
        if not isinstance(campus, dict) or any(
            not isinstance(campus.get(key), str) or not 0 < len(campus[key].strip()) <= 100 for key in text_fields
        ) or not re.fullmatch(r"[a-z0-9-]{1,40}", campus["id"]) or campus["id"] in ids or not re.fullmatch(r"[1-9][0-9]{5}", campus["pin"]):
            raise ValueError("Provide a distinct campus ID and valid postal address.")
        ids.add(campus["id"])
        blocks = campus.get("blocks", [])
        if not isinstance(blocks, list) or len(blocks) > 100 or any(
            not isinstance(block, str) or not 0 < len(block.strip()) <= 80 for block in blocks
        ):
            raise ValueError("Campus blocks must be a list of names.")
        coordinates = tuple(campus.get(key) for key in ("latitude", "longitude", "radiusMeters"))
        if any(value is not None for value in coordinates):
            lat, lng, radius = coordinates
            if (any(type(value) not in (int, float) or not math.isfinite(value) for value in coordinates)
                    or not -90 <= lat <= 90 or not -180 <= lng <= 180 or not 0 < radius <= 10000):
                raise ValueError("Provide a valid campus centre and radius in metres.")
        if "delivery" in campus and (type(campus["delivery"]) is not int or campus["delivery"] < 0
                                     or any(value is None for value in coordinates)):
            raise ValueError("Campus delivery pricing needs paise and a campus radius.")
        if "eta" in campus and (not isinstance(campus["eta"], str) or not 0 < len(campus["eta"].strip()) <= 100):
            raise ValueError("Provide a short campus delivery estimate.")
        result.append({**{key: campus[key] for key in text_fields}, "blocks": blocks,
                       **{key: campus[key] for key in ("latitude", "longitude", "radiusMeters", "delivery", "eta")
                          if campus.get(key) is not None}})
    return result


def configured_terms():
    raw = json.loads(os.environ.get("PRINTBEE_CHECKOUT_TERMS", "{}"))
    return validate_terms(raw)


def validate_terms(raw):
    terms = {key: raw.get(key, 0) for key in (
        "packing", "platform", "delivery", "surge", "deliveryPerKm", "taxBasisPoints", "partnerPayout"
    )}
    if any(type(value) is not int or value < 0 for value in terms.values()) or terms["taxBasisPoints"] > 10000:
        raise ValueError("Checkout fees must be nonnegative integer paise and tax must be 0–10000 basis points.")
    slots = raw.get("slots", [])
    if not isinstance(slots, list) or any(not isinstance(slot, str) or not 0 < len(slot) <= 100 for slot in slots):
        raise ValueError("Delivery slots must be a list of labels (up to 100 characters each).")
    terms["slots"] = slots
    terms["campuses"] = validate_campuses(raw.get("campuses", DEFAULT_CAMPUSES))
    terms["serviceArea"] = dict(SERVICE_AREA)
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
        key not in ("A4", "A4 Bond", "A3", "A5") or not isinstance(rates, (list, tuple)) or len(rates) != 4
        or any(type(rate) is not int or rate < 100 for rate in rates)
        for key, rates in paper.items()
    ):
        raise ValueError("Provide four integer paise rates per supported paper size.")
    if not isinstance(binding, dict) or any(
        key not in ("glossy", "blue", "spiral", "staple") or type(rate) is not int or rate < 0
        for key, rate in binding.items()
    ):
        raise ValueError("Provide integer paise rates for supported bindings.")
    terms["paperRates"] = {"A4": RATES, "A4 Bond": BOND_RATES, **paper}
    terms["bindingRates"] = {**BINDING_RATES, **binding}
    terms["autoDispatch"] = raw.get("autoDispatch", False)
    if type(terms["autoDispatch"]) is not bool:
        raise ValueError("autoDispatch must be true or false.")
    return terms


class DeliveryQuoteError(ValueError):
    pass


COORDINATES = r"(-?[0-9]{1,3}(?:\.[0-9]+)?),\s*(-?[0-9]{1,3}(?:\.[0-9]+)?)"


def coordinates(value, *, delivery=False):
    if not isinstance(value, str):
        return None
    match = (re.search(r"(?:^|\n)Delivery pin:\s*" + COORDINATES + r"\s*\Z", value, re.I)
             if delivery else re.fullmatch(COORDINATES, value.strip()))
    if not match:
        return None
    lat, lng = map(float, match.groups())
    if abs(lat) <= 90 and abs(lng) <= 180:
        return lat, lng
    return None


def require_pickup_coordinates(terms, pickup):
    origin = coordinates(pickup["address"]) if pickup else None
    if terms.get("deliveryPerKm") and origin is None:
        raise DeliveryQuoteError("Set the default warehouse pickup to latitude, longitude before using per-km delivery pricing.")
    return origin


# Roads are longer than the straight line between two points; 1.3 is a common estimate for city delivery.
ROAD_FACTOR = 1.3


def distance_km(origin, destination):
    lat1, lng1, lat2, lng2 = map(math.radians, (*origin, *destination))
    a = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(min(1, a)))


def delivery_terms(terms, data, address):
    require_delivery_area(address)
    kind = data.get("deliveryType", "standard")
    if kind == "standard":
        return terms
    if kind != "campus":
        raise DeliveryQuoteError("Choose a valid delivery type.")
    campus = next((item for item in terms.get("campuses", DEFAULT_CAMPUSES) if item["id"] == data.get("campusId")), None)
    if not campus:
        raise DeliveryQuoteError("That campus is unavailable. Choose another delivery address.")
    if "delivery" not in campus:
        return terms
    pin = coordinates(address, delivery=True)
    if pin is None or distance_km((campus["latitude"], campus["longitude"]), pin) * 1000 > campus["radiusMeters"]:
        raise DeliveryQuoteError("Add a delivery pin inside the selected campus to use campus delivery pricing.")
    return {**terms, "delivery": campus["delivery"], "deliveryPerKm": 0}


def require_delivery_area(address):
    pin = coordinates(address, delivery=True)
    if pin is None:
        raise DeliveryQuoteError("Add a delivery location pin to check our 5 km delivery area. Use the Address page or add a final line: Delivery pin: latitude, longitude.")
    origin = (SERVICE_AREA["latitude"], SERVICE_AREA["longitude"])
    if distance_km(origin, pin) > SERVICE_AREA["radiusMeters"] / 1000 + 1e-9:
        raise DeliveryQuoteError("This address is outside our delivery area. We currently deliver within 5 km of our service location. Choose an address inside this area.")


def distance_delivery(terms, pickup, address):
    rate = terms.get("deliveryPerKm", 0)
    if not rate:
        return 0
    origin = require_pickup_coordinates(terms, pickup)
    destination = coordinates(address, delivery=True)
    if destination is None:
        raise DeliveryQuoteError("Add a delivery pin on the map, or enter it on a new line as Delivery pin: latitude, longitude.")
    km = distance_km(origin, destination) * ROAD_FACTOR
    return math.floor(km * rate + 0.5)


def bill_for(subtotal, binding, coupon, terms, *, pickup=None, address=""):
    printing = subtotal - binding
    charges = {key: terms[key] for key in ("packing", "platform", "delivery")}
    charges["delivery"] += distance_delivery(terms, pickup, address)
    if terms.get("surge"):
        charges["surge"] = terms["surge"]
    net = printing + binding + sum(charges.values())
    discount = min(terms["coupons"].get(coupon, 0), max(0, net - 100))
    tax = ((net - discount) * terms["taxBasisPoints"] + 5000) // 10000
    return {"printing": printing, "binding": binding, **charges, "discount": discount,
            "tax": tax, "total": net - discount + tax}

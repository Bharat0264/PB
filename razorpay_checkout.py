"""Razorpay order creation and capture verification for PrintBee."""

import base64
import hmac
import json
import os
import re
from urllib.parse import urlencode
from urllib.request import Request, urlopen


SCHEMA = """
CREATE TABLE IF NOT EXISTS razorpay_orders (
    order_id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL UNIQUE,
    amount INTEGER NOT NULL,
    payment_id TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS razorpay_refunds (
    order_id TEXT PRIMARY KEY, provider_id TEXT UNIQUE, state TEXT NOT NULL
);
"""


class Razorpay:
    def __init__(self, key, secret, webhook_secret):
        self.key = key
        self.authorization = base64.b64encode(f"{key}:{secret}".encode()).decode()
        self.webhook_secret = webhook_secret.encode()

    @classmethod
    def from_environment(cls):
        fields = [os.environ.get("PRINTBEE_RAZORPAY_" + name) for name in
                  ("KEY_ID", "KEY_SECRET", "WEBHOOK_SECRET")]
        if not all(fields):
            raise SystemExit("Set all three PRINTBEE_RAZORPAY credentials.")
        return cls(*fields)

    def request(self, path, data=None):
        body = json.dumps(data).encode() if data is not None else None
        request = Request("https://api.razorpay.com/v1/" + path, data=body, headers={
            "Authorization": "Basic " + self.authorization, "Content-Type": "application/json"
        })
        with urlopen(request, timeout=8) as response:
            return json.load(response)

    def order(self, receipt, amount):
        # Recover an existing order if the original API response was lost.
        found = self.request("orders?" + urlencode({"receipt": receipt}))
        matches = [order for order in found["items"] if order["receipt"] == receipt]
        if len(matches) > 1:
            raise ValueError("Multiple gateway orders have the same receipt.")
        order = matches[0] if matches else self.request("orders", {
            "receipt": receipt, "amount": amount, "currency": "INR", "partial_payment": False
        })
        if (order["receipt"] != receipt or order["currency"] != "INR" or order["amount"] != amount
                or not re.fullmatch(r"order_[A-Za-z0-9]+", order["id"])):
            raise ValueError("Gateway order does not match the checkout.")
        return order["id"]

    def valid_signature(self, body, signature):
        expected = hmac.digest(self.webhook_secret, body, "sha256").hex()
        return hmac.compare_digest(expected.encode(), signature.encode())

    def refund(self, payment_id, receipt, amount):
        if not re.fullmatch(r"pay_[A-Za-z0-9]+", payment_id):
            raise ValueError("Invalid payment reference.")
        path = f"payments/{payment_id}/refunds"
        for offset in range(0, 500, 100):
            found = self.request(path + "?" + urlencode({"count": 100, "skip": offset}))["items"]
            existing = next((refund for refund in found if refund.get("receipt") == receipt), None)
            if existing:
                return existing
            if len(found) < 100:
                return self.request(f"payments/{payment_id}/refund",
                                    {"amount": amount, "receipt": receipt, "speed": "normal"})
        raise ValueError("Refund history requires manual reconciliation.")


def record_refund(db, refund):
    receipt = refund.get("receipt", "")
    if not isinstance(receipt, str) or not re.fullmatch(r"PB-R-[a-f0-9]{32}", receipt):
        return False
    order_id = receipt[5:]
    row = db.execute(
        "SELECT amount, payment_id, razorpay_refunds.provider_id, state FROM razorpay_refunds "
        "JOIN razorpay_orders USING(order_id) WHERE order_id=?", (order_id,)
    ).fetchone()
    state = refund["status"]
    if (not row or refund["payment_id"] != row["payment_id"] or refund["amount"] != row["amount"]
            or refund["currency"] != "INR" or not re.fullmatch(r"rfnd_[A-Za-z0-9]+", refund["id"])
            or row["provider_id"] not in (None, refund["id"]) or state not in ("pending", "processed", "failed")):
        return False
    if row["state"] in ("processed", "failed"):
        return None
    db.execute("UPDATE razorpay_refunds SET provider_id=?, state=? WHERE order_id=?", (refund["id"], state, order_id))
    if state == "processed":
        db.execute("UPDATE orders SET status='refunded' WHERE id=? AND status='refund_pending'", (order_id,))
    elif state == "failed":
        db.execute("UPDATE orders SET status='refund_failed' WHERE id=? AND status='refund_pending'", (order_id,))
    return True


def record_capture(db, payment):
    if payment["status"] != "captured" or payment["currency"] != "INR":
        return False
    if not re.fullmatch(r"pay_[A-Za-z0-9]+", payment["id"]):
        return False
    row = db.execute("SELECT * FROM razorpay_orders WHERE provider_id=?", (payment["order_id"],)).fetchone()
    if not row:
        return None
    if type(payment["amount"]) is not int or row["amount"] != payment["amount"]:
        return False
    if row["payment_id"]:
        return row["payment_id"] == payment["id"]
    changed = db.execute("UPDATE orders SET status='paid' WHERE id=? AND status='pending'",
                         (row["order_id"],)).rowcount
    if not changed:
        return False
    db.execute("UPDATE razorpay_orders SET payment_id=? WHERE order_id=?", (payment["id"], row["order_id"]))
    return True

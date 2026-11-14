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

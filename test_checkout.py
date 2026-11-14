import hmac
import json
import sqlite3
import unittest
from contextlib import closing
from unittest.mock import Mock

from checkout_terms import bill_for
from razorpay_checkout import Razorpay, SCHEMA, record_capture


class CheckoutTest(unittest.TestCase):
    def test_one_bill_with_fees_coupon_and_rounded_tax(self):
        terms = {"packing": 100, "platform": 0, "delivery": 200, "taxBasisPoints": 500,
                 "coupons": {"WELCOME": 100}}
        bill = bill_for(525, 0, "WELCOME", terms)
        self.assertEqual(bill["total"], 761)
        self.assertEqual(bill["tax"], 36)

    def test_retry_recovers_gateway_order_by_receipt(self):
        gateway = Razorpay("key", "secret", "webhook")
        gateway.request = Mock(return_value={"items": [
            {"id": "order_Test1", "receipt": "receipt", "amount": 175, "currency": "INR"}
        ]})
        self.assertEqual(gateway.order("receipt", 175), "order_Test1")
        gateway.request.assert_called_once_with("orders?receipt=receipt")

    def test_capture_checks_signature_amount_and_replay(self):
        gateway = Razorpay("key", "secret", "webhook")
        payment = {"id": "pay_Test1", "order_id": "order_Test1", "amount": 175,
                   "currency": "INR", "status": "captured"}
        raw = json.dumps(payment).encode()
        signature = hmac.digest(b"webhook", raw, "sha256").hex()
        self.assertTrue(gateway.valid_signature(raw, signature))
        self.assertFalse(gateway.valid_signature(raw + b" ", signature))
        with closing(sqlite3.connect(":memory:")) as db, db:
            db.row_factory = sqlite3.Row
            db.executescript(SCHEMA + """
                CREATE TABLE orders(id TEXT PRIMARY KEY, status TEXT);
                INSERT INTO orders VALUES('order-local', 'pending');
                INSERT INTO razorpay_orders VALUES('order-local', 'order_Test1', 175, NULL);
            """)
            self.assertFalse(record_capture(db, {**payment, "amount": 174}))
            self.assertFalse(record_capture(db, {**payment, "status": "authorized"}))
            self.assertEqual(db.execute("SELECT status FROM orders").fetchone()["status"], "pending")
            self.assertTrue(record_capture(db, payment))
            db.execute("UPDATE orders SET status='printing'")
            self.assertTrue(record_capture(db, payment))
            self.assertFalse(record_capture(db, {**payment, "id": "pay_Another"}))
            self.assertEqual(db.execute("SELECT status FROM orders").fetchone()["status"], "printing")

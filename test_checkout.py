import hmac
import json
import sqlite3
import unittest
from contextlib import closing
from unittest.mock import Mock

from checkout_terms import DEFAULT_CAMPUSES, DeliveryQuoteError, bill_for, delivery_terms, validate_terms
from order_rules import quote_items
from razorpay_checkout import Razorpay, SCHEMA, record_capture, record_refund


class CheckoutTest(unittest.TestCase):
    def test_refund_matches_the_captured_payment_and_is_idempotent(self):
        order_id = "a" * 32
        refund = {"id": "rfnd_Test1", "receipt": "PB-R-" + order_id, "status": "processed",
                  "payment_id": "pay_Test1", "amount": 175, "currency": "INR"}
        with closing(sqlite3.connect(":memory:")) as db:
            db.row_factory = sqlite3.Row
            db.executescript(SCHEMA + "CREATE TABLE orders(id TEXT PRIMARY KEY, status TEXT);")
            db.execute("INSERT INTO orders VALUES (?, 'refund_pending')", (order_id,))
            db.execute("INSERT INTO razorpay_orders VALUES (?, 'order_Test1', 175, 'pay_Test1')", (order_id,))
            db.execute("INSERT INTO razorpay_refunds VALUES (?, NULL, 'requested')", (order_id,))
            self.assertFalse(record_refund(db, {**refund, "amount": 174}))
            self.assertTrue(record_refund(db, refund))
            self.assertIsNone(record_refund(db, refund))
            self.assertEqual(db.execute("SELECT status FROM orders").fetchone()["status"], "refunded")

    def test_paper_and_binding_rates_are_validated(self):
        item = dict(name="worksheet.pdf", size=15, pages=2, copies=2, colour=False,
                    duplex=False, orientation="Portrait", paper="A3", binding="spiral")
        with self.assertRaises(ValueError):
            quote_items([item])
        rows, total = quote_items([item], {"A3": (350, 600, 1700, 2800)}, {"spiral": 500})
        self.assertEqual(rows[0]["paper"], "A3")
        self.assertEqual(total, 2400)

    def test_one_bill_with_fees_coupon_and_rounded_tax(self):
        terms = {"packing": 100, "platform": 0, "delivery": 200, "taxBasisPoints": 500,
                 "coupons": {"WELCOME": 100}}
        bill = bill_for(525, 0, "WELCOME", terms)
        self.assertEqual(bill["total"], 761)
        self.assertEqual(bill["tax"], 36)

    def test_delivery_distance_and_surge_are_included_in_checkout(self):
        pickup = {"address": "12.82, 80.04"}
        terms = validate_terms({"delivery": 1000, "deliveryPerKm": 800, "surge": 500,
                                "platform": 300, "packing": 200, "taxBasisPoints": 500})
        bill = bill_for(2200, 500, "", terms, pickup=pickup,
                        address="Hostel\nDelivery pin: 12.83, 80.04")
        self.assertEqual(bill, {"printing": 1700, "binding": 500, "delivery": 2156,
                                "surge": 500, "platform": 300, "packing": 200,
                                "discount": 0, "tax": 268, "total": 5624})
        with self.assertRaises(DeliveryQuoteError):
            bill_for(2200, 500, "", terms, pickup=pickup, address="Hostel")
        with self.assertRaises(DeliveryQuoteError):
            bill_for(2200, 500, "", terms, pickup={"address": "Print room"},
                     address="Hostel\nDelivery pin: 12.83, 80.04")

    def test_campus_price_uses_server_config_and_requires_a_matching_pin(self):
        campus = {**DEFAULT_CAMPUSES[0], "latitude": 12.824, "longitude": 80.045,
                  "radiusMeters": 600, "delivery": 1200}
        terms = validate_terms({"delivery": 3500, "deliveryPerKm": 800, "campuses": [campus]})
        location = "North Hostel\nDelivery pin: 12.824, 80.045"
        choice = {"deliveryType": "campus", "campusId": campus["id"], "delivery": 1}
        campus_terms = delivery_terms(terms, choice, location)
        self.assertEqual(bill_for(500, 0, "", campus_terms, address=location)["delivery"], 1200)
        self.assertIs(delivery_terms(terms, {}, location), terms)
        for invalid in ("North Hostel", "North Hostel\nDelivery pin: 13, 80"):
            with self.assertRaises(DeliveryQuoteError):
                delivery_terms(terms, choice, invalid)

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

import json
import secrets
import sqlite3
import unittest
import uuid

import file_retention as retention
import fulfillment as ops
import razorpay_checkout
from order_rules import quote_items
from test_e2e_workflow import Customer, Server, closing_db, make_pdf

DAY = 24 * 3600
ADDRESS = "North Hostel, SRM campus\nDelivery pin: 12.8240, 80.0450"


def database():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript(ops.SCHEMA + retention.SCHEMA + razorpay_checkout.SCHEMA + """
        CREATE TABLE orders(id TEXT PRIMARY KEY, token TEXT, status TEXT, details TEXT);
        CREATE TABLE files(order_id TEXT, position INTEGER, content BLOB, object_key TEXT);
        CREATE TABLE order_owners(order_id TEXT PRIMARY KEY, email TEXT NOT NULL, order_number TEXT);
    """)
    return db


def add_order(db, email, size=1000, status="pending", created=None, files=True, payment_started=False):
    order_id = uuid.uuid4().hex
    details = json.dumps({"items": [{"name": "a.pdf", "size": size}]})
    with db:
        db.execute("INSERT INTO orders VALUES (?,?,?,?)", (order_id, "k", status, details))
        db.execute("INSERT INTO order_owners(order_id,email) VALUES (?,?)", (order_id, email))
        db.execute("INSERT INTO audit(actor,action,order_id,created) VALUES ('customer','order_created',?,?)", (order_id, created))
        if files:
            db.execute("INSERT INTO files VALUES (?,0,?,NULL)", (order_id, b"x" * 10))
        if payment_started:
            db.execute("INSERT INTO razorpay_orders(order_id, provider_id, amount) VALUES (?,?,100)", (order_id, "order_" + order_id[:8]))
    return order_id


def exists(db, order_id):
    return bool(db.execute("SELECT 1 FROM orders WHERE id=?", (order_id,)).fetchone())


def file_count(db, order_id):
    return db.execute("SELECT count(*) FROM files WHERE order_id=?", (order_id,)).fetchone()[0]


class ExpiryTests(unittest.TestCase):
    NOW = 2_000_000_000

    def test_old_unpaid_orders_and_their_files_are_removed(self):
        db = database()
        old = add_order(db, "a@x.test", created=self.NOW - DAY - 60)
        fresh = add_order(db, "a@x.test", created=self.NOW - 3600)
        with db:
            self.assertEqual(retention.expire_unpaid_orders(db, now=self.NOW), 1)
        self.assertFalse(exists(db, old))
        self.assertEqual(file_count(db, old), 0)
        self.assertEqual(db.execute("SELECT count(*) FROM order_owners WHERE order_id=?", (old,)).fetchone()[0], 0)
        self.assertTrue(exists(db, fresh))
        self.assertEqual(file_count(db, fresh), 1)

    def test_paid_orders_and_started_payments_are_never_removed(self):
        db = database()
        paid = add_order(db, "a@x.test", status="paid", created=self.NOW - 10 * DAY)
        started = add_order(db, "a@x.test", created=self.NOW - 10 * DAY, payment_started=True)
        with db:
            self.assertEqual(retention.expire_unpaid_orders(db, now=self.NOW), 0)
        self.assertTrue(exists(db, paid) and exists(db, started))
        self.assertEqual(file_count(db, paid) + file_count(db, started), 2)

    def test_cloud_files_are_queued_for_deletion(self):
        db = database()
        order = add_order(db, "a@x.test", created=self.NOW - 2 * DAY)
        with db:
            db.execute("UPDATE files SET content=NULL, object_key='printbee/orders/x' WHERE order_id=?", (order,))
            retention.expire_unpaid_orders(db, now=self.NOW)
        self.assertEqual(db.execute("SELECT remote, completed FROM file_deletions WHERE order_id=?", (order,)).fetchone()[:], (1, None))


class PerCustomerCapTests(unittest.TestCase):
    def test_count_cap_drops_the_oldest_unpaid_order_for_that_customer_only(self):
        db = database()
        mine = [add_order(db, "me@x.test", created=1000 + n) for n in range(retention.MAX_PENDING_ORDERS)]
        other = add_order(db, "other@x.test", created=1)
        paid = add_order(db, "me@x.test", status="paid", created=1)
        with db:
            self.assertEqual(retention.make_room(db, "me@x.test", 1000), 1)
        self.assertFalse(exists(db, mine[0]))
        self.assertTrue(all(exists(db, order) for order in mine[1:]) and exists(db, other) and exists(db, paid))

    def test_byte_cap_makes_room_until_the_new_order_fits(self):
        db = database()
        big = retention.MAX_PENDING_BYTES // 2 + 1
        first = add_order(db, "me@x.test", size=big, created=1)
        second = add_order(db, "me@x.test", size=1000, created=2)
        with db:
            self.assertEqual(retention.make_room(db, "me@x.test", big), 1)
        self.assertFalse(exists(db, first))
        self.assertTrue(exists(db, second))

    def test_under_the_caps_nothing_is_removed(self):
        db = database()
        order = add_order(db, "me@x.test", created=1)
        with db:
            self.assertEqual(retention.make_room(db, "me@x.test", 1000), 0)
        self.assertTrue(exists(db, order))


class OrderSizeTests(unittest.TestCase):
    def test_one_order_is_capped_at_200_mb_in_total(self):
        item = {"name": "a.pdf", "pages": 1, "copies": 1, "size": 50 * 1024 * 1024, "colour": False, "duplex": False, "orientation": "Portrait"}
        quote_items([item] * 4)                         # 200 MB exactly is fine
        with self.assertRaises(ValueError):
            quote_items([item] * 5)


class OrdersOverHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server()
        cls.customer = Customer(cls.server, "hoarder@example.test")

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()

    def place(self):
        pdf = make_pdf(1)
        item = {"name": "a.pdf", "pages": 1, "copies": 1, "size": len(pdf), "colour": False, "duplex": False, "orientation": "Portrait"}
        status, bill, _ = self.customer.post("/api/checkout/quote", {"items": [item], "coupon": "", "address": ADDRESS})
        self.assertEqual(status, 200, bill)
        order_id, key = uuid.uuid4().hex, secrets.token_hex(32)
        status, result, _ = self.customer.post("/api/orders", {
            "id": order_id, "customer": "T", "phone": "+91 98765 43210", "address": ADDRESS, "items": [item],
            "expectedTotal": bill["total"], "coupon": "", "notes": "", "slot": ""}, **{"X-Order-Key": key})
        self.assertEqual(status, 200, result)
        status, result, _ = self.customer.post(f"/api/orders/{order_id}/files/0", pdf, **{"X-Order-Key": key, "Content-Type": "application/pdf"})
        self.assertEqual(status, 200, result)
        return order_id

    def test_a_customer_who_never_pays_cannot_keep_piling_up_uploads(self):
        ids = [self.place() for _ in range(retention.MAX_PENDING_ORDERS + 3)]
        with closing_db(self.server) as db:
            kept = [row[0] for row in db.execute("SELECT id FROM orders WHERE status='pending'")]
            stored = db.execute("SELECT count(*) FROM files").fetchone()[0]
        self.assertEqual(len(kept), retention.MAX_PENDING_ORDERS)
        self.assertEqual(stored, retention.MAX_PENDING_ORDERS)       # the removed orders took their files with them
        self.assertNotIn(ids[0], kept)
        self.assertIn(ids[-1], kept)


if __name__ == "__main__":
    unittest.main()

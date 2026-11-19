import sqlite3
import time
import unittest

import fulfillment as ops


class FulfillmentTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(ops.SCHEMA + """
            CREATE TABLE orders (id TEXT PRIMARY KEY, status TEXT, details TEXT);
            CREATE TABLE files (order_id TEXT, position INTEGER);
            INSERT INTO orders VALUES ('sample','paid','{"partnerPayout":250}');
            INSERT INTO files VALUES ('sample',0);
        """)

    def test_dispatch_selects_an_enrolled_available_partner(self):
        self.db.execute("UPDATE orders SET status='packed'")
        now = int(time.time())
        self.db.executemany("INSERT INTO partner_availability VALUES (?, 1, ?)",
                            [("removed", now), ("available", now)])
        ops.dispatch_available(self.db, "sample", {"available"})
        self.assertEqual(self.db.execute("SELECT partner FROM deliveries").fetchone()["partner"], "available")

    def test_delivery_code_lock_and_recovery(self):
        self.db.execute("UPDATE orders SET status='packed'")
        ops.assign_delivery(self.db, "sample", "partner")
        with self.assertRaises(ops.Conflict):
            ops.assign_delivery(self.db, "sample", "other")
        with self.assertRaises(ops.Conflict):
            ops.pickup(self.db, "sample", "other")
        ops.pickup(self.db, "sample", "partner")
        secret = b"local-test-key"
        nonce = self.db.execute("SELECT nonce FROM deliveries").fetchone()["nonce"]
        code = ops.delivery_code(secret, nonce)
        wrong = "0001" if code == "0000" else "0000"
        for _ in range(3):
            self.assertEqual(ops.deliver(self.db, "sample", "partner", secret, wrong), "Incorrect delivery code.")
        self.assertIsNotNone(ops.deliver(self.db, "sample", "partner", secret, code))
        ops.renew_delivery_code(self.db, "sample")
        nonce = self.db.execute("SELECT nonce FROM deliveries").fetchone()["nonce"]
        self.assertIsNone(ops.deliver(self.db, "sample", "partner", secret, ops.delivery_code(secret, nonce)))
        self.assertEqual(self.db.execute("SELECT status FROM orders").fetchone()["status"], "delivered")
        self.assertEqual(self.db.execute("SELECT amount FROM partner_earnings").fetchone()["amount"], 250)
        ops.settle_earning(self.db, "sample", "transfer123")
        with self.assertRaises(ops.Conflict):
            ops.settle_earning(self.db, "sample", "duplicate")

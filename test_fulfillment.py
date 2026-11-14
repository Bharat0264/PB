import sqlite3
import unittest

import fulfillment as ops


class FulfillmentTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(ops.SCHEMA + """
            CREATE TABLE orders (id TEXT PRIMARY KEY, status TEXT);
            CREATE TABLE files (order_id TEXT, position INTEGER);
            INSERT INTO orders VALUES ('sample','paid');
            INSERT INTO files VALUES ('sample',0);
        """)

    def test_print_claim_and_retry(self):
        self.assertTrue(ops.queue_job(self.db, "sample", 0))
        self.assertFalse(ops.queue_job(self.db, "sample", 0))
        job = ops.claim_job(self.db, "claim-one")
        self.assertIsNone(ops.claim_job(self.db, "claim-two"))
        self.assertFalse(ops.finish_job(self.db, job["id"], "claim-two", "done", None))
        self.assertTrue(ops.finish_job(self.db, job["id"], "claim-one", "failed", "paper jam"))
        self.assertTrue(ops.queue_job(self.db, "sample", 0))
        retry = ops.claim_job(self.db, "retry")
        self.assertEqual(retry["id"], job["id"])
        self.assertFalse(ops.finish_job(self.db, retry["id"], "claim-one", "done", None))
        self.assertTrue(ops.finish_job(self.db, retry["id"], "retry", "done", None))

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

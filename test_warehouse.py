import json
import tempfile
import time
import unittest
from contextlib import closing
from http.server import ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import server as app


class WarehouseAccessTest(unittest.TestCase):
    def test_snapshot_returns_paid_orders_and_excludes_pending(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(app, "DATA", Path(directory)):
            with closing(app.connect()) as db, db:
                db.executescript(app.auth.SCHEMA + app.ops.SCHEMA + """
                    CREATE TABLE orders(id TEXT PRIMARY KEY, status TEXT, details TEXT);
                    CREATE TABLE order_owners(order_id TEXT, order_number TEXT);
                    INSERT INTO orders VALUES ('paid-order','paid','{"items":[]}');
                    INSERT INTO orders VALUES ('pending-order','pending','{"items":[]}');
                """)
                app.ops.audit(db, "razorpay", "paid", "paid-order")
            with ThreadingHTTPServer(("127.0.0.1", 0), app.PrintBee) as server:
                server.keys = {"warehouse": "test-warehouse", "admin": "test-admin", "delivery": "test-delivery"}
                server.google_access = {"warehouse": {}, "admin": {}}
                thread = Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    url = f"http://127.0.0.1:{server.server_port}/api/staff/orders"
                    for unauthorized in ("", "test-delivery"):
                        with self.assertRaises(HTTPError) as denied:
                            urlopen(Request(url, headers={"X-Staff-Key": unauthorized}), timeout=3)
                        denied.exception.close()
                        self.assertEqual(denied.exception.code, 403)
                    for role in ("warehouse", "admin"):
                        req = Request(url, headers={"X-Staff-Key": server.keys[role]})
                        with urlopen(req, timeout=3) as response:
                            orders = json.load(response)["orders"]
                        self.assertEqual([order["id"] for order in orders], ["paid-order"])
                        self.assertEqual(orders[0]["timeline"][0]["action"], "paid")
                        self.assertIsInstance(orders[0]["paidAt"], int)
                finally:
                    server.shutdown()
                    thread.join()

    def test_final_print_moves_order_to_ready_and_dispatches_once(self):
        order = "a" * 32
        manual = "b" * 32
        empty = "c" * 32
        with tempfile.TemporaryDirectory() as directory, patch.object(app, "DATA", Path(directory)):
            with closing(app.connect()) as db, db:
                db.executescript(app.ops.SCHEMA + """
                    CREATE TABLE orders(id TEXT PRIMARY KEY, status TEXT, details TEXT);
                    CREATE TABLE files(order_id TEXT, position INTEGER);
                """)
                db.executemany("INSERT INTO orders VALUES (?, ?, ?)", [
                    (order, "printing", "{}"), (manual, "paid", "{}"), (empty, "printing", "{}"),
                ])
                db.executemany("INSERT INTO files VALUES (?, ?)", [(order, 0), (order, 1), (manual, 0)])
                db.execute("INSERT INTO partner_availability VALUES ('rider', 1, ?)", (int(time.time()),))

            with ThreadingHTTPServer(("127.0.0.1", 0), app.PrintBee) as server:
                server.keys = {"warehouse": "test-warehouse"}
                server.partners = {"rider": "test-rider"}
                server.partner_phones = {}
                server.google_access = {"partner": {}}
                server.checkout_terms = {"autoDispatch": True}
                thread = Thread(target=server.serve_forever, daemon=True)
                thread.start()

                def post(path, key, claim="", state=None):
                    headers = {"X-Staff-Key": key, "X-Print-Claim": claim, "Content-Type": "application/json"}
                    payload = json.dumps({"state": state}).encode() if state else b""
                    request = Request(f"http://127.0.0.1:{server.server_port}{path}", payload, headers)
                    with urlopen(request, timeout=3) as response:
                        self.assertEqual(response.status, 200)

                def order_status(db, order_id):
                    return db.execute("SELECT status FROM orders WHERE id=?", (order_id,)).fetchone()["status"]

                try:
                    post(f"/api/staff/orders/{order}/printed/0", "test-warehouse")
                    with closing(app.connect()) as db:
                        self.assertEqual(order_status(db, order), "printing")
                        self.assertIsNone(db.execute("SELECT partner FROM deliveries").fetchone())

                    post(f"/api/staff/orders/{order}/printed/1", "test-warehouse")
                    post(f"/api/staff/orders/{manual}/printed/0", "test-warehouse")
                    with closing(app.connect()) as db:
                        self.assertEqual(order_status(db, order), "packed")
                        self.assertEqual(order_status(db, manual), "packed")
                        self.assertEqual(order_status(db, empty), "printing")
                        self.assertEqual(db.execute("SELECT partner FROM deliveries WHERE order_id=?", (order,)).fetchone()[0], "rider")
                        self.assertEqual(db.execute("SELECT COUNT(*) FROM audit WHERE order_id=? AND action='packed'", (order,)).fetchone()[0], 1)
                finally:
                    server.shutdown()
                    thread.join()

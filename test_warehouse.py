import json
import tempfile
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

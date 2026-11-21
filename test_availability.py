import secrets
import unittest
import uuid

from test_e2e_workflow import Customer, Server, closing_db


class AvailabilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server()
        cls.customer = Customer(cls.server, "availability@example.test")
        cls.staff = {"X-Staff-Key": cls.server.keys["warehouse"]}

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()

    def test_role_validation_and_idempotent_state(self):
        path = "/api/staff/availability"
        self.assertEqual(self.server.request("GET", path)[0], 403)
        self.assertEqual(self.customer.post(path, {"open": False})[0], 403)
        self.assertEqual(self.server.request("POST", path, {"open": "false"}, self.staff)[0], 400)
        with closing_db(self.server) as db:
            before = db.execute("SELECT count(*) FROM audit WHERE action='warehouse_closed'").fetchone()[0]
        for state in (False, False, True):
            status, result, _ = self.server.request("POST", path, {"open": state}, self.staff)
            self.assertEqual(status, 200)
            self.assertEqual(result["open"], state)
            self.assertEqual(self.server.request("GET", path, headers=self.staff)[1]["open"], state)
            self.assertEqual(self.server.request("GET", "/api/checkout")[1]["serviceOpen"], state)
        with closing_db(self.server) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM audit WHERE action='warehouse_closed'").fetchone()[0], before + 1)
            self.assertEqual(db.execute("SELECT is_open FROM warehouse_availability WHERE id=1").fetchone()[0], 1)

    def test_closed_blocks_new_checkout_and_keeps_existing_order(self):
        existing = self.customer.order()
        self.server.request("POST", "/api/staff/availability", {"open": False}, self.staff)
        try:
            item = {"name": "notes.pdf", "size": 20, "pages": 1, "copies": 1, "colour": False,
                    "duplex": False, "orientation": "Portrait"}
            status, result, _ = self.customer.post("/api/checkout/quote", {"items": [item]})
            self.assertEqual(status, 409)
            self.assertTrue(result["serviceClosed"])
            ident = uuid.uuid4().hex
            status, result, _ = self.customer.post("/api/orders", {
                "id": ident, "customer": "Customer", "phone": "9999999999", "address": "Test Road",
                "items": [item], "expectedTotal": 100,
            }, **{"X-Order-Key": secrets.token_hex(32)})
            self.assertEqual(status, 409)
            self.assertTrue(result["serviceClosed"])
            with closing_db(self.server) as db:
                self.assertIsNone(db.execute("SELECT id FROM orders WHERE id=?", (ident,)).fetchone())
            self.customer.pay(existing)
            self.assertEqual(self.customer.view(existing)["status"], "paid")
            listing = self.server.request("GET", "/api/staff/orders", headers=self.staff)[1]
            self.assertFalse(listing["availability"]["open"])
            self.assertIn(existing["id"], [order["id"] for order in listing["orders"]])
        finally:
            self.server.request("POST", "/api/staff/availability", {"open": True}, self.staff)
        self.assertEqual(self.customer.post("/api/checkout/quote", {"items": [item],
                         "address": "Test Road\nDelivery pin: 12.8240, 80.0450"})[0], 200)


if __name__ == "__main__":
    unittest.main()

import secrets
import unittest
import uuid

import admin_records
import customer_auth as auth
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


class WebsiteOrderingTests(unittest.TestCase):
    def setUp(self):
        self.server = Server()
        self.addCleanup(self.server.stop)
        self.admin = {"X-Staff-Key": self.server.keys["admin"]}
        self.warehouse = {"X-Staff-Key": self.server.keys["warehouse"]}
        self.customer = Customer(self.server, "ordering@example.test")

    def availability(self):
        return self.server.request("GET", "/api/checkout")[1]

    def register(self, name, email, default=False):
        status, result, _ = self.server.request("POST", "/api/admin/warehouses", {
            "name": name, "email": email,
            "address": "Test Road\nPickup pin: 12.8240, 80.0450", "useForPickup": default,
        }, self.admin)
        self.assertEqual(status, 200, result)
        with closing_db(self.server) as db, db:
            cookie = auth.portal_session(db, {}, email, "warehouse").split(";")[0]
        return {"Cookie": cookie}

    def test_individual_stores_and_admin_override(self):
        first = self.register("First store", "first@example.test", True)
        second = self.register("Second store", "second@example.test")
        for headers in (first, second):
            self.assertTrue(self.server.request("GET", "/api/staff/availability", headers=headers)[1]["open"])
        self.assertEqual(self.server.request("POST", "/api/staff/availability", {"open": False}, first)[0], 200)
        self.assertTrue(self.availability()["serviceOpen"])
        self.assertFalse(self.server.request("GET", "/api/staff/orders", headers=first)[1]["availability"]["open"])
        self.assertTrue(self.server.request("GET", "/api/staff/orders", headers=second)[1]["availability"]["open"])
        # New orders choose the open store even though the configured default is closed.
        order = self.customer.order()
        with closing_db(self.server) as db:
            import json
            details = json.loads(db.execute("SELECT details FROM orders WHERE id=?", (order["id"],)).fetchone()[0])
        self.assertEqual(details["pickupWarehouse"]["name"], "Second store")
        self.server.request("POST", "/api/staff/availability", {"open": False}, second)
        self.assertFalse(self.availability()["serviceOpen"])
        self.assertEqual(self.availability()["closureReason"], "warehouses_closed")
        self.server.request("POST", "/api/admin/ordering", {"paused": True}, self.admin)
        self.server.request("POST", "/api/staff/availability", {"open": True}, second)
        self.assertTrue(self.availability()["warehouseOpen"])
        self.assertTrue(self.availability()["orderingPaused"])
        self.assertFalse(self.availability()["serviceOpen"])
        self.assertEqual(self.customer.post("/api/checkout/quote", {"items": []})[0], 409)
        self.server.request("POST", "/api/admin/ordering", {"paused": False}, self.admin)
        self.assertTrue(self.availability()["serviceOpen"])

    def test_pause_is_admin_only_validated_persisted_and_blocks_new_orders(self):
        path = "/api/admin/ordering"
        for headers in ({}, self.warehouse):
            self.assertEqual(self.server.request("POST", path, {"paused": True}, headers)[0], 403)
        self.assertEqual(self.customer.post(path, {"paused": True})[0], 403)
        for invalid in ({"paused": "true"}, {"paused": 1}, [], {}):
            self.assertEqual(self.server.request("POST", path, invalid, self.admin)[0], 400)
        for _ in range(2):
            self.assertEqual(self.server.request("POST", path, {"paused": True}, self.admin)[0], 200)
        self.assertEqual(self.server.request("GET", "/api/admin", headers=self.admin)[1]["ordering"]["orderingPaused"], True)
        with closing_db(self.server) as db:
            self.assertTrue(admin_records.ordering_availability(db)["orderingPaused"])
            self.assertEqual(db.execute("SELECT count(*) FROM audit WHERE action='website_orders_paused'").fetchone()[0], 1)
        ident = uuid.uuid4().hex
        item = {"name": "notes.pdf", "size": 20, "pages": 1, "copies": 1, "colour": False,
                "duplex": False, "orientation": "Portrait"}
        status, result, _ = self.customer.post("/api/orders", {
            "id": ident, "customer": "Customer", "phone": "9999999999", "address": "Test Road",
            "items": [item], "expectedTotal": 100,
        }, **{"X-Order-Key": secrets.token_hex(32)})
        self.assertEqual(status, 409)
        self.assertTrue(result["serviceClosed"])
        with closing_db(self.server) as db:
            self.assertIsNone(db.execute("SELECT id FROM orders WHERE id=?", (ident,)).fetchone())
        # Lifting the admin pause cannot reopen warehouses that are still closed.
        self.server.request("POST", "/api/staff/availability", {"open": False}, self.warehouse)
        self.server.request("POST", path, {"paused": False}, self.admin)
        self.assertFalse(self.availability()["serviceOpen"])


if __name__ == "__main__":
    unittest.main()

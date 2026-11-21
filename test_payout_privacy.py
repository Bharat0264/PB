import json
import unittest

import server
from test_e2e_workflow import Customer, RIDER_KEYS, Server


def mentions_payout(value):
    return "payout" in json.dumps(value).lower() or "autodispatch" in json.dumps(value).lower()


class PayoutPrivacyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server()
        cls.customer = Customer(cls.server, "privacy@example.test")
        cls.warehouse = {"X-Staff-Key": cls.server.keys["warehouse"]}
        cls.admin = {"X-Staff-Key": cls.server.keys["admin"]}
        cls.rider = {"X-Staff-Key": RIDER_KEYS[sorted(RIDER_KEYS)[0]]}
        order = cls.customer.order()
        cls.customer.pay(order)
        cls.order = order

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()

    def get(self, path, headers=None):
        status, body, _ = self.server.request("GET", path, headers=headers or {})
        self.assertEqual(status, 200, (path, body))
        return body

    def test_public_checkout_config_lists_only_customer_fields(self):
        config = self.get("/api/checkout")
        self.assertEqual(set(config["terms"]), {"paperRates", "bindingRates", "slots", "campuses"})
        self.assertFalse(mentions_payout(config))
        self.assertNotIn("coupons", json.dumps(config))

    def test_signed_in_customer_responses_never_carry_the_payout(self):
        for path in ("/api/checkout", "/api/orders", f"/api/orders/{self.order['id']}"):
            self.assertFalse(mentions_payout(self.server.request("GET", path, headers=self.customer.headers)[1]), path)

    def test_warehouse_sees_orders_without_the_payout(self):
        body = self.get("/api/staff/orders", self.warehouse)
        self.assertTrue(body["orders"])
        self.assertFalse(mentions_payout(body))
        first = body["orders"][0]
        for needed in ("id", "number", "status", "items", "customer", "phone", "address", "bill", "timeline", "jobs"):
            self.assertIn(needed, first)

    def test_roles_that_need_the_payout_still_get_it(self):
        admin = self.get("/api/admin", self.admin)
        self.assertIn("partnerPayout", admin["terms"])
        self.assertTrue(any("payout" in order for order in admin["orders"]))

    def test_allowlists_are_what_the_code_declares(self):
        self.assertNotIn("partnerPayout", server.PUBLIC_TERMS)
        self.assertNotIn("partnerPayout", server.WAREHOUSE_ORDER_FIELDS)


if __name__ == "__main__":
    unittest.main()

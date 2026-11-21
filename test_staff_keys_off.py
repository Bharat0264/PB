import unittest

from test_e2e_workflow import RIDER_KEYS, Server


class StaffKeysSwitchedOffTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.on = Server()
        cls.off = Server(extra={"PRINTBEE_ALLOW_STAFF_KEYS": ""})
        cls.admin_key = cls.on.keys["admin"]
        cls.warehouse_key = cls.on.keys["warehouse"]
        cls.off_keys = cls.off.keys                       # the keys exist on disk, but the header is ignored

    @classmethod
    def tearDownClass(cls):
        cls.on.stop()
        cls.off.stop()

    def test_with_the_switch_on_the_keys_work(self):
        self.assertEqual(self.on.request("GET", "/api/admin", headers={"X-Staff-Key": self.admin_key})[0], 200)
        self.assertEqual(self.on.request("GET", "/api/staff/orders", headers={"X-Staff-Key": self.warehouse_key})[0], 200)

    def test_with_the_switch_off_no_key_opens_anything(self):
        for role in ("admin", "warehouse", "delivery"):
            key = self.off_keys[role]
            self.assertEqual(self.off.request("GET", "/api/admin", headers={"X-Staff-Key": key})[0], 403, role)
            self.assertEqual(self.off.request("GET", "/api/staff/orders", headers={"X-Staff-Key": key})[0], 403, role)
            self.assertEqual(self.off.request("GET", "/api/events?as=admin", headers={"X-Staff-Key": key})[0], 403, role)
        rider = next(iter(RIDER_KEYS.values()))
        self.assertEqual(self.off.request("GET", "/api/partner/orders", headers={"X-Staff-Key": rider})[0], 403)
        status, body, _ = self.off.request("POST", "/api/partner/availability", {"available": True}, headers={"X-Staff-Key": rider})
        self.assertEqual(status, 403)

    def test_a_key_header_cannot_be_used_to_skip_the_same_origin_check(self):
        status, body, _ = self.off.request("POST", "/api/admin/pricing", {"changes": {}, "version": 0},
                                           headers={"X-Staff-Key": "anything", "Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        self.assertIn("Open PrintBee directly", body["error"])


if __name__ == "__main__":
    unittest.main()

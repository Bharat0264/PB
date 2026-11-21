import http.client
import json
import unittest

from test_e2e_workflow import Customer, Server

REFUSAL = "Open PrintBee directly and try again."


class OriginCheckTests(unittest.TestCase):
    """Every cookie-authenticated POST that guards against cross-site requests refuses a foreign or missing Origin."""

    @classmethod
    def setUpClass(cls):
        cls.server = Server()
        cls.customer = Customer(cls.server, "origin@example.test")

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()

    def post(self, path, body, origin="same", content_type="application/json", headers=None):
        """A plain HTTP client, so the Origin header can really be left out (the test helper always adds one)."""
        sent = {"Content-Type": content_type, **(headers or {})}
        if origin is not None:
            sent["Origin"] = self.server.origin if origin == "same" else origin
        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=30)
        connection.request("POST", path, json.dumps(body).encode(), sent)
        response = connection.getresponse()
        answer = json.loads(response.read() or b"{}")
        connection.close()
        return response.status, answer, None

    def refused(self, path, body, headers=None, json_only=True):
        for origin in ("https://evil.example", None):
            status, answer, _ = self.post(path, body, origin=origin, headers=headers)
            self.assertEqual((status, answer.get("error")), (403, REFUSAL), (path, origin))
        if json_only:
            status, answer, _ = self.post(path, body, content_type="text/plain", headers=headers)
            self.assertEqual((status, answer.get("error")), (403, REFUSAL), (path, "text/plain"))

    def test_sign_in_requests_need_the_same_origin_and_json(self):
        self.refused("/api/auth/request", {"email": "a@example.test"})
        self.refused("/api/auth/logout", {})

    def test_marking_notifications_read_needs_the_same_origin(self):
        self.refused("/api/orders/notifications/read", {}, headers=self.customer.headers, json_only=False)
        status, answer, _ = self.post("/api/orders/notifications/read", {}, headers={**self.customer.headers, "X-Notification-Cursor": "0"})
        self.assertEqual((status, answer), (200, {"saved": True}))

    def test_partner_phone_sign_in_needs_the_same_origin_and_json(self):
        self.refused("/api/partner/auth/send", {"phone": "+919876543210"})
        status, answer, _ = self.post("/api/partner/auth/send", {"phone": "+919876543210"})
        self.assertEqual(status, 503)                      # allowed through the check; no SMS provider is configured here

    def test_partner_actions_need_the_same_origin_and_json(self):
        self.refused("/api/partner/availability", {"available": True})
        status, answer, _ = self.post("/api/partner/availability", {"available": True})
        self.assertEqual((status, answer["error"]), (403, "This account cannot perform this action."))   # origin fine, not signed in


if __name__ == "__main__":
    unittest.main()

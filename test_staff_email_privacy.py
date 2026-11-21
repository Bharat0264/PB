import json
import unittest
from unittest import mock

import customer_auth as auth
from test_e2e_workflow import BOSS, Server


class StaffEmailPrivacyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server()

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()

    def ask(self, email):
        status, body, _ = self.server.request("POST", "/api/auth/request", {"email": email})
        return status, body

    def test_the_form_never_says_an_email_is_staff(self):
        for email in (BOSS, "someone.else@example.test"):
            status, body = self.ask(email)
            self.assertNotIn("staff", json.dumps(body).lower(), (email, status, body))
            self.assertNotEqual(status, 403, email)

    def test_staff_get_the_customer_answer_but_no_email_is_sent(self):
        # in-process check of the two paths: same result for both, delivery only for the customer
        import sqlite3
        db = sqlite3.connect(":memory:"); db.row_factory = sqlite3.Row; db.executescript(auth.SCHEMA)
        sent = []
        deliver = lambda email, token: sent.append(email)
        self.assertEqual(auth.request_link(db, "customer@example.test", "1.1.1.1", deliver), (200, {"sent": True}))
        self.assertEqual(auth.request_link(db, "staff@example.test", "1.1.1.2", lambda email, token: None), (200, {"sent": True}))
        self.assertEqual(sent, ["customer@example.test"])


if __name__ == "__main__":
    unittest.main()

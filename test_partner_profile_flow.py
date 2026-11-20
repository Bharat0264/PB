import unittest

import customer_auth as auth
from test_e2e_workflow import Server, Customer, closing_db
from test_partner_accounts import DETAILS


class PartnerProfileFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server()
        cls.admin = {"X-Staff-Key": cls.server.keys["admin"]}

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()

    def test_enroll_read_isolation_and_remove(self):
        server = self.server
        customer = Customer(server, "customer@example.test")
        self.assertEqual(customer.post("/api/admin/partners", DETAILS)[0], 403)
        self.assertEqual(server.request("GET", "/api/partner/orders")[0], 403)
        self.assertEqual(server.request("POST", "/api/admin/partners", {"email": DETAILS["email"]}, self.admin)[0], 400)
        for _ in range(2):
            self.assertEqual(server.request("POST", "/api/admin/partners", DETAILS, self.admin)[0], 200)
        with closing_db(server) as db, db:
            cookie = auth.portal_session(db, {}, DETAILS["email"], "partner").split(";")[0]
            self.assertEqual(db.execute("SELECT count(*) FROM partner_accounts WHERE email=?", (DETAILS["email"],)).fetchone()[0], 1)
        partner_headers = {"Cookie": cookie}
        status, data, _ = server.request("GET", "/api/partner/orders", headers=partner_headers)
        self.assertEqual(status, 200)
        for key in ("name", "email", "phone", "licence", "payout", "vehicle", "rollNo"):
            self.assertEqual(data["profile"][key], DETAILS[key])
        other = server.request("GET", "/api/partner/orders", headers={"X-Staff-Key": "A" * 8 + "rider_a_secret_token"})[1]
        self.assertNotIn("payout", other["profile"])
        self.assertNotIn(DETAILS["email"], str(other))
        self.assertEqual(server.request("POST", "/api/admin/partners", {**DETAILS, "name": "Updated Rider", "rollNo": "RA2026001"}, self.admin)[0], 200)
        refreshed = server.request("GET", "/api/partner/orders", headers=partner_headers)[1]["profile"]
        self.assertEqual(refreshed["name"], "Updated Rider")
        self.assertEqual(refreshed["rollNo"], "RA2026001")
        directory = server.request("GET", "/api/admin", headers=self.admin)[1]["partners"]
        self.assertEqual(next(row for row in directory if row["email"] == DETAILS["email"])["vehicle"], DETAILS["vehicle"])
        self.assertEqual(server.request("POST", "/api/admin/partners/remove", {"email": DETAILS["email"]}, self.admin)[0], 200)
        self.assertEqual(server.request("GET", "/api/partner/orders", headers=partner_headers)[0], 403)
        with closing_db(server) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM partner_details").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()

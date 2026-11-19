import sqlite3
import unittest

import support
from test_e2e_workflow import BOSS, Customer, Server


class SupportModule(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            CREATE TABLE orders (id TEXT PRIMARY KEY, token TEXT, status TEXT, details TEXT);
            CREATE TABLE order_owners (order_id TEXT PRIMARY KEY, email TEXT NOT NULL, order_number TEXT);
            CREATE TABLE audit (id INTEGER PRIMARY KEY, actor TEXT, action TEXT, order_id TEXT, created INTEGER);
            CREATE TABLE order_events (id INTEGER PRIMARY KEY, order_id TEXT, event TEXT, actor TEXT, from_status TEXT,
                                       to_status TEXT, created INTEGER);
            CREATE TABLE deliveries (order_id TEXT PRIMARY KEY, partner TEXT, nonce TEXT, expires INTEGER,
                                     attempts INTEGER DEFAULT 0, lat REAL, lng REAL, located_at INTEGER);
        """)
        self.db.executescript(support.SCHEMA)
        self.order = "a" * 32
        self.db.execute("INSERT INTO orders VALUES (?, 't', 'out_for_delivery', '{\"bill\": {\"total\": 9800}, \"items\": [{}]}')", (self.order,))
        self.db.execute("INSERT INTO order_owners VALUES (?, 'me@example.test', 'PB-1')", (self.order,))
        self.db.execute("INSERT INTO deliveries VALUES (?, 'rider-one', 'secret-nonce', 9999999999, 0, NULL, NULL, NULL)", (self.order,))

    def make(self, **extra):
        args = dict(email="me@example.test", category="delivery", subject="Runner is late", message="Waiting an hour.",
                    order_id=self.order)
        args.update(extra)
        return support.create_ticket(self.db, **args)

    def test_delivery_and_print_tickets_need_one_of_your_own_orders(self):
        with self.assertRaises(support.SupportError):
            self.make(order_id=None)
        with self.assertRaises(support.SupportError):
            self.make(email="someone-else@example.test")
        with self.assertRaises(support.SupportError):
            self.make(category="print_quality", order_id=None)
        self.make(category="account", order_id=None)       # other categories do not need an order

    def test_internal_notes_and_events_never_reach_the_customer(self):
        ident = self.make()
        support.staff_reply(self.db, ident, "admin@example.test", "Refund them if the rider confirms.", internal=True)
        support.staff_reply(self.db, ident, "admin@example.test", "Sorry, we are checking with the Bee Runner.")
        support.set_priority(self.db, ident, "admin@example.test", "high")
        seen = support.customer_ticket(self.db, ident, "me@example.test")
        text = " ".join(message["body"] for message in seen["messages"])
        self.assertNotIn("Refund them", text)
        self.assertNotIn("Priority changed", text)
        self.assertIn("checking with the Bee Runner", text)
        self.assertEqual([m["from"] for m in seen["messages"]], ["you", "support"])
        staff = support.staff_ticket(self.db, ident)
        self.assertEqual({m["kind"] for m in staff["messages"]}, {"customer", "agent", "internal", "event"})
        with self.assertRaises(support.NotFound):
            support.customer_ticket(self.db, ident, "intruder@example.test")

    def test_status_flow(self):
        ident = self.make()
        support.staff_reply(self.db, ident, "admin@example.test", "Looking into it.")
        self.assertEqual(support.staff_ticket(self.db, ident)["status"], "pending")      # waiting on the customer
        support.customer_reply(self.db, ident, "me@example.test", "Thanks, any news?")
        self.assertEqual(support.staff_ticket(self.db, ident)["status"], "open")
        support.set_status(self.db, ident, "admin@example.test", "closed")
        with self.assertRaises(support.SupportError):
            support.customer_reply(self.db, ident, "me@example.test", "Hello?")
        with self.assertRaises(support.SupportError):
            support.set_status(self.db, ident, "admin@example.test", "banana")

    def test_order_context_shows_otp_state_but_never_the_code(self):
        context = support.staff_ticket(self.db, self.make())["order"]
        self.assertEqual(context["status"], "out_for_delivery")
        self.assertEqual(context["delivery"]["otpState"], "active")
        self.assertEqual(context["delivery"]["beeRunner"], "Rider One")
        self.assertEqual(context["invoice"]["url"], f"/api/admin/orders/{self.order}/invoice")
        self.assertNotIn("secret-nonce", str(context))
        self.db.execute("UPDATE deliveries SET attempts=3")
        self.assertEqual(support.order_context(self.db, self.order)["delivery"]["otpState"], "locked")

    def test_assignment_only_to_admin_or_warehouse_staff(self):
        ident = self.make()
        support.assign(self.db, ident, "admin@example.test", "Boss@Example.test", {"boss@example.test"})
        self.assertEqual(support.staff_ticket(self.db, ident)["assignee"], "boss@example.test")
        with self.assertRaises(support.SupportError):
            support.assign(self.db, ident, "admin@example.test", "random@example.test", {"boss@example.test"})
        support.assign(self.db, ident, "admin@example.test", None, set())
        self.assertIsNone(support.staff_ticket(self.db, ident)["assignee"])

    def test_buzz_uses_the_same_function_and_keeps_its_summary(self):
        ident = self.make(source="buzz", ai_summary="Customer says the Bee Runner has not arrived after 60 minutes.")
        staff = support.staff_ticket(self.db, ident)
        self.assertEqual((staff["source"], staff["number"]), ("buzz", f"SP-{ident:05d}"))
        self.assertIn("Bee Runner", staff["aiSummary"])
        self.assertIn("Created by Buzz", [m["body"] for m in staff["messages"] if m["kind"] == "event"])
        self.assertEqual(len(support.customer_ticket(self.db, ident, "me@example.test")["messages"]), 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM sqlite_master WHERE name LIKE '%ticket%' AND type='table'").fetchone()[0], 1)

    def test_filters_and_open_ticket_limit(self):
        for number in range(support.MAX_OPEN_PER_CUSTOMER):
            self.make(subject=f"Problem number {number}", category="account", order_id=None)
        with self.assertRaises(support.SupportError):
            self.make(category="account", order_id=None)
        listing = support.staff_tickets(self.db, query="problem number 3")
        self.assertEqual([t["subject"] for t in listing["tickets"]], ["Problem number 3"])
        self.assertEqual(support.staff_tickets(self.db, status="active")["counts"]["open"], support.MAX_OPEN_PER_CUSTOMER)
        self.assertEqual(support.staff_tickets(self.db, category="delivery")["tickets"], [])


class SupportApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server()
        cls.admin = {"X-Staff-Key": cls.server.keys["admin"]}

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()

    def test_full_support_flow_over_http(self):
        ann, bob = Customer(self.server, "ann@example.test"), Customer(self.server, "bob@example.test")
        order = ann.order()
        ann.pay(order)
        self.assertEqual(self.server.request("GET", "/api/support/tickets")[0], 401)
        self.assertEqual(len(ann.get("/api/support/categories")[1]["categories"]), 5)
        # needs an order, and only your own
        self.assertEqual(ann.post("/api/support/tickets", {"category": "delivery", "subject": "Late", "message": "Where is it"})[0], 400)
        self.assertEqual(bob.post("/api/support/tickets", {"category": "print_quality", "subject": "Faded", "message": "Too light",
                                                           "orderId": order["id"]})[0], 400)
        status, made, _ = ann.post("/api/support/tickets", {"category": "print_quality", "subject": "Pages look faded",
                                                            "message": "Page 3 is too light.", "orderId": order["id"]})
        self.assertEqual(status, 200, made)
        ticket = made["ticket"]
        self.assertEqual(ticket["order"]["id"], order["id"])
        self.assertEqual(bob.get(f"/api/support/tickets/{ticket['id']}")[0], 404)
        self.assertEqual([t["id"] for t in ann.get("/api/support/tickets")[1]["tickets"]], [ticket["id"]])
        # a customer cannot reach the admin side
        self.assertEqual(ann.get("/api/admin/support/tickets")[0], 403)
        # admin: list, details with order context, invoice, internal note, reply, assign, status
        status, listing, _ = self.server.request("GET", "/api/admin/support/tickets?status=active", headers=self.admin)
        self.assertEqual((status, listing["tickets"][0]["customer"]), (200, "ann@example.test"))
        status, detail, _ = self.server.request("GET", f"/api/admin/support/tickets/{ticket['id']}", headers=self.admin)
        self.assertEqual(detail["ticket"]["order"]["status"], "paid")
        self.assertNotIn("code", detail["ticket"]["order"].get("delivery") or {})
        status, pdf, _ = self.server.request("GET", detail["ticket"]["order"]["invoice"]["url"], headers=self.admin, raw=True)
        self.assertEqual((status, pdf[:5]), (200, b"%PDF-"))
        base = f"/api/admin/support/tickets/{ticket['id']}"
        self.assertEqual(self.server.request("POST", base + "/note", {"message": "Check the printer toner log."}, self.admin)[0], 200)
        self.assertEqual(self.server.request("POST", base + "/reply", {"message": "Sorry about that, we will reprint it."}, self.admin)[0], 200)
        self.assertEqual(self.server.request("POST", base + "/priority", {"priority": "high"}, self.admin)[0], 200)
        self.assertEqual(self.server.request("POST", base + "/assign", {"assignee": BOSS}, self.admin)[0], 200)
        self.assertEqual(self.server.request("POST", base + "/assign", {"assignee": "stranger@example.test"}, self.admin)[0], 400)
        seen = ann.get(f"/api/support/tickets/{ticket['id']}")[1]["ticket"]
        self.assertEqual(seen["status"], "pending")
        self.assertNotIn("toner", str(seen))
        self.assertEqual([m["from"] for m in seen["messages"]], ["you", "support"])
        status, replied, _ = ann.post(f"/api/support/tickets/{ticket['id']}/reply", {"message": "Thank you!"})
        self.assertEqual((status, replied["ticket"]["status"]), (200, "open"))
        status, done, _ = ann.post(f"/api/support/tickets/{ticket['id']}/resolve")
        self.assertEqual((status, done["ticket"]["status"]), (200, "resolved"))
        status, final, _ = self.server.request("GET", base, headers=self.admin)
        self.assertEqual((final["ticket"]["priority"], final["ticket"]["assignee"]), ("high", BOSS))
        self.assertTrue(any(m["kind"] == "internal" for m in final["ticket"]["messages"]))


if __name__ == "__main__":
    unittest.main()

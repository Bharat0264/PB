import json
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


class SupportRules(SupportModule):
    """Same fixture, more rules: the status flow, rate limits, idempotency and attachments."""

    def test_valid_and_invalid_status_transitions(self):
        ident = self.make()
        move = lambda status: support.set_status(self.db, ident, "admin@example.test", status)
        status = lambda: support.staff_ticket(self.db, ident)["status"]
        move("in_progress"); self.assertEqual(status(), "in_progress")
        move("pending"); self.assertEqual(status(), "pending")
        move("resolved"); self.assertEqual(status(), "resolved")
        with self.assertRaises(support.SupportError):
            move("pending")                          # a resolved ticket can't wait on the customer again
        move("closed"); self.assertEqual(status(), "closed")
        for blocked in ("resolved", "pending", "in_progress"):
            with self.assertRaises(support.SupportError):
                move(blocked)                        # closed tickets can only be reopened
        move("open"); self.assertEqual(status(), "open")

    def test_assigning_starts_work_and_customer_reply_goes_back_to_the_agent(self):
        ident = self.make()
        support.assign(self.db, ident, "admin@example.test", "boss@example.test", {"boss@example.test"})
        self.assertEqual(support.staff_ticket(self.db, ident)["status"], "in_progress")
        support.staff_reply(self.db, ident, "boss@example.test", "Can you send a photo?")
        self.assertEqual(support.staff_ticket(self.db, ident)["status"], "pending")
        support.customer_reply(self.db, ident, "me@example.test", "Here it is.")
        self.assertEqual(support.staff_ticket(self.db, ident)["status"], "in_progress")

    def test_rate_limits_per_user_and_per_ip(self):
        for _ in range(5):
            support.check_rate(self.db, "ticket", "me@example.test", "1.1.1.1", now=1000)
            support.record_rate(self.db, "ticket", "me@example.test", "1.1.1.1", now=1000)
        with self.assertRaises(support.RateLimited):
            support.check_rate(self.db, "ticket", "me@example.test", "9.9.9.9", now=1500)     # same user, other address
        support.check_rate(self.db, "ticket", "other@example.test", "9.9.9.9", now=1500)       # a different person is fine
        for number in range(5):                                                               # many people behind one IP
            support.record_rate(self.db, "ticket", f"user{number}@example.test", "1.1.1.1", now=1000)
        with self.assertRaises(support.RateLimited):
            support.check_rate(self.db, "ticket", "fresh@example.test", "1.1.1.1", now=1500)
        support.check_rate(self.db, "ticket", "me@example.test", "1.1.1.1", now=1000 + 3601)   # the window has passed

    def test_idempotency_key_stops_a_double_submit(self):
        made = []
        run = lambda: made.append(self.make()) or {"ticket": made[-1]}
        first = support.idempotent(self.db, "me|/tickets", "0123456789abcdef-key", run)
        second = support.idempotent(self.db, "me|/tickets", "0123456789abcdef-key", run)
        self.assertEqual((first, second, len(made)), ({"ticket": made[0]}, {"ticket": made[0]}, 1))
        self.assertEqual(self.db.execute("SELECT count(*) FROM support_tickets").fetchone()[0], 1)
        support.idempotent(self.db, "me|/tickets", "a-different-key-0123456", run)         # a new key is a new request
        self.assertEqual(len(made), 2)
        support.idempotent(self.db, "me|/tickets", None, run); support.idempotent(self.db, "me|/tickets", "short", run)
        self.assertEqual(len(made), 4)                                                    # no/invalid key: no protection

    def test_attachments_are_checked_by_content_and_named_safely(self):
        ident = self.make()
        message = support.customer_ticket(self.db, ident, "me@example.test")["messages"][0]["id"]
        add = lambda name, body, who="me@example.test": support.add_attachment(self.db, ident, message, who, name, body)
        backslash, newline = chr(92), chr(10).encode()
        pdf = b"%PDF-1.4" + newline + b"x" * 100
        jpeg = bytes([0xFF, 0xD8, 0xFF, 0xE0]) + b"0" * 50
        png = bytes([0x89]) + b"PNG" + bytes([13, 10, 26, 10]) + b"0" * 50
        windows_exe = b"MZ" + bytes([0x90, 0]) + b"0" * 50
        saved = add(backslash * 2 + ".." + backslash + "my <b>file</b>.exe", pdf)      # a lying name: the content says PDF
        self.assertEqual(saved["type"], "application/pdf")
        self.assertTrue(saved["name"].endswith(".pdf") and not set(saved["name"]) & set("/<>" + backslash), saved["name"])
        self.assertEqual(support.safe_filename("Class notes (week 3).JPG", "jpg"), "Class notes (week 3).jpg")
        self.assertEqual(add("photo.pdf", jpeg)["type"], "image/jpeg")
        self.assertEqual(add("shot.jpg", png)["name"], "shot.png")
        for bad in (b"<html><script>alert(1)</script></html>", windows_exe, b"GIF89a" + b"0" * 50, b""):
            with self.assertRaises(support.SupportError):
                add("evil.pdf", bad)
        with self.assertRaises(support.SupportError):
            add("big.pdf", b"%PDF-" + b"0" * support.MAX_FILE_BYTES)             # over 10 MB
        with self.assertRaises(support.SupportError):
            add("a.pdf", pdf, who="intruder@example.test")                       # not your message
        add("four.pdf", pdf); add("five.pdf", pdf)                                  # five in total now
        with self.assertRaises(support.SupportError):
            add("six.pdf", pdf)
        shown = support.customer_ticket(self.db, ident, "me@example.test")["messages"][0]["attachments"]
        self.assertEqual(len(shown), 5)
        with self.assertRaises(support.NotFound):
            support.attachment_for_customer(self.db, shown[0]["id"], "intruder@example.test")
        self.assertEqual(support.attachment_for_customer(self.db, shown[0]["id"], "me@example.test")["content_type"], "application/pdf")


class SupportInbox(SupportModule):
    """What the admin inbox needs: counts, new badge, sorting, pagination, previews and allowed next statuses."""

    def fill(self, count):
        ids = []
        for number in range(count):
            email = f"user{number}@example.test"
            ids.append(support.create_ticket(self.db, email=email, category="account", subject=f"Question number {number:02d}",
                                             message=f"Please help with item {number}."))
        return ids

    def test_new_badge_counts_open_unassigned_tickets_only(self):
        ids = self.fill(4)
        self.assertEqual(support.staff_tickets(self.db)["new"], 4)
        support.assign(self.db, ids[0], "admin@example.test", "boss@example.test", {"boss@example.test"})   # picked up
        support.set_status(self.db, ids[1], "admin@example.test", "pending")
        listing = support.staff_tickets(self.db, status="closed")
        self.assertEqual((listing["new"], listing["total"]), (2, 0))     # the badge ignores the current filter
        self.assertEqual(support.staff_tickets(self.db)["counts"], {"open": 2, "in_progress": 1, "pending": 1, "resolved": 0, "closed": 0})

    def test_pagination_sorting_and_totals(self):
        ids = self.fill(7)
        first = support.staff_tickets(self.db, limit=3, offset=0, sort="oldest")
        second = support.staff_tickets(self.db, limit=3, offset=3, sort="oldest")
        last = support.staff_tickets(self.db, limit=3, offset=6, sort="oldest")
        self.assertEqual((first["total"], len(first["tickets"]), len(second["tickets"]), len(last["tickets"])), (7, 3, 3, 1))
        self.assertEqual([t["id"] for t in first["tickets"] + second["tickets"] + last["tickets"]], ids)
        self.assertEqual([t["id"] for t in support.staff_tickets(self.db, limit=2, sort="newest")["tickets"]], [ids[-1], ids[-2]])
        support.set_priority(self.db, ids[2], "admin@example.test", "urgent")
        self.assertEqual(support.staff_tickets(self.db, sort="priority")["tickets"][0]["id"], ids[2])
        self.assertEqual(support.staff_tickets(self.db, query="number 05")["total"], 1)
        self.assertEqual(support.staff_tickets(self.db, query="user3@")["tickets"][0]["customer"], "user3@example.test")
        self.assertEqual(support.staff_tickets(self.db, sort="nonsense", limit=500)["limit"], 100)    # bad input is tamed

    def test_preview_and_next_statuses(self):
        ident = self.fill(1)[0]
        support.staff_reply(self.db, ident, "admin@example.test", "Internal only text.", internal=True)
        self.assertEqual(support.staff_tickets(self.db)["tickets"][0]["preview"], "Please help with item 0.")   # never an internal note
        self.assertEqual(support.staff_ticket(self.db, ident)["nextStatuses"], ["in_progress", "pending", "resolved", "closed"])
        support.set_status(self.db, ident, "admin@example.test", "closed")
        self.assertEqual(support.staff_ticket(self.db, ident)["nextStatuses"], ["open"])


class SupportStorage(SupportModule):
    class FakeStorage:
        """Stands in for the S3 private bucket: same put_support / read interface as order_documents.PrivateFiles."""
        errors = (OSError,)

        def __init__(self):
            self.objects = {}

        def put_support(self, ticket_id, attachment_id, body):
            key = f"printbee/support/{ticket_id}/{attachment_id}/fake"
            self.objects[key] = bytes(body)
            return key

        def read(self, key):
            return self.objects[key]

    def test_with_storage_configured_the_file_goes_to_the_bucket_not_the_database(self):
        storage = self.FakeStorage()
        ident = self.make()
        message = support.customer_ticket(self.db, ident, "me@example.test")["messages"][0]["id"]
        pdf = b"%PDF-1.4" + bytes([10]) + b"x" * 64
        saved = support.add_attachment(self.db, ident, message, "me@example.test", "scan.pdf", pdf, storage)
        row = support.attachment_for_customer(self.db, saved["id"], "me@example.test")
        self.assertIsNone(row["content"])
        self.assertTrue(row["object_key"].startswith(f"printbee/support/{ident}/{saved['id']}/"))
        self.assertEqual(storage.read(row["object_key"]), pdf)


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
        self.assertEqual((status, replied["ticket"]["status"]), (200, "in_progress"))   # assigned, so it goes back to its agent
        status, done, _ = ann.post(f"/api/support/tickets/{ticket['id']}/resolve")
        self.assertEqual((status, done["ticket"]["status"]), (200, "resolved"))
        status, final, _ = self.server.request("GET", base, headers=self.admin)
        self.assertEqual((final["ticket"]["priority"], final["ticket"]["assignee"]), ("high", BOSS))
        self.assertTrue(any(m["kind"] == "internal" for m in final["ticket"]["messages"]))

    def test_http_idempotency_attachments_and_rate_limit(self):
        cat = Customer(self.server, "cat@example.test")
        dog = Customer(self.server, "dog@example.test")
        body = {"category": "account", "subject": "Cannot sign in", "message": "The link never arrives."}
        key = {"Idempotency-Key": "double-click-key-0001"}
        first = cat.post("/api/support/tickets", body, **key)
        again = cat.post("/api/support/tickets", body, **key)         # the double click
        self.assertEqual((first[0], again[0]), (200, 200))
        self.assertEqual(first[1]["ticket"]["id"], again[1]["ticket"]["id"])
        self.assertEqual(len(cat.get("/api/support/tickets")[1]["tickets"]), 1)
        ticket = first[1]["ticket"]
        message = ticket["messages"][0]["id"]
        upload = f"/api/support/tickets/{ticket['id']}/messages/{message}/attachments"
        pdf = b"%PDF-1.4" + bytes([10]) + b"x" * 200
        status, saved, _ = cat.post(upload, pdf, **{"X-Filename": "My%20receipt.PDF", "Content-Type": "application/pdf"})
        self.assertEqual((status, saved["attachment"]["name"], saved["attachment"]["type"]), (200, "My receipt.pdf", "application/pdf"))
        # a file that only pretends to be a PDF is refused, and so is a stranger uploading to this message
        self.assertEqual(cat.post(upload, b"<html>hi</html>", **{"X-Filename": "x.pdf", "Content-Type": "application/pdf"})[0], 400)
        self.assertEqual(dog.post(upload, pdf, **{"X-Filename": "x.pdf", "Content-Type": "application/pdf"})[0], 404)
        listed = cat.get(f"/api/support/tickets/{ticket['id']}")[1]["ticket"]["messages"][0]["attachments"]
        self.assertEqual(len(listed), 1)
        # downloads: owner and admin only, always as an attachment with the verified type
        status, content, headers = cat.get(f"/api/support/attachments/{listed[0]['id']}")
        sent = {name.lower(): value for name, value in headers}
        self.assertEqual((status, content[:5]), (200, b"%PDF-"))
        self.assertEqual(sent["content-type"], "application/pdf")
        self.assertTrue(sent["content-disposition"].startswith("attachment;"))
        self.assertEqual(sent["x-content-type-options"], "nosniff")
        self.assertEqual(dog.get(f"/api/support/attachments/{listed[0]['id']}")[0], 404)
        self.assertEqual(self.server.request("GET", f"/api/support/attachments/{listed[0]['id']}")[0], 401)
        self.assertEqual(self.server.request("GET", f"/api/admin/support/attachments/{listed[0]['id']}", headers=self.admin, raw=True)[0], 200)
        self.assertEqual(dog.get(f"/api/admin/support/attachments/{listed[0]['id']}")[0], 403)
        # too many messages in a few minutes
        reply = f"/api/support/tickets/{ticket['id']}/reply"
        codes = [cat.post(reply, {"message": f"Hello number {n}"})[0] for n in range(23)]
        self.assertEqual(codes[:20], [200] * 20)
        self.assertEqual(set(codes[20:]), {429})


    def test_admin_inbox_listing_over_http(self):
        people = [Customer(self.server, f"inbox{n}@example.test") for n in range(3)]
        for number, person in enumerate(people):
            status, made, _ = person.post("/api/support/tickets", {"category": "other", "subject": f"Inbox ticket {number}", "message": "Hello there."})
            self.assertEqual(status, 200, made)
        status, agents, _ = self.server.request("GET", "/api/admin/support/agents", headers=self.admin)
        self.assertEqual(status, 200)
        self.assertIn(BOSS, agents["agents"])
        self.assertEqual(set(agents["statuses"]), {"open", "in_progress", "pending", "resolved", "closed"})
        status, page, _ = self.server.request("GET", "/api/admin/support/tickets?sort=newest&limit=2&q=inbox%20ticket", headers=self.admin)
        self.assertEqual((status, page["limit"], len(page["tickets"])), (200, 2, 2))
        self.assertEqual(page["total"], 3)
        self.assertGreaterEqual(page["new"], 3)
        self.assertEqual(page["tickets"][0]["subject"], "Inbox ticket 2")
        self.assertEqual(page["tickets"][0]["preview"], "Hello there.")
        status, second, _ = self.server.request("GET", "/api/admin/support/tickets?sort=newest&limit=2&offset=2&q=inbox%20ticket", headers=self.admin)
        self.assertEqual([t["subject"] for t in second["tickets"]], ["Inbox ticket 0"])
        self.assertEqual(people[0].get("/api/admin/support/agents")[0], 403)

    def test_customer_b_cannot_reach_customer_a_by_changing_ids(self):
        ann = Customer(self.server, "ann2@example.test")
        bea = Customer(self.server, "bea2@example.test")
        status, made, _ = ann.post("/api/support/tickets", {"category": "account", "subject": "Private matter", "message": "My phone number is 98765 43210."})
        self.assertEqual(status, 200, made)
        ticket = made["ticket"]
        pdf = b"%PDF-1.4" + bytes([10]) + b"secret contents " * 10
        status, saved, _ = ann.post(f"/api/support/tickets/{ticket['id']}/messages/{ticket['messages'][0]['id']}/attachments", pdf,
                                    **{"X-Filename": "id-card.pdf", "Content-Type": "application/pdf"})
        self.assertEqual(status, 200, saved)
        attachment = saved["attachment"]["id"]
        missing = 99999       # an id that does not exist: the answer for A's real ids must look exactly the same
        probes = []
        for ident in (ticket["id"], missing):
            probes += [
                ("GET ticket", bea.get(f"/api/support/tickets/{ident}")),
                ("POST reply", bea.post(f"/api/support/tickets/{ident}/reply", {"message": "I am not the owner"})),
                ("POST resolve", bea.post(f"/api/support/tickets/{ident}/resolve")),
                ("GET attachment", bea.get(f"/api/support/attachments/{attachment if ident == ticket['id'] else missing}")),
                ("POST upload", bea.post(f"/api/support/tickets/{ident}/messages/{ticket['messages'][0]['id']}/attachments", pdf,
                                         **{"X-Filename": "x.pdf", "Content-Type": "application/pdf"})),
            ]
        real, fake = probes[:5], probes[5:]
        for (label, answer), (_, baseline) in zip(real, fake):
            self.assertEqual(answer[0], 404, label)
            self.assertEqual(answer[1], baseline[1], label + " must not reveal that the ticket exists")
            for secret in ("Private matter", "98765", "id-card", "secret contents", "ann2@example.test"):
                self.assertNotIn(secret, json.dumps(answer[1]) if isinstance(answer[1], (dict, list)) else str(answer[1]), label)
        # nothing was changed by the stranger's attempts, and the owner still sees her own ticket and file
        owner_view = ann.get(f"/api/support/tickets/{ticket['id']}")[1]["ticket"]
        self.assertEqual((owner_view["status"], len(owner_view["messages"])), ("open", 1))
        self.assertEqual(ann.get(f"/api/support/attachments/{attachment}")[0], 200)
        self.assertEqual(bea.get("/api/support/tickets")[1]["tickets"], [])
        # a stranger's id sweep finds nothing at all
        sweep = {bea.get(f"/api/support/tickets/{number}")[0] for number in range(1, 40)}
        sweep |= {bea.get(f"/api/support/attachments/{number}")[0] for number in range(1, 40)}
        self.assertEqual(sweep, {404})
        # signed out: 401, and a customer on the admin routes: 403
        self.assertEqual(self.server.request("GET", f"/api/support/tickets/{ticket['id']}")[0], 401)
        self.assertEqual(self.server.request("GET", f"/api/support/attachments/{attachment}")[0], 401)
        self.assertEqual(bea.get(f"/api/admin/support/tickets/{ticket['id']}")[0], 403)
        self.assertEqual(bea.get(f"/api/admin/support/attachments/{attachment}")[0], 403)


class SupportEmail(unittest.TestCase):
    def test_email_says_there_is_a_reply_but_never_includes_it(self):
        import support_notify
        subject, text = support_notify.build_message({"id": 7, "ticket_number": "SP-00007", "subject": "Faded pages"},
                                                     "https://printbee.example")
        self.assertIn("SP-00007", subject)
        self.assertIn("https://printbee.example/help.html#/ticket/7", text)
        self.assertIn("not included", text)


if __name__ == "__main__":
    unittest.main()

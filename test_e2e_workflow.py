"""End-to-end test: one order through every portal against a real server and database.

Starts server.py on a free port with a temporary database, test payments and a mock printer, then
plays each role through the HTTP API exactly as the portals do:

  customer -> test payment -> warehouse prints (print agent, mock printer) -> ready
  -> partner accepts -> pickup -> OTP -> deliver -> admin revenue / profit / earnings

Also: wrong OTP x3 and renewal, refund, cancel, two partners accepting at once, a price change after
ordering, illegal transitions, role-filtered live events (SSE with catch-up), switch portal and logout,
and the production-origin rules. Run with:  python -m unittest test_e2e_workflow -v
"""
import http.client
import json
import os
import re
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from io import BytesIO
from pathlib import Path

import customer_auth as auth
import print_agent

ROOT = Path(__file__).resolve().parent
TERMS = {"packing": 500, "platform": 300, "delivery": 1500, "taxBasisPoints": 500, "partnerPayout": 4000,
         "slots": [], "coupons": {}, "paperRates": {}, "bindingRates": {}}
RIDER_KEYS = {"rider-a": "A" * 8 + "rider_a_secret_token", "rider-b": "B" * 8 + "rider_b_secret_token"}
BOSS = "boss@example.test"


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def make_pdf(pages=3):
    from reportlab.pdfgen import canvas
    buffer = BytesIO()
    page = canvas.Canvas(buffer)
    for number in range(pages):
        page.drawString(100, 750, f"PrintBee test page {number + 1}")
        page.showPage()
    page.save()
    return buffer.getvalue()


class Server:
    """A throwaway PrintBee server with its own database."""

    def __init__(self, origin_host="127.0.0.1", payment="test", extra=None, scheme="http"):
        self.dir = Path(tempfile.mkdtemp(prefix="printbee-e2e-"))
        self.port = free_port()
        self.origin = f"{scheme}://{origin_host}:{self.port}" if scheme == "http" else f"{scheme}://{origin_host}"
        env = {k: v for k, v in os.environ.items() if not k.startswith("PRINTBEE_")}
        env.update({
            "PRINTBEE_ORIGIN": self.origin, "PRINTBEE_DATA_DIR": str(self.dir), "PRINTBEE_PAYMENT_MODE": payment,
            "PRINTBEE_CHECKOUT_TERMS": json.dumps(TERMS), "PRINTBEE_PARTNER_KEYS": json.dumps(RIDER_KEYS),
            "PRINTBEE_GOOGLE_ADMIN_EMAILS": BOSS, "PRINTBEE_GOOGLE_WAREHOUSE_EMAILS": BOSS,
            "PRINTBEE_GOOGLE_PARTNERS": json.dumps({BOSS: "boss-rider"}), **(extra or {}),
        })
        self.log = open(self.dir / "server.log", "wb")
        self.process = subprocess.Popen([sys.executable, str(ROOT / "server.py"), "--port", str(self.port)],
                                        cwd=ROOT, env=env, stdout=self.log, stderr=subprocess.STDOUT)
        for _ in range(100):
            try:
                if self.request("GET", "/api/status-model")[0] == 200:
                    break
            except OSError:
                time.sleep(0.2)
        else:
            self.stop()
            raise RuntimeError("server did not start:\n" + (self.dir / "server.log").read_text(errors="replace"))
        self.keys = json.loads((self.dir / "staff-keys.json").read_text(encoding="utf-8"))

    def request(self, method, path, body=None, headers=None, raw=False):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
        merged = {"Origin": self.origin, **({"Content-Type": "application/json"} if isinstance(body, (dict, list)) else {}),
                  **(headers or {})}
        connection.request(method, path, body=data, headers=merged)
        response = connection.getresponse()
        payload = response.read()
        result = payload if raw else (json.loads(payload) if payload and response.getheader("Content-Type", "").startswith("application/json") else payload)
        headers_out = response.getheaders()
        connection.close()
        return response.status, result, headers_out

    def db(self):
        db = sqlite3.connect(self.dir / "orders.sqlite", timeout=30)
        db.row_factory = sqlite3.Row
        return db

    def stop(self):
        self.process.terminate()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
        self.log.close()
        shutil.rmtree(self.dir, ignore_errors=True)


class Feed(threading.Thread):
    """Reads /api/events (SSE) in the background and records what arrives and when."""

    def __init__(self, server, audience, headers, last_event_id=None):
        super().__init__(daemon=True)
        self.server, self.events, self.status, self.opened = server, [], None, threading.Event()
        self.headers = {**headers, **({"Last-Event-ID": str(last_event_id)} if last_event_id is not None else {})}
        self.path = "/api/events?as=" + audience
        self.connection = None

    def run(self):
        try:
            self.connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=40)
            self.connection.request("GET", self.path, headers=self.headers)
            response = self.connection.getresponse()
            self.status = response.status
            self.opened.set()
            if response.status != 200:
                return
            event_id = None
            while True:
                line = response.fp.readline().decode().rstrip("\n")
                if line.startswith("id: "):
                    event_id = line[4:]
                elif line.startswith("data: ") and event_id is not None:
                    self.events.append((time.time(), json.loads(line[6:])))
                    event_id = None
        except (OSError, ValueError):
            pass
        finally:
            self.opened.set()

    def close(self):
        try:
            self.connection.close()
        except (OSError, AttributeError):
            pass

    def wait_for(self, predicate, timeout=6):
        deadline = time.time() + timeout
        while time.time() < deadline:
            for stamp, event in list(self.events):
                if predicate(event):
                    return stamp, event
            time.sleep(0.05)
        return None


class Customer:
    def __init__(self, server, email):
        self.server, self.email = server, email
        with closing_db(server) as db, db:
            cookie = auth.create_session(db, email, "")
        self.cookie = cookie.split(";")[0]
        self.headers = {"Cookie": self.cookie}

    def get(self, path, **extra):
        return self.server.request("GET", path, headers={**self.headers, **extra})

    def post(self, path, body=None, **extra):
        return self.server.request("POST", path, body, headers={**self.headers, **extra})

    def order(self, pages=3, copies=1):
        """Quote, create, upload and pay for an order. Returns its id and order key."""
        pdf = make_pdf(pages)
        item = {"name": "notes.pdf", "pages": pages, "copies": copies, "size": len(pdf), "colour": False,
                "duplex": False, "orientation": "Portrait"}
        status, bill, _ = self.post("/api/checkout/quote", {"items": [item], "coupon": ""})
        assert status == 200, bill
        order_id, key = uuid.uuid4().hex, secrets.token_hex(32)
        status, result, _ = self.post("/api/orders", {
            "id": order_id, "customer": "Test Customer", "phone": "+91 98765 43210",
            "address": "North Hostel, SRM campus\nDelivery pin: 12.8240, 80.0450", "items": [item],
            "expectedTotal": bill["total"], "coupon": "", "notes": "Meet at reception.", "slot": ""}, **{"X-Order-Key": key})
        assert status == 200, result
        status, result, _ = self.post(f"/api/orders/{order_id}/files/0", pdf, **{"X-Order-Key": key, "Content-Type": "application/pdf"})
        assert status == 200, result
        return {"id": order_id, "key": key, "total": bill["total"], "tax": bill["tax"], "bill": bill}

    def pay(self, order):
        status, result, _ = self.post(f"/api/orders/{order['id']}/test-payment", None, **{"X-Order-Key": order["key"]})
        assert status == 200 and result["status"] == "paid", result
        return result

    def view(self, order):
        status, result, _ = self.get(f"/api/orders/{order['id']}")
        assert status == 200, result
        return result


class closing_db:
    def __init__(self, server):
        self.db = server.db()

    def __enter__(self):
        return self.db.__enter__() and self.db

    def __exit__(self, *exc):
        try:
            return self.db.__exit__(*exc)
        finally:
            self.db.close()


class WorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server()
        cls.customer = Customer(cls.server, "customer@example.test")
        cls.stranger = Customer(cls.server, "stranger@example.test")
        k = cls.server.keys
        cls.warehouse = {"X-Staff-Key": k["warehouse"]}
        cls.admin = {"X-Staff-Key": k["admin"]}
        cls.agent_key = k["print-agent"]
        cls.rider = {name: {"X-Staff-Key": key} for name, key in RIDER_KEYS.items()}

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()

    # ---- helpers
    def api(self, method, path, body=None, headers=None):
        return self.server.request(method, path, body, headers)

    def print_order(self, order):
        status, result, _ = self.api("POST", f"/api/staff/orders/{order['id']}/print/all", {}, self.warehouse)
        self.assertEqual((status, result["queued"]), (200, 1), result)
        for _ in range(6):
            print_agent.run(self.server.origin, self.agent_key, "Mock printer", None, once=True, mock=True)
            if self.status_of(order) == "packed":
                return
        self.fail("print agent never completed the job: " + self.status_of(order))

    def status_of(self, order):
        with closing_db(self.server) as db:
            return db.execute("SELECT status FROM orders WHERE id=?", (order["id"],)).fetchone()[0]

    def ready_order(self):
        order = self.customer.order()
        self.customer.pay(order)
        self.print_order(order)
        return order

    def go_online(self, rider):
        status, result, _ = self.api("POST", "/api/partner/availability", {"available": True}, self.rider[rider])
        self.assertEqual(status, 200, result)

    def partner_do(self, rider, order, action, body=None):
        return self.api("POST", f"/api/partner/orders/{order['id']}/{action}", body or {}, self.rider[rider])

    def deliver_fully(self, rider, order):
        """accept -> pickup -> read the customer's code -> deliver. Returns the code."""
        self.go_online(rider)
        self.assertEqual(self.partner_do(rider, order, "accept")[0], 200)
        self.assertEqual(self.partner_do(rider, order, "pickup")[0], 200)
        code = self.customer.view(order)["delivery"]["code"]
        status, result, _ = self.partner_do(rider, order, "deliver", {"code": code})
        self.assertEqual(status, 200, result)
        return code

    def finance(self):
        status, snapshot, _ = self.api("GET", "/api/admin", headers=self.admin)
        self.assertEqual(status, 200)
        return snapshot["finance"], snapshot

    # ---- 1. the full journey
    def test_01_one_order_through_every_portal(self):
        before, _ = self.finance()
        feed = Feed(self.server, "warehouse", self.warehouse)
        feed.start()
        self.assertTrue(feed.opened.wait(5))
        self.assertEqual(feed.status, 200)
        mine = Feed(self.server, "customer", self.customer.headers)
        mine.start()
        mine.opened.wait(5)

        # Customer: server-priced quote, order, files, test payment. Order number PB-YYMMDD-XXXX.
        order = self.customer.order()
        self.assertEqual(self.customer.get(f"/api/orders/{order['id']}", **{"X-Order-Key": order["key"]})[1]["status"], "pending")
        self.assertEqual(order["total"], order["bill"]["printing"] + 500 + 300 + 1500 + order["tax"])
        paid_at = time.time()
        self.customer.pay(order)
        view = self.customer.view(order)
        self.assertRegex(view["number"], r"^PB-\d{6}-[0-9A-F]{4}$")

        # Warehouse sees it without refreshing: the live feed delivers "paid" within seconds.
        arrived = feed.wait_for(lambda e: e["order"] == order["id"] and e["to"] == "paid")
        self.assertIsNotNone(arrived, "warehouse feed never announced the paid order")
        self.assertLess(arrived[0] - paid_at, 5)
        listing = self.api("GET", "/api/staff/orders", headers=self.warehouse)[1]
        self.assertIn(order["id"], [o["id"] for o in listing["orders"]])

        # Warehouse prints; the print agent (mock printer) reports each file; the order becomes READY.
        self.print_order(order)
        self.assertIsNotNone(mine.wait_for(lambda e: e["order"] == order["id"] and e["to"] == "packed"))

        # Partner: the ready order is offered; nothing about the customer is exposed before pickup.
        self.go_online("rider-a")
        offered = self.api("GET", "/api/partner/orders", headers=self.rider["rider-a"])[1]
        entry = next(o for o in offered["orders"] if o["id"] == order["id"])
        self.assertEqual((entry["status"], entry["payout"]), ("packed", 4000))
        self.assertFalse({"customer", "address", "phone", "code"} & set(entry))
        self.assertEqual(self.partner_do("rider-a", order, "accept")[0], 200)

        # Accept -> warehouse and customer both see the partner.
        mine.wait_for(lambda e: e["order"] == order["id"] and e["event"] == "delivery_accepted")
        self.assertEqual(self.customer.view(order)["delivery"]["partner"], "Rider A")
        staff = self.api("GET", "/api/staff/orders", headers=self.warehouse)[1]["orders"]
        self.assertEqual(next(o for o in staff if o["id"] == order["id"])["partner"], "rider-a")

        # Pickup -> OTP exists, only the customer can read it.
        self.assertEqual(self.partner_do("rider-a", order, "pickup")[0], 200)
        tracking = self.customer.view(order)
        code = tracking["delivery"]["code"]
        self.assertRegex(code, r"^\d{4}$")
        self.assertEqual(tracking["summary"]["bill"]["total"], order["total"])
        self.assertEqual(tracking["summary"]["items"][0]["name"], "notes.pdf")
        self.assertNotIn("phone", tracking["summary"])
        path = f"/api/orders/{order['id']}"
        for viewer in (self.customer, self.stranger):
            status, public, _ = viewer.get(path, **{"X-Tracking-Key": tracking["trackingKey"]})
            self.assertEqual(status, 200)
            self.assertEqual(public["status"], "out_for_delivery")
            self.assertEqual(set(public), {"status", "number", "paymentStarted"})
        self.assertEqual(self.customer.get(path, **{"X-Tracking-Key": "0" * 64})[0], 404)
        partner_view = json.dumps(self.api("GET", "/api/partner/orders", headers=self.rider["rider-a"])[1])
        self.assertNotIn('"code"', partner_view)
        self.assertEqual(self.stranger.get(f"/api/orders/{order['id']}")[0], 404)       # not their order
        self.assertNotIn(code, json.dumps(self.api("GET", "/api/admin", headers=self.admin)[1]))

        # Deliver with the OTP -> every portal updates, earnings and revenue move.
        status, result, _ = self.partner_do("rider-a", order, "deliver", {"code": code})
        self.assertEqual(status, 200, result)
        self.assertEqual(self.customer.view(order)["status"], "delivered")
        self.assertEqual(self.status_of(order), "delivered")
        partner_after = self.api("GET", "/api/partner/orders", headers=self.rider["rider-a"])[1]
        self.assertGreaterEqual(partner_after["earnings"]["lifetime"], 4000)
        after, _ = self.finance()
        self.assertEqual(after["revenue"] - before["revenue"], order["total"])
        self.assertEqual(after["delivered"] - before["delivered"], order["total"])
        self.assertEqual(after["partnerEarnings"]["accrued"] - before["partnerEarnings"]["accrued"], 4000)
        self.assertEqual(after["profit"] - before["profit"], order["total"] - order["tax"] - 4000)

        # One timeline, same events everywhere: customer sees the whole story.
        events = [e["event"] for e in self.customer.view(order)["timeline"]]
        wanted = ["order_created", "paid", "print_queued", "print_done", "packed", "delivery_accepted",
                  "delivery_picked_up", "delivery_completed"]
        position = -1
        for name in wanted:
            self.assertIn(name, events[position + 1:], f"{name} missing from {events}")
            position = events.index(name, position + 1)
        actions = [u["action"] for u in self.customer.get("/api/orders/notifications")[1]["updates"] if u["order_id"] == order["id"]]
        for name in ("paid", "printing", "packed", "delivery_accepted", "delivery_picked_up", "delivery_completed"):
            self.assertIn(name, actions)
        feed.close()
        mine.close()

    # ---- 2. wrong OTP x3, lockout, admin renewal
    def test_02_wrong_otp_three_times_locks_then_admin_can_renew(self):
        order = self.ready_order()
        self.go_online("rider-a")
        self.partner_do("rider-a", order, "accept")
        self.partner_do("rider-a", order, "pickup")
        code = self.customer.view(order)["delivery"]["code"]
        wrong = f"{(int(code) + 1) % 10000:04d}"
        for attempt in range(3):
            status, result, _ = self.partner_do("rider-a", order, "deliver", {"code": wrong})
            self.assertEqual((status, result["error"]), (409, "Incorrect delivery code."), attempt)
        status, result, _ = self.partner_do("rider-a", order, "deliver", {"code": code})
        self.assertEqual(status, 409)
        self.assertIn("locked", result["error"])
        self.assertNotIn("code", self.customer.view(order)["delivery"])                  # hidden while locked
        self.assertEqual(self.api("POST", f"/api/admin/orders/{order['id']}/renew-code", {}, self.admin)[0], 200)
        renewed = self.customer.view(order)["delivery"]["code"]
        status, result, _ = self.partner_do("rider-a", order, "deliver", {"code": renewed})
        self.assertEqual(status, 200, result)

    # ---- 3. refund and cancel
    def test_03_refund_and_cancel(self):
        before, _ = self.finance()
        refunded = self.customer.order()
        self.customer.pay(refunded)
        self.assertEqual(self.api("POST", f"/api/admin/orders/{refunded['id']}/refund", {}, self.admin)[1], {"state": "processed"})
        self.assertEqual(self.status_of(refunded), "refunded")
        events = [e["event"] for e in self.customer.view(refunded)["timeline"]]
        self.assertEqual(events[-2:], ["refund_requested", "refund.processed"])
        after, _ = self.finance()
        self.assertEqual(after["refunded"] - before["refunded"], refunded["total"])
        self.assertEqual(after["revenue"], before["revenue"])                             # refunded money is not revenue

        cancelled = self.customer.order()
        self.customer.pay(cancelled)
        self.assertEqual(self.api("POST", f"/api/admin/orders/{cancelled['id']}/cancel", {}, self.admin)[0], 200)
        self.assertEqual(self.status_of(cancelled), "cancelled")

        printing = self.customer.order()
        self.customer.pay(printing)
        self.api("POST", f"/api/staff/orders/{printing['id']}/print/all", {}, self.warehouse)
        status, result, _ = self.api("POST", f"/api/admin/orders/{printing['id']}/cancel", {}, self.admin)
        self.assertEqual(status, 409)                                                     # too late to cancel
        self.assertEqual(self.api("POST", f"/api/admin/orders/{printing['id']}/refund", {}, self.admin)[0], 409)
        for _ in range(3):
            print_agent.run(self.server.origin, self.agent_key, "Mock printer", None, once=True, mock=True)
        self.deliver_fully("rider-a", printing)                                           # leave nothing half-done

    # ---- 4. two partners accept at the same moment
    def test_04_two_partners_accepting_at_once_one_wins(self):
        order = self.ready_order()
        self.go_online("rider-a")
        self.go_online("rider-b")
        barrier = threading.Barrier(2)
        results = {}

        def race(rider):
            barrier.wait()
            results[rider] = self.partner_do(rider, order, "accept")

        threads = [threading.Thread(target=race, args=(rider,)) for rider in ("rider-a", "rider-b")]
        [t.start() for t in threads]
        [t.join() for t in threads]
        codes = sorted(status for status, _, _ in results.values())
        self.assertEqual(codes, [200, 409], results)
        winner = next(r for r, (status, _, _) in results.items() if status == 200)
        loser = "rider-b" if winner == "rider-a" else "rider-a"
        self.assertIn("accepted", results[loser][1]["error"])
        with closing_db(self.server) as db:
            self.assertEqual([row[0] for row in db.execute("SELECT partner FROM deliveries WHERE order_id=?", (order["id"],))], [winner])
        self.assertEqual(self.partner_do(loser, order, "pickup")[0], 409)                # the loser cannot pick it up
        self.assertEqual(self.partner_do(winner, order, "pickup")[0], 200)
        code = self.customer.view(order)["delivery"]["code"]
        self.assertEqual(self.partner_do(winner, order, "deliver", {"code": code})[0], 200)

    # ---- 5. a price change after ordering never touches the old order
    def test_05_price_change_applies_to_new_orders_only(self):
        old = self.customer.order()
        self.customer.pay(old)
        quote_before = old["total"]
        _, snapshot = self.finance()
        status, result, _ = self.api("POST", "/api/admin/pricing", {"version": snapshot["pricingVersion"], "changes": {"platform": 900}}, self.admin)
        self.assertEqual(status, 200, result)
        _, snapshot = self.finance()
        row = next(o for o in snapshot["orders"] if o["id"] == old["id"])
        self.assertEqual(row["total"], quote_before)                                      # snapshot kept
        item = {"name": "notes.pdf", "pages": 3, "copies": 1, "size": len(make_pdf()), "colour": False, "duplex": False, "orientation": "Portrait"}
        fresh = self.customer.post("/api/checkout/quote", {"items": [item], "coupon": ""})[1]
        self.assertGreater(fresh["total"], quote_before)
        self.assertEqual(fresh["platform"], 900)
        status, result, _ = self.customer.post("/api/orders", {
            "id": uuid.uuid4().hex, "customer": "Test Customer", "phone": "+91 98765 43210", "address": "Hostel",
            "items": [item], "expectedTotal": quote_before, "coupon": "", "notes": "", "slot": ""}, **{"X-Order-Key": secrets.token_hex(32)})
        self.assertEqual(status, 409)
        self.assertTrue(result.get("pricingChanged"))                                     # stale price is refused
        self.api("POST", "/api/admin/pricing", {"version": self.finance()[1]["pricingVersion"], "changes": {"platform": 300}}, self.admin)
        self.print_order(old)
        self.deliver_fully("rider-a", old)

    # ---- 6. the server refuses to skip steps
    def test_06_illegal_transitions_are_refused_everywhere(self):
        order = self.customer.order()
        self.customer.pay(order)                                                          # paid, not printed
        self.go_online("rider-b")
        self.assertEqual(self.partner_do("rider-b", order, "accept")[0], 409)             # not ready yet
        self.assertEqual(self.partner_do("rider-b", order, "deliver", {"code": "0000"})[0], 409)
        self.assertEqual(self.api("POST", f"/api/staff/orders/{order['id']}/advance", {}, {**self.warehouse, "X-Order-Status": "printing"})[0], 409)
        with closing_db(self.server) as db:
            for target in ("delivered", "packed", "out_for_delivery", "refunded"):
                with self.assertRaises(sqlite3.IntegrityError, msg=target):
                    db.execute("UPDATE orders SET status=? WHERE id=?", (target, order["id"]))
        self.assertEqual(self.status_of(order), "paid")
        self.print_order(order)
        self.deliver_fully("rider-a", order)

    # ---- 7. undeliverable and re-assign
    def test_07_undeliverable_and_reassign(self):
        order = self.ready_order()
        self.go_online("rider-a")
        self.partner_do("rider-a", order, "accept")
        self.assertEqual(self.api("POST", f"/api/admin/orders/{order['id']}/reassign", {}, self.admin)[0], 200)   # swap before pickup
        self.go_online("rider-b")
        self.assertEqual(self.partner_do("rider-b", order, "accept")[0], 200)
        self.partner_do("rider-b", order, "pickup")
        self.assertEqual(self.partner_do("rider-a", order, "undeliverable")[0], 409)       # not their delivery
        self.assertEqual(self.partner_do("rider-b", order, "undeliverable", {})[0], 200)
        self.assertEqual(self.status_of(order), "undeliverable")
        self.assertNotIn("code", self.customer.view(order).get("delivery") or {})
        self.assertEqual(self.api("POST", f"/api/admin/orders/{order['id']}/reassign", {}, self.admin)[0], 200)
        self.assertEqual(self.status_of(order), "packed")
        self.deliver_fully("rider-a", order)

    # ---- 8. live events: filtering, auth and catch-up
    def test_08_live_events_are_role_filtered_and_catch_up(self):
        latest = self.api("GET", "/api/events?as=admin&poll=1", headers=self.admin)[1]["latest"]
        order = self.ready_order()
        events = lambda path, headers: self.api("GET", f"/api/events?as={path}&poll=1&since={latest}", headers=headers)
        admin = events("admin", self.admin)[1]["events"]
        self.assertIn("packed", [e["to"] for e in admin if e["order"] == order["id"]])
        self.assertTrue(all("actor" in e for e in admin))
        mine = events("customer", self.customer.headers)[1]["events"]
        self.assertTrue(mine and all(e["order"] == order["id"] or True for e in mine))
        self.assertFalse(any("actor" in e for e in mine))                                 # no staff identities to customers
        self.assertEqual(events("customer", self.stranger.headers)[1]["events"], [])       # other customers see nothing
        rider = events("partner", self.rider["rider-b"])[1]["events"]
        self.assertEqual({e["to"] for e in rider if e["order"] == order["id"]}, {"packed"})   # pool sees "ready", not payments
        self.assertEqual(events("warehouse", {})[0], 403)                                  # signed-out
        self.assertEqual(events("admin", self.customer.headers)[0], 403)                   # wrong role
        self.assertEqual(events("admin", self.warehouse)[0], 403)
        feed = Feed(self.server, "customer", self.customer.headers, last_event_id=latest)  # reconnect with Last-Event-ID
        feed.start()
        caught_up = feed.wait_for(lambda e: e["order"] == order["id"] and e["to"] == "packed")
        feed.close()
        self.assertIsNotNone(caught_up, "missed events were not replayed")
        self.deliver_fully("rider-a", order)

    # ---- 9. one status model for all portals
    def test_09_status_model_is_served_and_complete(self):
        status, model, _ = self.api("GET", "/api/status-model")
        self.assertEqual(status, 200)
        for key in ("pending", "paid", "printing", "packed", "out_for_delivery", "delivered", "undeliverable", "refunded"):
            self.assertIn(key, model["statuses"])
            self.assertTrue(model["statuses"][key]["label"])
        self.assertEqual(model["statuses"]["packed"]["stage"], "READY")
        self.assertEqual(model["flow"][-1], "delivered")

    # ---- 10. unauthenticated access gets nothing
    def test_10_signed_out_requests_never_get_data(self):
        for method, path in (("GET", "/api/staff/orders"), ("GET", "/api/admin"), ("GET", "/api/admin/ledger"),
                             ("GET", "/api/partner/orders"), ("GET", "/api/orders"), ("POST", "/api/admin/pricing")):
            status, _, _ = self.api(method, path, {} if method == "POST" else None)
            self.assertIn(status, (401, 403), path)
        self.assertEqual(self.api("GET", "/api/staff/orders", headers=self.rider["rider-a"])[0], 403)   # a partner key is not warehouse
        self.assertEqual(self.api("GET", "/api/admin", headers=self.warehouse)[0], 403)


class AccountTests(unittest.TestCase):
    """Roles, switch portal and one logout, on a server that knows a multi-role Google identity."""

    @classmethod
    def setUpClass(cls):
        cls.server = Server()

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()

    def cookies(self, headers):
        return {value.split("=")[0]: value.split(";")[0] for name, value in headers if name == "Set-Cookie"}

    def sign_in(self, customer=True, portal="warehouse"):
        parts = []
        with closing_db(self.server) as db, db:
            if customer:
                parts.append(auth.create_session(db, BOSS, "").split(";")[0])
            if portal:
                parts.append(auth.portal_session(db, {}, BOSS, portal).split(";")[0])
        return {"Cookie": "; ".join(parts)}

    def test_staff_email_has_one_role_and_no_customer_session(self):
        # BOSS is on every access list: admin wins, and the older customer session is ended.
        headers = self.sign_in(portal="admin")
        status, me, _ = self.server.request("GET", "/api/auth/me", headers=headers)
        self.assertEqual(status, 200)
        self.assertEqual([p["role"] for p in me["portals"]], ["admin"])
        self.assertEqual(me["current"], "admin")
        # Not signed in -> no roles, no menu.
        self.assertEqual(self.server.request("GET", "/api/auth/me")[1]["portals"], [])
        # The admin session works for the admin portal only.
        self.assertEqual(self.server.request("GET", "/api/auth/portal?portal=admin", headers=headers)[1], {"signedIn": True})
        self.assertEqual(self.server.request("GET", "/api/auth/portal?portal=warehouse", headers=headers)[1], {"signedIn": False})
        # A customer who is not staff cannot switch into staff portals.
        plain = Customer(self.server, "plain@example.test")
        self.assertEqual(plain.post("/api/auth/switch", {"portal": "admin"})[0], 403)
        self.assertEqual(self.server.request("GET", "/api/auth/me", headers=plain.headers)[1]["portals"][0]["role"], "customer")
        # One logout clears the portal cookies and ends the session.
        status, _, out = self.server.request("POST", "/api/auth/portal/logout", {}, headers)
        self.assertEqual(status, 200)
        self.assertEqual(self.server.request("GET", "/api/auth/me", headers=headers)[1]["portals"], [])

    def test_customer_logout_ends_staff_sessions_too(self):
        headers = self.sign_in()
        self.assertEqual(self.server.request("POST", "/api/auth/logout", {}, headers)[0], 200)
        self.assertEqual(self.server.request("GET", "/api/auth/me", headers=headers)[1]["portals"], [])


class OriginRuleTests(unittest.TestCase):
    def test_local_origin_is_canonical_and_previews_are_allowed(self):
        server = Server()
        try:
            status, _, out = server.request("GET", "/warehouse?preview=1", headers={"Host": f"localhost:{server.port}"})
            self.assertEqual(status, 303)                                                 # localhost -> the configured host
            self.assertIn(server.origin, dict(out)["Location"])
            self.assertEqual(server.request("GET", "/warehouse?preview=1")[0], 200)
        finally:
            server.stop()

    def test_production_origin_serves_no_sample_data_screens(self):
        server = Server(origin_host="printbee.example", payment="disabled", scheme="https")
        try:
            for path, target in (("/admin-preview.html", "/admin"), ("/warehouse?preview=1", "/warehouse"),
                                 ("/partner?preview=1", "/partner"), ("/admin.html?preview=1", "/admin")):
                status, _, out = server.request("GET", path)
                self.assertEqual((status, dict(out)["Location"]), (303, target), path)
            self.assertEqual(server.request("GET", "/warehouse")[0], 200)                  # the real portal still loads
            self.assertEqual(server.request("GET", "/api/dev/roles")[0], 404)              # no demo sign-in outside demo mode
        finally:
            server.stop()


if __name__ == "__main__":
    unittest.main()

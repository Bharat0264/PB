import sqlite3
import unittest

import event_feed
import fulfillment as ops
import order_status as model


def database():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript(ops.SCHEMA + """
        CREATE TABLE orders (id TEXT PRIMARY KEY, token TEXT, status TEXT, details TEXT);
        CREATE TABLE order_owners (order_id TEXT PRIMARY KEY, email TEXT NOT NULL, order_number TEXT);
    """)
    model.install_guards(db)
    return db


def new_order(db, order_id, email="a@example.test", number="PB-261115-0001"):
    db.execute("INSERT INTO orders VALUES (?, 't', 'pending', '{}')", (order_id, ))
    db.execute("INSERT INTO order_owners VALUES (?,?,?)", (order_id, email, number))
    ops.audit(db, "customer", "order_created", order_id)


class StatusModelTests(unittest.TestCase):
    def test_every_status_is_reachable_and_defined(self):
        self.assertEqual(set(model.TRANSITIONS), set(model.STATUSES))
        reachable = {"pending"} | {new for targets in model.TRANSITIONS.values() for new in targets}
        self.assertEqual(reachable, set(model.STATUSES))
        for status, data in model.STATUSES.items():
            self.assertEqual(bool(model.TRANSITIONS[status]), not data["terminal"], status)
            self.assertTrue({"label", "tone", "colour", "stage", "customer"} <= set(data))

    def test_roles_are_checked_per_transition(self):
        self.assertTrue(model.can("razorpay", "pending", "paid"))
        self.assertFalse(model.can("partner", "paid", "printing"))
        self.assertTrue(model.can("partner", "packed", "out_for_delivery"))
        self.assertFalse(model.can("warehouse", "packed", "out_for_delivery"))
        self.assertFalse(model.can("admin", "paid", "delivered"))

    def test_derived_stages_follow_the_brief(self):
        self.assertEqual(model.stage("packed"), "READY")
        self.assertEqual(model.stage("packed", assigned=True), "ASSIGNED")
        self.assertEqual(model.stage("out_for_delivery"), "OUT_FOR_DELIVERY")

    def test_public_model_is_complete(self):
        data = model.public_model()
        self.assertEqual(data["flow"][0], "pending")
        self.assertEqual(data["flow"][-1], "delivered")
        self.assertIn("packed", data["transitions"]["printing"])


class DatabaseGuardTests(unittest.TestCase):
    def test_new_orders_must_start_pending(self):
        db = database()
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute("INSERT INTO orders VALUES ('x','t','paid','{}')")

    def test_illegal_jumps_are_rejected_in_the_database(self):
        db = database()
        new_order(db, "o1")
        for target in ("printing", "packed", "delivered", "refunded"):
            with self.assertRaises(sqlite3.IntegrityError, msg=target):
                db.execute("UPDATE orders SET status=? WHERE id='o1'", (target,))
        self.assertEqual(db.execute("SELECT status FROM orders").fetchone()[0], "pending")

    def test_the_happy_path_is_allowed_and_terminal_states_are_final(self):
        db = database()
        new_order(db, "o1")
        for status in ("paid", "printing", "packed", "out_for_delivery", "delivered"):
            db.execute("UPDATE orders SET status=? WHERE id='o1'", (status,))
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute("UPDATE orders SET status='paid' WHERE id='o1'")

    def test_unknown_status_is_rejected(self):
        db = database()
        new_order(db, "o1")
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute("UPDATE orders SET status='teleported' WHERE id='o1'")


class EventLogTests(unittest.TestCase):
    def test_audit_writes_one_event_with_from_and_to_status(self):
        db = database()
        new_order(db, "o1")
        db.execute("UPDATE orders SET status='paid' WHERE id='o1'")
        ops.audit(db, "checkout", "paid", "o1")
        db.execute("UPDATE orders SET status='printing' WHERE id='o1'")
        ops.audit(db, "warehouse", "print_queued", "o1")
        rows = db.execute("SELECT event, from_status, to_status FROM order_events ORDER BY id").fetchall()
        self.assertEqual([tuple(row) for row in rows], [
            ("order_created", None, "pending"), ("paid", "pending", "paid"), ("print_queued", "paid", "printing")])

    def test_events_share_ids_with_the_audit_log(self):
        db = database()
        new_order(db, "o1")
        ops.audit(db, "admin", "pricing_updated", "7")          # not an order: audit only
        self.assertEqual(db.execute("SELECT count(*) FROM audit").fetchone()[0], 2)
        self.assertEqual(db.execute("SELECT count(*) FROM order_events").fetchone()[0], 1)
        self.assertEqual(db.execute("SELECT id FROM order_events").fetchone()[0],
                         db.execute("SELECT min(id) FROM audit").fetchone()[0])


class FeedFilteringTests(unittest.TestCase):
    def setUp(self):
        self.db = database()
        new_order(self.db, "mine", "me@example.test", "PB-1")
        new_order(self.db, "theirs", "you@example.test", "PB-2")
        for order in ("mine", "theirs"):
            for status, action in (("paid", "paid"), ("printing", "print_queued"), ("packed", "packed")):
                self.db.execute("UPDATE orders SET status=? WHERE id=?", (status, order))
                ops.audit(self.db, "warehouse", action, order)
        self.db.execute("INSERT INTO deliveries(order_id, partner) VALUES ('mine', 'rider-1')")
        ops.audit(self.db, "rider-1", "delivery_accepted", "mine")
        self.db.execute("UPDATE orders SET status='out_for_delivery' WHERE id='mine'")
        ops.audit(self.db, "rider-1", "delivery_picked_up", "mine")

    def feed(self, audience, identity):
        return event_feed.fetch(self.db, audience, identity, 0, limit=500)

    def test_staff_see_everything_with_actors(self):
        events = self.feed("warehouse", "x")
        self.assertEqual({event["order"] for event in events}, {"mine", "theirs"})
        self.assertTrue(all("actor" in event for event in events))

    def test_customers_only_see_their_own_orders_and_never_actors(self):
        events = self.feed("customer", "me@example.test")
        self.assertEqual({event["order"] for event in events}, {"mine"})
        self.assertFalse(any("actor" in event for event in events))
        self.assertEqual(self.feed("customer", "nobody@example.test"), [])

    def test_partners_see_the_pool_and_their_own_orders_only(self):
        mine = [(event["order"], event["event"]) for event in self.feed("partner", "rider-1")]
        self.assertIn(("mine", "delivery_picked_up"), mine)
        self.assertIn(("theirs", "packed"), mine)
        self.assertNotIn(("theirs", "paid"), mine)
        other = [(event["order"], event["event"]) for event in self.feed("partner", "rider-2")]
        self.assertNotIn(("mine", "delivery_picked_up"), other)
        self.assertIn(("mine", "delivery_accepted"), other)

    def test_since_cursor_returns_only_newer_events(self):
        first = self.feed("admin", "a")
        newer = event_feed.fetch(self.db, "admin", "a", first[-3]["id"])
        self.assertEqual([event["id"] for event in newer], [event["id"] for event in first[-2:]])

    def test_unknown_audience_gets_nothing(self):
        self.assertEqual(self.feed("stranger", "x"), [])


if __name__ == "__main__":
    unittest.main()

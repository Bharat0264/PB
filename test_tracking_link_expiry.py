import time
import unittest

from test_e2e_workflow import Customer, Server, closing_db


class TrackingLinkExpiryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server()
        cls.customer = Customer(cls.server, "sharer@example.test")

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()

    def paid_order(self):
        order = self.customer.order()
        self.customer.pay(order)
        status, body, _ = self.customer.get(f"/api/orders/{order['id']}")
        self.assertEqual(status, 200, body)
        return order["id"], body["trackingKey"]

    def shared(self, order_id, key):
        return self.server.request("GET", f"/api/orders/{order_id}", headers={"X-Tracking-Key": key})[0]

    def test_a_fresh_link_works_and_a_wrong_key_does_not(self):
        order_id, key = self.paid_order()
        self.assertEqual(self.shared(order_id, key), 200)
        self.assertEqual(self.shared(order_id, "0" * 64), 404)

    def test_the_link_ends_30_days_after_the_order(self):
        order_id, key = self.paid_order()
        with closing_db(self.server) as db, db:
            db.execute("UPDATE audit SET created=? WHERE order_id=? AND action='order_created'", (int(time.time()) - 31 * 86400, order_id))
        self.assertEqual(self.shared(order_id, key), 404)
        status, body, _ = self.customer.get(f"/api/orders/{order_id}")        # the owner still sees the order
        self.assertEqual(status, 200)

    def test_the_link_ends_a_day_after_the_order_is_finished(self):
        order_id, key = self.paid_order()
        with closing_db(self.server) as db, db:
            db.execute("UPDATE orders SET status='cancelled' WHERE id=?", (order_id,))
            db.execute("INSERT INTO order_events(order_id,event,actor,from_status,to_status,created) VALUES (?,?,?,?,?,?)",
                       (order_id, "order_cancelled", "admin", "paid", "cancelled", int(time.time()) - 3600))
        self.assertEqual(self.shared(order_id, key), 200)                      # an hour after: the recipient can still see it
        with closing_db(self.server) as db, db:
            db.execute("UPDATE order_events SET created=? WHERE order_id=? AND to_status='cancelled'", (int(time.time()) - 2 * 86400, order_id))
        self.assertEqual(self.shared(order_id, key), 404)


if __name__ == "__main__":
    unittest.main()

import sqlite3
import unittest

from order_rules import advance_order, quote_items


class PricingTest(unittest.TestCase):
    def test_binding_and_mixed_ink_are_charged_per_copy(self):
        file = dict(name="notes.pdf", size=32, pages=4, copies=2, colour=False,
                    duplex=True, orientation="Portrait", binding="glossy", colourPages=[2])
        second = dict(file, copies=1, pages=1, duplex=False, colourPages=None, binding="none")
        items, total = quote_items([file, second])
        self.assertEqual([item["subtotal"] for item in items], [14600, 175])
        self.assertEqual(total, 14775)

    def test_invalid_page_selection_is_rejected(self):
        file = dict(name="notes.pdf", size=32, pages=4, copies=2, colour=False,
                    duplex=True, orientation="Portrait")
        for pages in ([1, 1], [5], [True], []):
            with self.subTest(pages=pages), self.assertRaises(ValueError):
                quote_items([dict(file, colourPages=pages)])


class OrderStateTest(unittest.TestCase):
    def test_only_current_role_and_state_can_advance(self):
        with sqlite3.connect(":memory:") as db:
            db.execute("CREATE TABLE orders (id TEXT PRIMARY KEY, status TEXT)")
            db.execute("INSERT INTO orders VALUES ('test', 'paid')")
            self.assertIsNone(advance_order(db, "test", "delivery", "paid"))
            self.assertIsNone(advance_order(db, "test", "warehouse", "printing"))
            self.assertEqual(advance_order(db, "test", "warehouse", "paid"), "printing")
            self.assertIsNone(advance_order(db, "test", "warehouse", "paid"))
            self.assertEqual(advance_order(db, "test", "warehouse", "printing"), "packed")
            self.assertEqual(advance_order(db, "test", "delivery", "packed"), "out_for_delivery")
            self.assertEqual(advance_order(db, "test", "delivery", "out_for_delivery"), "delivered")
            self.assertIsNone(advance_order(db, "test", "delivery", "delivered"))

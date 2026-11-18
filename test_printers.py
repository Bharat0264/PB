import sqlite3
import unittest

import fulfillment as ops


class PrinterRouting(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.db.execute("CREATE TABLE orders (id TEXT PRIMARY KEY, token TEXT, status TEXT, details TEXT)")
        self.db.execute("CREATE TABLE files (order_id TEXT, position INTEGER)")
        self.db.executescript(ops.SCHEMA)
        self.db.execute("INSERT INTO orders VALUES ('o1', 't', 'paid', '{}')")
        self.db.executemany("INSERT INTO files VALUES ('o1', ?)", [(0,), (1,)])

    def test_first_printer_is_default_and_rename_keeps_it(self):
        a = ops.save_printer(self.db, {"name": "Front desk", "systemName": "HP LaserJet 1"})
        b = ops.save_printer(self.db, {"name": "Back office", "systemName": "Canon MF2"})
        self.assertEqual([p["name"] for p in ops.list_printers(self.db)], ["Front desk", "Back office"])
        self.assertTrue(ops.list_printers(self.db)[0]["isDefault"])
        ops.save_printer(self.db, {"id": b, "name": "Colour printer", "systemName": "Canon MF2", "isDefault": True})
        listed = ops.list_printers(self.db)
        self.assertEqual((listed[0]["name"], listed[0]["isDefault"]), ("Colour printer", True))
        self.assertFalse(listed[1]["isDefault"])
        self.assertEqual(a, listed[1]["id"])

    def test_jobs_go_to_the_chosen_printer_else_the_default(self):
        a = ops.save_printer(self.db, {"name": "Front desk", "systemName": "HP LaserJet 1"})
        b = ops.save_printer(self.db, {"name": "Back office", "systemName": "Canon MF2"})
        ops.queue_job(self.db, "o1", 0, printer_id=b)
        ops.queue_job(self.db, "o1", 1)
        first = ops.claim_job(self.db, "w1")
        second = ops.claim_job(self.db, "w2")
        self.assertEqual(ops.job_printer(self.db, first), "Canon MF2")
        self.assertEqual(ops.job_printer(self.db, second), "HP LaserJet 1")
        self.assertEqual(a, ops.list_printers(self.db)[0]["id"])

    def test_remove_promotes_another_default_and_validates_input(self):
        a = ops.save_printer(self.db, {"name": "A", "systemName": "sys-a"})
        ops.save_printer(self.db, {"name": "B", "systemName": "sys-b"})
        ops.remove_printer(self.db, a)
        self.assertEqual([(p["name"], p["isDefault"]) for p in ops.list_printers(self.db)], [("B", True)])
        with self.assertRaises(ops.PrinterError):
            ops.remove_printer(self.db, a)
        with self.assertRaises(ops.PrinterError):
            ops.save_printer(self.db, {"name": "  ", "systemName": "x"})
        with self.assertRaises(ops.PrinterError):
            ops.save_printer(self.db, {"name": "ok", "systemName": "x" * 200})


if __name__ == "__main__":
    unittest.main()

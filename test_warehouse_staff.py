import sqlite3
import unittest

import admin_records
import fulfillment as ops


class WarehouseStaffAccess(unittest.TestCase):
    def test_emails_saved_by_the_admin_become_warehouse_staff(self):
        db = sqlite3.connect(":memory:")
        db.row_factory = sqlite3.Row
        db.execute("CREATE TABLE orders (id TEXT PRIMARY KEY, token TEXT, status TEXT, details TEXT)")
        db.executescript(ops.SCHEMA)
        db.executescript(admin_records.SCHEMA)
        self.assertEqual(admin_records.warehouse_staff(db), set())
        admin_records.save_warehouse(db, {"name": "Main", "address": "SRM University", "email": "Staff@Example.com",
                                          "useForPickup": True}, "admin")
        self.assertEqual(admin_records.warehouse_staff(db), {"staff@example.com"})


if __name__ == "__main__":
    unittest.main()

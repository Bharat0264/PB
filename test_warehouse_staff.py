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


    def test_removing_a_warehouse_ends_access_and_promotes_another_default(self):
        db = sqlite3.connect(":memory:")
        db.row_factory = sqlite3.Row
        db.execute("CREATE TABLE orders (id TEXT PRIMARY KEY, token TEXT, status TEXT, details TEXT)")
        db.executescript(ops.SCHEMA)
        db.executescript(admin_records.SCHEMA)
        admin_records.save_warehouse(db, {"name": "A", "address": "x", "email": "a@example.com", "useForPickup": True}, "admin")
        admin_records.save_warehouse(db, {"name": "B", "address": "y", "email": "b@example.com", "useForPickup": False}, "admin")
        first = admin_records.warehouse_directory(db)[0]
        self.assertEqual(admin_records.remove_warehouse(db, {"id": first["id"]}, "admin"), "a@example.com")
        self.assertEqual(admin_records.warehouse_staff(db), {"b@example.com"})
        self.assertEqual(admin_records.default_pickup(db)["name"], "B")
        with self.assertRaises(admin_records.InputError):
            admin_records.remove_warehouse(db, {"id": first["id"]}, "admin")


if __name__ == "__main__":
    unittest.main()

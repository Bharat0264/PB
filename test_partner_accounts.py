import sqlite3
import unittest

import admin_records
import fulfillment as ops


class PartnerAccountTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.db.executescript(ops.SCHEMA + "CREATE TABLE orders (id TEXT PRIMARY KEY, status TEXT, details TEXT);")
        self.db.executescript(admin_records.SCHEMA)

    def test_add_is_idempotent_and_lowercases(self):
        email, partner = admin_records.add_partner(self.db, {"email": " Rider@Example.com "}, "admin")
        again = admin_records.add_partner(self.db, {"email": "rider@example.com"}, "admin")
        self.assertEqual(email, "rider@example.com")
        self.assertEqual(again, (email, partner))
        self.assertEqual(admin_records.partner_accounts(self.db), {email: partner})

    def test_rejects_bad_email_and_unknown_removal(self):
        with self.assertRaises(admin_records.InputError):
            admin_records.add_partner(self.db, {"email": "not-an-email"}, "admin")
        with self.assertRaises(admin_records.InputError):
            admin_records.remove_partner(self.db, {"email": "nobody@example.com"}, "admin")

    def test_remove(self):
        email, _ = admin_records.add_partner(self.db, {"email": "a@b.co"}, "admin")
        admin_records.remove_partner(self.db, {"email": email}, "admin")
        self.assertEqual(admin_records.partner_accounts(self.db), {})


if __name__ == "__main__":
    unittest.main()

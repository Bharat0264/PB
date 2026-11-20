import sqlite3
import unittest

import admin_records
import fulfillment as ops


DETAILS = {"name": "Test Rider", "email": "rider@example.com", "phone": "+91 9876543210",
           "rollNo": "", "licence": "TN0120201234567", "payout": "testrider@upi", "vehicle": "Honda Activa", "verified": True}


class PartnerAccountTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.db.executescript(ops.SCHEMA + "CREATE TABLE orders (id TEXT PRIMARY KEY, status TEXT, details TEXT);")
        self.db.executescript(admin_records.SCHEMA)

    def test_add_is_idempotent_and_lowercases(self):
        email, partner = admin_records.add_partner(self.db, {**DETAILS, "email": " Rider@Example.com "}, "admin")
        again = admin_records.add_partner(self.db, DETAILS, "admin")
        self.assertEqual(email, "rider@example.com")
        self.assertEqual(again, (email, partner))
        self.assertEqual(admin_records.partner_accounts(self.db), {email: partner})

    def test_rejects_bad_email_and_unknown_removal(self):
        with self.assertRaises(admin_records.InputError):
            admin_records.add_partner(self.db, {"email": "not-an-email"}, "admin")
        with self.assertRaises(admin_records.InputError):
            admin_records.remove_partner(self.db, {"email": "nobody@example.com"}, "admin")

    def test_remove(self):
        email, _ = admin_records.add_partner(self.db, {**DETAILS, "email": "a@b.co"}, "admin")
        admin_records.remove_partner(self.db, {"email": email}, "admin")
        self.assertEqual(admin_records.partner_accounts(self.db), {})
        self.assertEqual(self.db.execute("SELECT count(*) FROM partner_details").fetchone()[0], 0)

    def test_required_fields_optional_roll_and_validation(self):
        for key in ("name", "phone", "licence", "payout", "vehicle", "verified"):
            with self.subTest(key=key), self.assertRaises(admin_records.InputError):
                admin_records.add_partner(self.db, {k: v for k, v in DETAILS.items() if k != key}, "admin")
        for key, value in (("phone", "invalid"), ("payout", "invalid"), ("rollNo", "x" * 41)):
            with self.subTest(key=key), self.assertRaises(admin_records.InputError):
                admin_records.add_partner(self.db, {**DETAILS, key: value}, "admin")
        email, partner = admin_records.add_partner(self.db, DETAILS, "admin")
        saved = admin_records.partner_profile(self.db, partner)
        for key in ("name", "phone", "rollNo", "licence", "payout", "vehicle"):
            self.assertEqual(saved[key], DETAILS[key])
        admin_records.add_partner(self.db, {**DETAILS, "rollNo": "RA12345", "vehicle": "TVS Jupiter"}, "admin")
        self.assertEqual(admin_records.partner_profile(self.db, partner)["rollNo"], "RA12345")
        self.assertEqual(self.db.execute("SELECT count(*) FROM partner_accounts").fetchone()[0], 1)

    def test_existing_accounts_need_no_data_migration(self):
        self.db.execute("INSERT INTO partner_accounts VALUES ('old@example.test','old-rider',1)")
        saved = admin_records.partner_profile(self.db, "old-rider")
        self.assertEqual(saved["email"], "old@example.test")
        self.assertIsNone(saved["name"])


if __name__ == "__main__":
    unittest.main()

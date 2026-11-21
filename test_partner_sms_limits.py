import sqlite3
import unittest

import partner_auth as limits


def database():
    db = sqlite3.connect(":memory:")
    db.executescript(limits.SCHEMA)
    return db


def attempt(db, action, phone, ip, now):
    with db:
        db.execute("BEGIN IMMEDIATE")
        return limits.allow_attempt(db, action, "phone:" + phone, "ip:" + ip, now)


class PartnerSmsLimitTests(unittest.TestCase):
    def test_one_caller_cannot_lock_everybody_out(self):
        db = database()
        now = 10_000
        allowed = [attempt(db, "send", f"+91900000{n:04d}", "1.1.1.1", now + n) for n in range(limits.PER_IP + 10)]
        self.assertEqual(allowed.count(True), limits.PER_IP)                      # the caller is stopped at its own limit
        self.assertTrue(attempt(db, "send", "+919999999999", "2.2.2.2", now + 40))   # a partner on another address still can

    def test_one_phone_cannot_be_flooded(self):
        db = database()
        results = [attempt(db, "check", "+911", f"9.9.9.{n}", 5000 + n) for n in range(limits.PER_PHONE + 2)]
        self.assertEqual(results.count(True), limits.PER_PHONE)

    def test_a_text_message_is_not_resent_within_a_minute(self):
        db = database()
        self.assertTrue(attempt(db, "send", "+911", "3.3.3.3", 100))
        self.assertFalse(attempt(db, "send", "+911", "3.3.3.4", 130))
        self.assertTrue(attempt(db, "send", "+911", "3.3.3.5", 161))

    def test_the_window_moves_on(self):
        db = database()
        for n in range(limits.PER_PHONE):
            attempt(db, "check", "+911", "4.4.4.4", 1000 + n)
        self.assertFalse(attempt(db, "check", "+911", "4.4.4.4", 1100))
        self.assertTrue(attempt(db, "check", "+911", "4.4.4.4", 1000 + limits.WINDOW + 10))

    def test_the_site_wide_brake_is_far_above_normal_traffic(self):
        self.assertGreaterEqual(limits.SITE_WIDE, 1000)


if __name__ == "__main__":
    unittest.main()

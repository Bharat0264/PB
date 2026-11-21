import sqlite3
import unittest

import customer_auth as auth


def database():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript(auth.SCHEMA)
    return db


def sent(email, token):
    pass


class SignInLimitTests(unittest.TestCase):
    def test_one_visitor_cannot_use_up_everybody_elses_turns(self):
        db = database()
        results = [auth.request_link(db, f"fake{n}@example.test", "1.1.1.1", sent)[0] for n in range(auth.PER_IP + 5)]
        self.assertEqual(results.count(200), auth.PER_IP)
        self.assertEqual(results[-1], 429)
        # the attack from the report: after 52 fake emails from one address, a different customer can still sign in
        self.assertEqual(auth.request_link(db, "real@example.test", "2.2.2.2", sent)[0], 200)

    def test_old_global_cap_of_50_is_gone(self):
        db = database()
        for n in range(60):
            self.assertEqual(auth.request_link(db, f"user{n}@example.test", f"10.0.{n}.1", sent)[0], 200)

    def test_one_email_cannot_be_flooded(self):
        db = database()
        self.assertEqual(auth.request_link(db, "victim@example.test", "3.3.3.1", sent)[0], 200)
        self.assertEqual(auth.request_link(db, "victim@example.test", "3.3.3.2", sent)[0], 429)   # one a minute
        with db:
            db.execute("UPDATE login_links SET created=created-120")
        for n in range(auth.PER_EMAIL - 1):
            self.assertEqual(auth.request_link(db, "victim@example.test", f"3.3.4.{n}", sent)[0], 200)
            with db:
                db.execute("UPDATE login_links SET created=created-120")
        self.assertEqual(auth.request_link(db, "victim@example.test", "3.3.9.9", sent)[0], 429)

    def test_old_databases_get_the_ip_column(self):
        db = sqlite3.connect(":memory:")
        db.execute("CREATE TABLE login_links (digest TEXT PRIMARY KEY, email TEXT NOT NULL, created INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)")
        auth.add_ip_column(db)
        self.assertIn("ip", [row[1] for row in db.execute("PRAGMA table_info(login_links)")])


if __name__ == "__main__":
    unittest.main()

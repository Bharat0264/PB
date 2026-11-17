"""The customer session lasts 7 days from the LAST activity and renews while the customer is active."""
import sqlite3
import time
import unittest

import customer_auth as auth

DAY = 86400


class Headers(dict):
    def get(self, key, default=""):
        return super().get(key, default)


def headers_for(cookie_value):
    return Headers({"Cookie": f"{auth.COOKIE}={cookie_value}"})


class SlidingSessionTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.db.executescript(auth.SCHEMA)
        cookie = auth.create_session(self.db, "me@example.com", "")
        self.token = cookie.split(";")[0].split("=", 1)[1]
        self.headers = headers_for(self.token)
        self.start = int(time.time())

    def window(self):
        return self.db.execute("SELECT expires, last_active FROM customer_sessions").fetchone()

    def test_activity_slides_the_window_forward(self):
        state, cookies = auth.slide_session(self.db, self.headers, now=self.start + 3 * DAY)
        self.assertEqual(state, "active")
        self.assertEqual(self.window()["expires"], self.start + 3 * DAY + auth.SESSION_AGE)
        self.assertIn(f"Max-Age={auth.SESSION_AGE}", cookies[0])
        self.assertIn("HttpOnly", cookies[0])

    def test_active_every_few_days_never_expires(self):
        for day in (3, 6, 9, 12, 15):
            state, _ = auth.slide_session(self.db, self.headers, now=self.start + day * DAY)
            self.assertEqual(state, "active", f"day {day}")

    def test_renewal_is_throttled(self):
        auth.slide_session(self.db, self.headers, now=self.start + 100)
        before = self.window()["last_active"]
        state, cookies = auth.slide_session(self.db, self.headers, now=self.start + 160)
        self.assertEqual((state, cookies), ("active", []))
        self.assertEqual(self.window()["last_active"], before)

    def test_seven_idle_days_signs_the_customer_out(self):
        state, cookies = auth.slide_session(self.db, self.headers, now=self.start + 8 * DAY)
        self.assertEqual(state, "expired")
        self.assertTrue(any("Max-Age=0" in cookie for cookie in cookies))
        self.assertTrue(any(cookie.startswith(auth.EXPIRED_FLAG + "=1") for cookie in cookies))
        self.assertIsNone(self.db.execute("SELECT 1 FROM customer_sessions").fetchone())
        self.assertIsNone(auth.session_email(self.db, self.headers))

    def test_older_sessions_without_last_active_keep_working(self):
        self.db.execute("UPDATE customer_sessions SET last_active=NULL")
        state, _ = auth.slide_session(self.db, self.headers, now=self.start + DAY)
        self.assertEqual(state, "active")

    def test_unknown_or_missing_cookie(self):
        self.assertEqual(auth.slide_session(self.db, Headers({}))[0], "none")
        self.assertEqual(auth.slide_session(self.db, headers_for("x" * 43))[0], "expired")

    def test_log_out_of_all_devices(self):
        auth.create_session(self.db, "me@example.com", "")
        auth.create_session(self.db, "other@example.com", "")
        auth.end_all_sessions(self.db, "me@example.com")
        remaining = [row["email"] for row in self.db.execute("SELECT email FROM customer_sessions")]
        self.assertEqual(remaining, ["other@example.com"])


if __name__ == "__main__":
    unittest.main()

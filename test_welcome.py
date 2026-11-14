import json
import tempfile
import unittest
from contextlib import closing
from http.client import HTTPConnection
from http.cookies import SimpleCookie
from http.server import ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from unittest.mock import patch

import server as app


class WelcomeRoutingTest(unittest.TestCase):
    def test_welcome_routes_verified_accounts_and_scopes_portal_session(self):
        auth = app.auth
        with tempfile.TemporaryDirectory() as directory, patch.object(app, "DATA", Path(directory)):
            with closing(app.connect()) as db, db:
                db.executescript(auth.SCHEMA)
            with ThreadingHTTPServer(("127.0.0.1", 0), app.PrintBee) as server:
                server.google_access = {
                    "admin": {"admin@example.test": "admin"},
                    "warehouse": {"staff@example.test": "warehouse", "admin@example.test": "warehouse"},
                    "partner": {"rider@example.test": "rider"},
                }
                thread = Thread(target=server.serve_forever, daemon=True)
                thread.start()

                def get(path, cookie=""):
                    with closing(HTTPConnection("127.0.0.1", server.server_port, timeout=3)) as conn:
                        conn.request("GET", path, headers={"Cookie": cookie})
                        result = conn.getresponse()
                        return result.status, result.getheaders(), result.read()

                try:
                    self.assertIn(b"Continue as guest", get("/")[2])
                    verifier = "a" * 43
                    state = auth.google_state(verifier, "welcome")
                    flow = f"{auth.GOOGLE_COOKIE}={verifier}.welcome"
                    for email, destination, cookie_name in (
                        ("admin@example.test", "/admin", auth.GOOGLE_PORTAL_COOKIE),
                        ("staff@example.test", "/warehouse", auth.GOOGLE_PORTAL_COOKIE),
                        ("rider@example.test", "/partner", auth.GOOGLE_PORTAL_COOKIE),
                        ("customer@example.test", "/index.html", auth.COOKIE),
                    ):
                        with patch.object(auth, "google_config", return_value={"test": True}), \
                             patch.object(auth, "google_email", return_value=email):
                            code, headers, _ = get(f"{auth.GOOGLE_CALLBACK}?code=test&state={state}", flow)
                        self.assertEqual(code, 303)
                        self.assertEqual(dict(headers)["Location"], destination)
                        cookies = SimpleCookie()
                        for key, value in headers:
                            if key == "Set-Cookie":
                                cookies.load(value)
                        cookie = f"{cookie_name}={cookies[cookie_name].value}"
                        if destination == "/admin":
                            self.assertEqual(json.loads(get("/api/auth/portal?portal=admin", cookie)[2]),
                                             {"signedIn": True})
                            self.assertEqual(json.loads(get("/api/auth/portal?portal=warehouse", cookie)[2]),
                                             {"signedIn": False})
                finally:
                    server.shutdown()
                    thread.join()

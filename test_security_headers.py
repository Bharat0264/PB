import unittest

from test_e2e_workflow import Server


class SecurityHeaderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server()

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()

    def headers(self, path, **extra):
        status, _, headers = self.server.request("GET", path, headers=extra)
        return status, {key.lower(): value for key, value in dict(headers).items()}

    def test_pages_api_and_errors_all_carry_the_headers(self):
        for path in ("/", "/pricing.html", "/api/checkout", "/api/status-model", "/manrope-latin-400-normal.woff2", "/api/nope"):
            _, found = self.headers(path)
            self.assertEqual(found.get("x-content-type-options"), "nosniff", path)
            self.assertEqual(found.get("x-frame-options"), "SAMEORIGIN", path)
            self.assertEqual(found.get("referrer-policy"), "strict-origin-when-cross-origin", path)
            self.assertIn("frame-ancestors 'self'", found.get("content-security-policy-report-only", ""), path)

    def test_csp_is_report_only_so_nothing_is_blocked_yet(self):
        _, found = self.headers("/")
        self.assertNotIn("content-security-policy", found)

    def test_hsts_only_on_https(self):
        _, plain = self.headers("/")
        self.assertNotIn("strict-transport-security", plain)
        _, secure = self.headers("/", **{"X-Forwarded-Proto": "https"})
        self.assertIn("max-age=", secure.get("strict-transport-security", ""))


if __name__ == "__main__":
    unittest.main()

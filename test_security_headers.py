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

    def test_the_safe_csp_parts_are_enforced_and_the_rest_stays_report_only(self):
        for path in ("/", "/api/checkout", "/pricing.html"):
            _, found = self.headers(path)
            enforced = found.get("content-security-policy", "")
            for directive in ("object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'"):
                self.assertIn(directive, enforced, path)
            self.assertNotIn("script-src", enforced)          # scripts and styles are not enforced yet
            self.assertNotIn("style-src", enforced)
            self.assertIn("script-src", found.get("content-security-policy-report-only", ""))

    def test_unused_browser_features_are_switched_off_but_location_and_payment_are_not(self):
        for path in ("/", "/api/checkout"):
            _, found = self.headers(path)
            policy = found.get("permissions-policy", "")
            for rule in ("camera=()", "microphone=()", "geolocation=(self)", "usb=()"):
                self.assertIn(rule, policy, path)
            self.assertNotIn("payment", policy)                   # Razorpay's checkout window needs it

    def test_hsts_subdomains_only_when_the_owner_opts_in(self):
        _, found = self.headers("/", **{"X-Forwarded-Proto": "https"})
        self.assertNotIn("includeSubDomains", found["strict-transport-security"])
        other = Server(extra={"PRINTBEE_HSTS_SUBDOMAINS": "1"})
        try:
            status, _, headers = other.request("GET", "/", headers={"X-Forwarded-Proto": "https"})
            self.assertIn("includeSubDomains", dict(headers)["Strict-Transport-Security"])
        finally:
            other.stop()

    def test_hsts_only_on_https(self):
        _, plain = self.headers("/")
        self.assertNotIn("strict-transport-security", plain)
        _, secure = self.headers("/", **{"X-Forwarded-Proto": "https"})
        self.assertIn("max-age=", secure.get("strict-transport-security", ""))


if __name__ == "__main__":
    unittest.main()

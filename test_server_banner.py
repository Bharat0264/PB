import unittest

from test_e2e_workflow import Server


class ServerBannerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server()

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()

    def test_no_response_names_the_software_or_its_version(self):
        for method, path in (("GET", "/"), ("GET", "/api/checkout"), ("GET", "/nope"), ("GET", "/api/admin"), ("HEAD", "/")):
            status, body, headers = self.server.request(method, path, raw=True)
            banner = dict(headers).get("Server", "")
            self.assertNotRegex(banner, r"(?i)python|simplehttp|\d+\.\d+", (method, path, banner))
            self.assertNotRegex(body.decode("utf-8", "replace") if isinstance(body, bytes) else str(body), r"(?i)python/\d")


if __name__ == "__main__":
    unittest.main()

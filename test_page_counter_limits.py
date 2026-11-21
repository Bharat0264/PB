import socket
import time
import unittest

import server
from test_e2e_workflow import Customer, Server, make_pdf


class ClaimTests(unittest.TestCase):
    def tearDown(self):
        server.PAGE_COUNT_BUSY.clear()
        server.PAGE_COUNT_LOG.clear()

    def test_one_file_at_a_time_per_address(self):
        self.assertIsNone(server.claim_page_counter("1.1.1.1"))
        self.assertEqual(server.claim_page_counter("1.1.1.1")[0], 503)         # same address, still busy
        self.assertIsNone(server.claim_page_counter("2.2.2.2"))                # another address is not held up
        server.release_page_counter("1.1.1.1")
        self.assertIsNone(server.claim_page_counter("1.1.1.1"))

    def test_rate_per_ten_minutes_per_address(self):
        now = 1000.0
        for n in range(server.PAGE_COUNT_PER_WINDOW):
            self.assertIsNone(server.claim_page_counter("3.3.3.3", now + n * 0.01))
            server.release_page_counter("3.3.3.3")
        refusal = server.claim_page_counter("3.3.3.3", now + 5)
        self.assertEqual(refusal[0], 429)
        self.assertIsNone(server.claim_page_counter("4.4.4.4", now + 5))
        server.release_page_counter("4.4.4.4")
        self.assertIsNone(server.claim_page_counter("3.3.3.3", now + server.PAGE_COUNT_WINDOW + 5))   # the window moves on


class PageCounterOverHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server()

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()

    def test_normal_use_still_works_and_a_hung_upload_holds_only_its_own_address(self):
        pdf = make_pdf(2)
        status, body, _ = self.server.request("POST", "/api/checkout/pages?format=pdf", pdf, headers={"Content-Type": "application/pdf"})
        self.assertEqual((status, body), (200, {"pages": 2}))
        # a client that announces a big file and then stops sending keeps its own slot...
        hung = socket.create_connection(("127.0.0.1", self.server.port), timeout=10)
        hung.sendall((f"POST /api/checkout/pages?format=pdf HTTP/1.1\r\nHost: x\r\nOrigin: {self.server.origin}\r\n"
                      "Content-Type: application/pdf\r\nContent-Length: 5000000\r\n\r\n%PDF-").encode())
        time.sleep(1)
        try:
            # ...so a second request from the same address is refused straight away, not queued
            status, body, _ = self.server.request("POST", "/api/checkout/pages?format=pdf", pdf, headers={"Content-Type": "application/pdf"})
            self.assertEqual(status, 503, body)
        finally:
            hung.close()
        time.sleep(1.5)                                                           # the closed connection frees the slot
        status, body, _ = self.server.request("POST", "/api/checkout/pages?format=pdf", pdf, headers={"Content-Type": "application/pdf"})
        self.assertEqual(status, 200, body)


if __name__ == "__main__":
    unittest.main()

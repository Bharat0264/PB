import http.client
import socket
import time
import unittest

import server
from test_e2e_workflow import Customer, Server


class StreamSlotTests(unittest.TestCase):
    def tearDown(self):
        server.OPEN_STREAMS.clear()

    def test_one_person_gets_a_few_streams_and_slots_come_back(self):
        person = ("events", "customer", "a@x.test")
        taken = [server.take_stream_slot(person) for _ in range(server.STREAMS_PER_PERSON + 2)]
        self.assertEqual(taken, [True] * server.STREAMS_PER_PERSON + [False, False])
        self.assertTrue(server.take_stream_slot(("events", "customer", "b@x.test")))      # somebody else is unaffected
        server.release_stream_slot(person)
        self.assertTrue(server.take_stream_slot(person))

    def test_the_whole_site_has_a_ceiling_too(self):
        for n in range(server.STREAMS_TOTAL):
            server.OPEN_STREAMS[("x", n)] = 1
        self.assertFalse(server.take_stream_slot(("events", "customer", "late@x.test")))


class LiveStreamsOverHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server()
        cls.customer = Customer(cls.server, "streamer@example.test")
        cls.other = Customer(cls.server, "other@example.test")

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()

    def open_stream(self, customer):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=10)
        connection.request("GET", "/api/events?as=customer", headers=customer.headers)
        return connection, connection.getresponse()

    def test_a_fourth_stream_is_refused_and_polling_still_works(self):
        open_streams = []
        try:
            statuses = []
            for _ in range(server.STREAMS_PER_PERSON + 1):
                connection, response = self.open_stream(self.customer)
                statuses.append(response.status)
                open_streams.append(connection)
            self.assertEqual(statuses, [200] * server.STREAMS_PER_PERSON + [429])
            status, body, _ = self.customer.get("/api/events?as=customer&poll=1")         # the page's fallback
            self.assertEqual(status, 200, body)
            connection, response = self.open_stream(self.other)                              # another customer is unaffected
            open_streams.append(connection)
            self.assertEqual(response.status, 200)
        finally:
            for connection in open_streams:
                connection.close()
        time.sleep(2.5)                                                                      # the server notices closed sockets
        connection, response = self.open_stream(self.customer)
        try:
            self.assertEqual(response.status, 200)                                           # slots were given back
        finally:
            connection.close()


class SlowConnectionTests(unittest.TestCase):
    def test_a_connection_that_stops_talking_is_dropped(self):
        slow = Server(extra={"PRINTBEE_CONNECTION_TIMEOUT": "2"})
        try:
            with socket.create_connection(("127.0.0.1", slow.port), timeout=10) as sock:
                sock.sendall(b"GET /api/status-model HTTP/1.1\r\nHost: x\r\nX-Slow: ")      # request never finishes
                started = time.time()
                try:
                    data = sock.recv(100)
                except ConnectionError:
                    data = b""
                self.assertEqual(data[:12].count(b"200"), 0)                                 # never answered a half request
                self.assertLess(time.time() - started, 8)                                    # closed by the server, not by our own timeout
        finally:
            slow.stop()

    def test_default_timeout_is_30_seconds(self):
        self.assertEqual(server.PrintBee.timeout, 30)


if __name__ == "__main__":
    unittest.main()

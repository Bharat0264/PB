"""Stage 1 tests: the print agent's printer discovery. No hardware, network or zeroconf needed."""
import json
import struct
import tempfile
import unittest
from pathlib import Path

import print_agent
import print_discovery as d


def ipp_answer(groups, status=0):
    out = struct.pack(">BBHI", 1, 1, status, 1)
    for tag, attributes in groups:
        out += bytes([tag])
        for vtag, name, values in attributes:
            for i, value in enumerate(values):
                raw = d._value(vtag, value)
                out += bytes([vtag]) + struct.pack(">H", 0 if i else len(name)) + (b"" if i else name.encode()) + struct.pack(">H", len(raw)) + raw
    return out + b"\x03"


def sample_attrs(**over):
    attrs = [(d.T_ENUM, "printer-state", [3]), (d.T_KEYWORD, "printer-state-reasons", ["none"]), (d.T_BOOLEAN, "printer-is-accepting-jobs", [True]),
             (d.T_TEXT, "printer-make-and-model", ["HP Color LaserJet M454dn"]), (d.T_URI, "printer-uuid", ["urn:uuid:aaaa-bbbb"]),
             (d.T_MIME, "document-format-supported", ["application/pdf", "image/jpeg"]), (d.T_BOOLEAN, "color-supported", [True]),
             (d.T_KEYWORD, "sides-supported", ["one-sided", "two-sided-long-edge"]),
             (d.T_KEYWORD, "media-supported", ["iso_a4_210x297mm", "iso_a3_297x420mm", "na_letter_8.5x11in"]),
             (d.T_NAME, "marker-names", ["Black", "Cyan"]), (d.T_INTEGER, "marker-levels", [80, 5]), (d.T_KEYWORD, "marker-types", ["toner", "toner"])]
    attrs = [a for a in attrs if a[1] not in over] + [a for a in over.values()]
    return d.printer_attributes(d.ipp_decode(ipp_answer([(d.G_OPERATION, [(d.T_CHARSET, "attributes-charset", ["utf-8"])]), (d.G_PRINTER, attrs)])))


class IppParsing(unittest.TestCase):
    def test_decode_and_record(self):
        rec = d.record_from_ipp(sample_attrs(), "192.168.1.9")
        self.assertEqual(rec["model"], "HP Color LaserJet M454dn")
        c = rec["capabilities"]
        self.assertTrue(c["colour"] and c["duplex"] and c["pdf"])
        self.assertEqual(c["paperSizes"], ["Letter", "A4", "A3"])
        self.assertEqual(c["maxSize"], "A3")
        self.assertEqual(rec["uuid"], "aaaa-bbbb")
        self.assertEqual(rec["supplies"][1], {"name": "Cyan", "level": 5, "type": "toner"})
        self.assertEqual(rec["state"], "toner-low")        # cyan at 5%

    def test_states(self):
        def state(**over):
            return d.ipp_state(sample_attrs(**{"marker-levels": (d.T_INTEGER, "marker-levels", [80, 80]), **over}))[0]
        self.assertEqual(state(), "ready")
        self.assertEqual(state(**{"printer-state": (d.T_ENUM, "printer-state", [4])}), "busy")
        self.assertEqual(state(**{"printer-state-reasons": (d.T_KEYWORD, "printer-state-reasons", ["media-empty-error"])}), "paper-out")
        self.assertEqual(state(**{"printer-state-reasons": (d.T_KEYWORD, "printer-state-reasons", ["toner-low-warning"])}), "toner-low")
        self.assertEqual(state(**{"printer-state-reasons": (d.T_KEYWORD, "printer-state-reasons", ["media-jam-error"])}), "error")
        self.assertEqual(state(**{"printer-is-accepting-jobs": (d.T_BOOLEAN, "printer-is-accepting-jobs", [False])}), "offline")

    def test_damaged_answer_is_an_error_not_a_crash(self):
        with self.assertRaises(d.IppError):
            d.ipp_decode(b"\x01\x01\x00\x00\x00\x00\x00\x01\x04\x41\x00\x09")

    def test_get_printer_attributes_tries_paths(self):
        calls = []
        def post(uri, body, timeout):
            calls.append(uri)
            if uri.endswith("/ipp/print"):
                raise d.IppError("no")
            return d.ipp_decode(ipp_answer([(d.G_PRINTER, [(d.T_ENUM, "printer-state", [3])])]))
        attrs = d.get_printer_attributes("10.0.0.2", post=post)
        self.assertEqual(attrs["_uri"], ["ipp://10.0.0.2:631/ipp"])
        self.assertEqual(len(calls), 2)


class MdnsAndInstalled(unittest.TestCase):
    def test_mdns_record(self):
        rec = d.mdns_record("Office._ipp._tcp.local.", "_ipp._tcp.local.", ["192.168.1.30"], 631,
                            {b"ty": b"Brother HL-L2350DW", b"Color": b"F", b"Duplex": b"T", b"PaperMax": b"legal-A4", b"rp": b"ipp/print", b"UUID": b"1234", b"pdl": b"application/pdf"})
        self.assertEqual((rec["model"], rec["host"], rec["uuid"]), ("Brother HL-L2350DW", "192.168.1.30", "1234"))
        self.assertTrue(rec["capabilities"]["duplex"] and rec["capabilities"]["pdf"])
        self.assertFalse(rec["capabilities"]["colour"])
        self.assertNotIn("A3", rec["capabilities"]["paperSizes"])
        self.assertEqual(rec["ipp"], "ipp://192.168.1.30:631/ipp/print")

    def test_browse_without_zeroconf_degrades(self):
        import builtins
        real = builtins.__import__
        def fake(name, *a, **k):
            if name == "zeroconf":
                raise ImportError
            return real(name, *a, **k)
        builtins.__import__ = fake
        try:
            recs, error = d.browse_mdns()
        finally:
            builtins.__import__ = real
        self.assertEqual(recs, [])
        self.assertIn("zeroconf", error)

    def test_windows_json(self):
        text = json.dumps([
            {"name": "Front Desk", "status": "Normal", "driver": "HP Universal", "port": "USB001", "host": None, "colour": False, "duplex": True, "papers": ["A4", "Letter"], "paper": "A4", "valid": True},
            {"name": "Microsoft Print to PDF", "status": "Normal", "driver": "x", "port": "PORTPROMPT:", "valid": True},
            {"name": "Colour", "status": "Offline", "driver": "Epson", "port": "IP_192.168.1.50", "colour": True, "papers": ["A3"], "valid": True}])
        a, b = d.parse_windows_printers(text)
        self.assertEqual((a["connection"], a["state"]), ("usb", "ready"))
        self.assertEqual((b["connection"], b["host"], b["state"]), ("network", "192.168.1.50", "offline"))
        self.assertEqual(d.windows_state("7")[0], "offline")           # old Windows: a number
        self.assertEqual(d.parse_windows_printers(json.dumps({"name": "One", "status": "Normal", "port": "USB002"}))[0]["model"], "One")   # one printer is an object

    def test_cups(self):
        outputs = {("lpstat", "-p"): "printer Laser_A is idle.  enabled since Mon\nprinter Inkjet disabled since Mon\n\tPaused\n",
                   ("lpstat", "-v"): "device for Laser_A: usb://HP/LaserJet\ndevice for Inkjet: ipps://192.168.1.50/ipp/print\n",
                   ("lpoptions", "-p", "Laser_A", "-l"): "Duplex/2-Sided: None *DuplexNoTumble\nPageSize/Size: *A4 Letter\nColorModel/Mode: *Gray\n",
                   ("lpoptions", "-p", "Inkjet", "-l"): "ColorModel/Mode: Gray *RGB\nPageSize/Size: A4 A3\n"}
        recs, error = d.installed_printers(lambda args, timeout=25: outputs[tuple(args)], system="cups")
        self.assertIsNone(error)
        laser, ink = sorted(recs, key=lambda r: r["queue"])[::-1][0], [r for r in recs if r["queue"] == "Inkjet"][0]
        self.assertEqual(laser["connection"], "usb")
        self.assertTrue(laser["capabilities"]["duplex"] and not laser["capabilities"]["colour"])
        self.assertEqual((ink["state"], ink["connection"], ink["host"]), ("offline", "network", "192.168.1.50"))
        self.assertTrue(ink["capabilities"]["colour"])

    def test_installed_failure_is_reported(self):
        def boom(args, timeout=25):
            raise FileNotFoundError("lpstat")
        recs, error = d.installed_printers(boom, system="cups")
        self.assertEqual(recs, [])
        self.assertIn("Could not list", error)


class Merging(unittest.TestCase):
    def test_same_uuid_merges_usb_queue_and_network(self):
        usb = d.record("HP LaserJet M404", "usb", queue="HP LaserJet M404", uuid="u1", sources=["installed"])
        net = d.record_from_ipp(sample_attrs(**{"printer-uuid": (d.T_URI, "printer-uuid", ["urn:uuid:u1"])}), "192.168.1.9")
        merged = d.merge_records([usb, net])
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["host"], "192.168.1.9")
        self.assertEqual(merged[0]["queue"], "HP LaserJet M404")
        self.assertEqual(set(merged[0]["connections"]), {"usb", "network"})

    def test_model_and_host_merge_without_uuid(self):
        a = d.record("Epson ET-5800 Series", "network", host="10.0.0.5", queue="Epson ET-5800", sources=["installed"])
        b = d.record("EPSON ET-5800", "network", host="10.0.0.5", sources=["mdns"])
        self.assertEqual(len(d.merge_records([a, b])), 1)

    def test_two_printers_of_one_model_are_never_joined_by_guess(self):
        a = d.record("Brother HL-L2350DW", "network", host="10.0.0.5", sources=["mdns"])
        b = d.record("Brother HL-L2350DW", "network", host="10.0.0.6", sources=["mdns"])
        usb = d.record("Brother HL-L2350DW", "usb", queue="Brother", sources=["installed"])
        self.assertEqual(len(d.merge_records([a, b, usb])), 3)

    def test_lone_usb_queue_joins_its_only_network_twin(self):
        net = d.record("Canon MF445dw", "network", host="10.0.0.7", sources=["mdns"])
        queue = d.record("Canon MF445dw", "pc", queue="Canon MF445dw", sources=["installed"])
        self.assertEqual(len(d.merge_records([net, queue])), 1)

    def test_id_survives_new_ip_when_uuid_known(self):
        self.assertEqual(d.make_id("U", "x", "1.1.1.1", None), d.make_id("U", "x", "2.2.2.2", None))
        self.assertNotEqual(d.make_id(None, "x", "1.1.1.1", None), d.make_id(None, "x", "2.2.2.2", None))


class ManualAddress(unittest.TestCase):
    private = staticmethod(lambda host, port: [(2, 1, 6, "", ("192.168.1.40", 0))])
    public = staticmethod(lambda host, port: [(2, 1, 6, "", ("8.8.8.8", 0))])

    def test_rejects_bad_and_public_addresses(self):
        for bad in ("", "a b", "http://x/y", "host/../x", "1.2.3.4:99999"):
            with self.assertRaises(ValueError):
                d.validate_address(bad, self.private)
        with self.assertRaises(ValueError):
            d.validate_address("printer.example.com", self.public)

    def test_accepts_private_with_port(self):
        self.assertEqual(d.validate_address("192.168.1.40:9100", self.private), ("192.168.1.40", 9100))

    def test_manual_record_same_shape_and_failure_message(self):
        rec = d.manual_record("192.168.1.40", lambda h, p: sample_attrs(), self.private)
        self.assertIn("manual", rec["sources"])
        self.assertEqual(set(rec), set(d.mock_printers()[0]))
        def nobody(h, p):
            raise d.IppError("x")
        with self.assertRaises(ValueError) as caught:
            d.manual_record("192.168.1.40", nobody, self.private)
        self.assertNotIn("192.168.1.40", str(caught.exception))


class Mock(unittest.TestCase):
    def test_four_printers_with_the_four_situations(self):
        p = d.mock_printers()
        self.assertEqual(len(p), 4)
        self.assertEqual([x["state"] for x in p], ["ready", "ready", "offline", "paper-out"])
        self.assertEqual((p[0]["connection"], p[0]["capabilities"]["colour"]), ("usb", False))
        self.assertEqual((p[1]["connection"], p[1]["capabilities"]["colour"]), ("network", True))
        self.assertEqual(len({x["id"] for x in p}), 4)

    def test_scan_inventory_end_to_end_with_fakes(self):
        result = d.scan_inventory(manual=["192.168.1.40"], installed=lambda: ([d.record("Q", "usb", queue="Q", sources=["installed"])], None),
                                  browse=lambda: ([], "no mdns"), query=lambda h, p, *a, **k: sample_attrs(), resolver=ManualAddress.private)
        self.assertEqual(len(result["printers"]), 2)
        self.assertEqual(result["errors"], ["no mdns"])


class Manager(unittest.TestCase):
    def make(self, config, mock=True):
        now = [0.0]
        sent = []
        def request(path, body=None, claim=""):
            if path == "config":
                return json.dumps(config).encode()
            sent.append((path, body))
            return b"{}"
        m = d.PrinterManager(mock=mock, clock=lambda: now[0], background=False)
        return m, request, sent, now

    def test_nothing_scans_until_server_answers_config(self):
        m, request, sent, now = self.make({})
        def old(path, body=None, claim=""):
            raise d.HTTPError("u", 404, "nf", {}, None)
        m.tick(old)
        self.assertFalse(m.config_known)
        self.assertEqual(sent, [])
        self.assertIsNone(m.approved_ids())

    def test_scan_posts_inventory_and_reports_status_only_for_approved(self):
        ids = [p["id"] for p in d.mock_printers()]
        m, request, sent, now = self.make({"printers": [{"deviceId": ids[1], "enabled": True}], "scan": True})
        m.tick(request)
        inventory = [b for p, b in sent if p == "inventory"]
        self.assertEqual(len(inventory), 1)
        self.assertEqual(len(inventory[0]["printers"]), 4)
        self.assertEqual(m.approved_ids(), {ids[1]})
        beat = m.heartbeat()
        self.assertEqual(list(beat["status"]), [ids[1]])
        self.assertEqual(m.heartbeat(), {})                 # unchanged and fresh: nothing to resend
        now[0] += 21
        self.assertIn("status", m.heartbeat())              # but every ~20 s

    def test_rescan_on_request_and_every_ten_minutes(self):
        m, request, sent, now = self.make({"printers": [], "scan": False})
        m.tick(request)
        self.assertEqual(m.scans, 1)
        now[0] += 5; m.tick(request)
        self.assertEqual(m.scans, 1)
        m._poll_config(lambda p: json.dumps({"scan": True, "printers": []}).encode(), now[0])
        now[0] += 3; m.tick(request)
        self.assertEqual(m.scans, 2)
        now[0] += 601; m.tick(request)
        self.assertEqual(m.scans, 3)

    def test_state_change_is_sent_at_once(self):
        m, request, sent, now = self.make({"printers": [{"deviceId": d.mock_printers()[0]["id"]}]})
        m.tick(request); m.heartbeat()
        m.states[d.mock_printers()[0]["id"]]["state"] = "paper-out"
        self.assertEqual(m.heartbeat()["status"][d.mock_printers()[0]["id"]]["state"], "paper-out")

    def test_failed_scan_never_raises(self):
        m = d.PrinterManager(background=False, scan=lambda manual: 1 / 0)
        m._do_scan(lambda *a, **k: b"")
        self.assertIn("scan failed", m.log[0])
        self.assertFalse(m.scanning)


ITEM = {"pages": 2, "copies": 2, "duplex": True, "colour": True, "orientation": "Portrait", "paper": "A3", "pageRange": [1, "3-4"]}


class PrintJob(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.file = Path(self.tmp.name) / "document.pdf"
        self.file.write_bytes(b"%PDF-1.4 test")
        self.addCleanup(self.tmp.cleanup)
        self.mock = d.mock_printers()
        self.manager = d.PrinterManager(mock=True, background=False)
        self.manager.inventory = self.mock
        self.manager.config_known = True
        self.manager.wanted = {p["id"] for p in self.mock[:2]}

    def test_ipp_attributes(self):
        names = {a[1]: a[2] for a in d.ipp_job_attributes(ITEM)}
        self.assertEqual(names["copies"], [2])
        self.assertEqual(names["sides"], ["two-sided-long-edge"])
        self.assertEqual(names["print-color-mode"], ["color"])
        self.assertEqual(names["media"], ["iso_a3_297x420mm"])
        self.assertEqual(names["page-ranges"], [(1, 1), (3, 4)])
        self.assertEqual(names["orientation-requested"], [3])
        with self.assertRaises(ValueError):
            d.ipp_job_attributes({**ITEM, "colourPages": [1]})

    def test_pdf_capable_printer_gets_the_job_over_ipp(self):
        sent = []
        route = print_agent.print_job(self.mock[1]["id"], ITEM, self.file, manager=self.manager, ipp_send=lambda uri, pdf, item: sent.append((uri, pdf[:5])))
        self.assertEqual(route, "ipp")
        self.assertEqual(sent, [("ipp://192.168.1.50:631/ipp/print", b"%PDF-")])

    def test_queue_printer_uses_the_spooler_path(self):
        calls = []
        route = print_agent.print_job(self.mock[0]["id"], {**ITEM, "colour": False, "paper": "A4"}, self.file, manager=self.manager,
                                      runner=lambda cmd, **k: calls.append(cmd))
        self.assertEqual(route, "queue")
        self.assertEqual(calls[0][:3], ["lp", "-d", "Mock LaserJet"])

    def test_only_approved_printer_ids_print(self):
        with self.assertRaises(ValueError) as caught:
            print_agent.print_job(self.mock[3]["id"], ITEM, self.file, manager=self.manager, ipp_send=lambda *a: self.fail("must not print"))
        self.assertIn("approved", str(caught.exception))
        with self.assertRaises(ValueError):
            print_agent.print_job("p_unknown", ITEM, self.file, manager=self.manager)

    def test_offline_printer_is_refused(self):
        self.manager.wanted.add(self.mock[2]["id"])
        with self.assertRaises(ValueError) as caught:
            print_agent.print_job(self.mock[2]["id"], ITEM, self.file, manager=self.manager)
        self.assertIn("offline", str(caught.exception))

    def test_ipp_timeout_is_never_retried_it_may_have_printed(self):
        def silent(uri, pdf, item):
            raise d.IppTimeout("quiet")
        with self.assertRaises(print_agent.subprocess.TimeoutExpired):
            print_agent.print_job(self.mock[1]["id"], ITEM, self.file, manager=self.manager, ipp_send=silent)

    def test_ipp_refusal_becomes_a_clean_failure(self):
        def refuse(uri, pdf, item):
            raise d.IppError("The printer refused the job.")
        with self.assertRaises(ValueError):
            print_agent.print_job(self.mock[1]["id"], ITEM, self.file, manager=self.manager, ipp_send=refuse)

    def test_old_single_printer_mode_is_unchanged(self):
        calls = []
        print_agent.print_job("Front Desk", {**ITEM, "colour": False, "paper": "A4"}, self.file, runner=lambda cmd, **k: calls.append(cmd))
        self.assertEqual(calls[0][:3], ["lp", "-d", "Front Desk"])

    def test_ipp_print_builds_a_print_job_request(self):
        seen = {}
        def post(uri, body, timeout):
            seen["body"] = body
            return d.ipp_decode(ipp_answer([(d.G_JOB, [(d.T_INTEGER, "job-id", [7])])]))
        self.assertEqual(d.ipp_print("ipp://h:631/ipp/print", b"%PDF-1", ITEM, post), 7)
        self.assertEqual(struct.unpack(">H", seen["body"][2:4])[0], d.OP_PRINT_JOB)
        self.assertTrue(seen["body"].endswith(b"\x03%PDF-1"))


if __name__ == "__main__":
    unittest.main()

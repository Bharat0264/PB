"""Stage 2 tests: printer inventory, approval, routing, waiting and re-routing, test pages, agent routes and permissions."""
import json
import sqlite3
import tempfile
import time
import unittest
from contextlib import closing
from http.server import ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import fulfillment as ops
import print_agent
import print_discovery as disc
import printer_fleet as fleet
import server as app

NOW = 1_800_000_000
MOCK = disc.mock_printers()          # [laser B&W USB, colour inkjet Wi-Fi, offline, paper-out]
MONO, COLOUR, OFF, EMPTY = (p["id"] for p in MOCK)
ORDER = "a" * 32


def item(**over):
    return {"name": "x.pdf", "pages": 2, "copies": 1, "duplex": False, "colour": False, "orientation": "Portrait", "paper": "A4", **over}


def make_db(items=None):
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript(ops.SCHEMA + "CREATE TABLE orders (id TEXT PRIMARY KEY, status TEXT, details TEXT);CREATE TABLE files (order_id TEXT, position INTEGER);")
    items = items or [item()]
    db.execute("INSERT INTO orders VALUES (?,?,?)", (ORDER, "paid", json.dumps({"items": items})))
    db.executemany("INSERT INTO files VALUES (?,?)", [(ORDER, i) for i in range(len(items))])
    return db


def scan(db, printers=None, now=NOW):
    fleet.store_inventory(db, {"printers": printers if printers is not None else MOCK, "errors": [], "scannedAt": now}, now)


def add(db, device, name, now=NOW, **extra):
    return fleet.add_printer(db, {"deviceId": device, "name": name, **extra}, "warehouse", now)


def report(db, **states):
    fleet.ingest_status(db, {k: {"state": v} for k, v in states.items()}, NOW)


class Inventory(unittest.TestCase):
    def setUp(self):
        self.db = make_db()
        self.addCleanup(self.db.close)

    def test_inventory_is_cleaned_before_it_is_stored(self):
        bad = {**MOCK[0], "id": "p_0123456789ab", "host": "evil host; rm -rf", "state": "exploding", "model": "<script>alert(1)</script>" + "x" * 200,
               "capabilities": {"colour": "yes", "paperSizes": ["A4", "Folio", "A3"], "duplex": True}, "supplies": [{"name": "t", "level": 900}] * 30, "extra": "x"}
        junk = [None, "text", {"id": "../../etc"}, {"id": "p_short"}]
        fleet.store_inventory(self.db, {"printers": [bad] + junk, "errors": ["e" * 500]}, NOW)
        stored = json.loads(self.db.execute("SELECT data FROM printer_inventory").fetchone()["data"])
        self.assertEqual(len(stored), 1)
        p = stored[0]
        self.assertIsNone(p["host"])
        self.assertEqual(p["state"], "error")
        self.assertEqual(len(p["model"]), 80)
        self.assertEqual(p["capabilities"], {"colour": False, "duplex": True, "paperSizes": ["A4", "A3"], "maxSize": "A3", "pdf": False})
        self.assertEqual(len(p["supplies"]), 8)
        self.assertIsNone(p["supplies"][0]["level"])
        self.assertNotIn("extra", p)
        self.assertEqual(len(json.loads(self.db.execute("SELECT errors FROM printer_inventory").fetchone()["errors"])[0]), 200)

    def test_inventory_shape_is_rejected(self):
        with self.assertRaises(fleet.PrinterError):
            fleet.store_inventory(self.db, {"printers": "nope"}, NOW)
        with self.assertRaises(fleet.PrinterError):
            fleet.store_inventory(self.db, [], NOW)

    def test_scan_request_flows_to_agent_and_clears_when_answered(self):
        self.assertFalse(fleet.agent_config(self.db, NOW)["scan"])
        self.assertTrue(fleet.request_scan(self.db, None, NOW)["pending"])
        self.assertTrue(fleet.agent_config(self.db, NOW + 3)["scan"])
        self.assertFalse(fleet.agent_config(self.db, NOW + 200)["scan"])          # nobody answered: given up
        fleet.request_scan(self.db, None, NOW + 300)
        scan(self.db, now=NOW + 301)
        self.assertFalse(fleet.agent_config(self.db, NOW + 302)["scan"])

    def test_scan_is_rate_limited_and_not_repeated_while_pending(self):
        first = fleet.request_scan(self.db, None, NOW)
        self.assertEqual(fleet.request_scan(self.db, None, NOW + 5)["requestedAt"], first["requestedAt"])   # same request, not a new one
        scan(self.db, now=NOW + 6)
        with self.assertRaises(fleet.RateLimited):
            fleet.request_scan(self.db, None, NOW + 8)
        self.assertTrue(fleet.request_scan(self.db, None, NOW + 20)["pending"])

    def test_manual_address_is_validated_and_handed_to_the_agent(self):
        for bad in ("a b", "x/y", "", "x" * 200, "http://h"):
            with self.assertRaises(fleet.PrinterError):
                fleet.request_scan(self.db, bad, NOW)
        fleet.request_scan(self.db, "192.168.1.40", NOW)
        self.assertEqual(fleet.agent_config(self.db, NOW)["manual"], ["192.168.1.40"])


class Approval(unittest.TestCase):
    def setUp(self):
        self.db = make_db()
        self.addCleanup(self.db.close)
        scan(self.db)

    def test_only_a_printer_the_agent_found_can_be_added_and_facts_come_from_the_scan(self):
        with self.assertRaises(fleet.PrinterError):
            add(self.db, "p_aaaaaaaaaaaa", "Ghost")
        ident = add(self.db, COLOUR, "Colour desk", model="HACKED", host="6.6.6.6", capabilities={"colour": False})
        row = self.db.execute("SELECT * FROM printers WHERE id=?", (ident,)).fetchone()
        self.assertEqual((row["model"], row["host"], row["device_id"], row["connection"]), ("Mock InkJet Colour", "192.168.1.50", COLOUR, "network"))
        self.assertTrue(json.loads(row["capabilities"])["colour"])
        self.assertEqual(row["created_by"], "warehouse")

    def test_no_duplicates_and_unique_names_and_limit(self):
        add(self.db, MONO, "Front")
        with self.assertRaises(fleet.PrinterError):
            add(self.db, MONO, "Again")
        with self.assertRaises(fleet.PrinterError):
            add(self.db, COLOUR, "front")
        for bad in ("x" * 41, "ab"):
            with self.assertRaises(fleet.PrinterError):
                add(self.db, COLOUR, bad)
        self.db.execute("UPDATE printers SET name=name||'1'")
        for i in range(ops.MAX_PRINTERS):
            self.db.execute("INSERT INTO printers(name, system_name, created) VALUES (?,?,0)", (f"extra{i}", "q"))
        with self.assertRaises(fleet.PrinterError):
            add(self.db, COLOUR, "One more")

    def test_defaults_one_per_kind_colour_needs_a_colour_printer(self):
        a = add(self.db, MONO, "Mono A")
        b = add(self.db, COLOUR, "Colour B")
        row = lambda i: self.db.execute("SELECT * FROM printers WHERE id=?", (i,)).fetchone()
        self.assertEqual((row(a)["default_mono"], row(a)["default_colour"]), (1, 0))         # the first printer becomes the black and white default
        fleet.update_printer(self.db, b, {"defaultMono": True, "defaultColour": True}, "warehouse")
        self.assertEqual((row(a)["default_mono"], row(b)["default_mono"], row(b)["default_colour"]), (0, 1, 1))
        with self.assertRaises(fleet.PrinterError):
            fleet.update_printer(self.db, a, {"defaultColour": True}, "warehouse")             # a black and white printer
        self.assertEqual(row(b)["is_default"], 1)                                              # the older default follows

    def test_rename_pause_remove_are_audited(self):
        ident = add(self.db, MONO, "Front")
        fleet.update_printer(self.db, ident, {"name": "Back office"}, "admin")
        fleet.update_printer(self.db, ident, {"enabled": False}, "admin")
        fleet.update_printer(self.db, ident, {"enabled": True}, "admin")
        fleet.remove_printer(self.db, ident, "admin")
        actions = [r["action"] for r in self.db.execute("SELECT action FROM audit ORDER BY id")]
        self.assertEqual(actions, ["printer_added", "printer_renamed", "printer_paused", "printer_resumed", "printer_removed"])
        self.assertIsNone(self.db.execute("SELECT 1 FROM printer_status WHERE printer_id=?", (ident,)).fetchone())
        with self.assertRaises(fleet.PrinterError):
            fleet.update_printer(self.db, ident, {"name": "Gone"}, "admin")

    def test_agent_config_lists_only_approved_printers(self):
        add(self.db, MONO, "Front")
        paused = add(self.db, COLOUR, "Colour")
        fleet.update_printer(self.db, paused, {"enabled": False}, "warehouse")
        config = fleet.agent_config(self.db, NOW)
        self.assertEqual(config["printers"], [{"deviceId": MONO, "enabled": True}, {"deviceId": COLOUR, "enabled": False}])
        self.assertIn("192.168.1.50", config["manual"])

    def test_scan_refresh_updates_the_saved_address(self):
        add(self.db, COLOUR, "Colour")
        moved = {**MOCK[1], "host": "192.168.1.77"}
        scan(self.db, [moved])
        self.assertEqual(self.db.execute("SELECT host FROM printers").fetchone()["host"], "192.168.1.77")

    def test_fleet_view_marks_already_added_and_reports_the_agent(self):
        add(self.db, MONO, "Front")
        self.db.execute("INSERT INTO workstations VALUES ('print-agent', ?)", (NOW - 10,))
        view = fleet.fleet(self.db, NOW)
        self.assertEqual([p["alreadyAdded"] for p in view["inventory"]["printers"]], [True, False, False, False])
        self.assertTrue(view["agent"]["online"])
        self.assertFalse(fleet.fleet(self.db, NOW + 1000)["agent"]["online"])
        self.assertEqual(view["printers"][0]["state"], "ready")


class Routing(unittest.TestCase):
    def setUp(self):
        self.db = make_db([item(), item(colour=True), item(paper="A3"), item(duplex=True, colour=True)])
        self.addCleanup(self.db.close)
        scan(self.db)
        self.mono = add(self.db, MONO, "Mono")
        self.colour = add(self.db, COLOUR, "Colour")
        report(self.db, **{MONO: "ready", COLOUR: "ready"})

    def pick(self, position, now=NOW):
        return fleet.choose_printer(self.db, fleet.job_item(self.db, ORDER, position), now)

    def test_colour_goes_to_colour_printer_and_black_and_white_to_the_mono_default(self):
        fleet.update_printer(self.db, self.colour, {"defaultColour": True}, "warehouse")
        self.assertEqual(self.pick(0), self.mono)
        self.assertEqual(self.pick(1), self.colour)

    def test_an_incompatible_printer_is_rejected_with_the_exact_reason(self):
        for position, printer, reason in ((1, self.mono, "No colour"), (2, self.mono, "No A3"), (3, self.mono, "No colour")):
            with self.assertRaises(fleet.PrinterError) as caught:
                fleet.check_choice(self.db, printer, fleet.job_item(self.db, ORDER, position))
            self.assertIn(reason, str(caught.exception))
        fleet.check_choice(self.db, self.colour, fleet.job_item(self.db, ORDER, 3))
        with self.assertRaises(fleet.PrinterError):
            fleet.check_choice(self.db, 999, item())

    def test_a_paused_printer_cannot_be_chosen(self):
        fleet.update_printer(self.db, self.mono, {"enabled": False}, "warehouse")
        with self.assertRaises(fleet.PrinterError) as caught:
            fleet.check_choice(self.db, self.mono, item())
        self.assertIn("Paused", str(caught.exception))
        self.assertEqual(self.pick(0), self.colour)                         # auto choice skips it

    def test_nothing_fits_is_an_error_not_a_silent_default(self):
        fleet.update_printer(self.db, self.colour, {"enabled": False}, "warehouse")
        with self.assertRaises(fleet.PrinterError):
            self.pick(1)

    def test_auto_choice_prefers_a_working_printer(self):
        fleet.update_printer(self.db, self.colour, {"defaultMono": True}, "warehouse")
        report(self.db, **{COLOUR: "offline"})
        self.assertEqual(self.pick(0), self.mono)

    def test_no_discovered_printers_means_the_older_behaviour(self):
        db = make_db()
        self.assertIsNone(fleet.choose_printer(db, item()))
        self.assertTrue(ops.queue_job(db, ORDER, 0))
        self.assertIsNotNone(ops.claim_job(db, "w"))


class WaitingAndReroute(unittest.TestCase):
    def setUp(self):
        self.db = make_db([item(colour=True)])
        self.addCleanup(self.db.close)
        scan(self.db)
        self.mono = add(self.db, MONO, "Mono")
        self.colour = add(self.db, COLOUR, "Colour")
        self.colour2 = self.db.execute("INSERT INTO printers(name, system_name, created, device_id, capabilities, enabled) VALUES ('Second colour','q',0,'p_bbbbbbbbbbbb',?,1)",
                                       (json.dumps({"colour": True, "duplex": True, "paperSizes": ["A4"]}),)).lastrowid
        report(self.db, **{MONO: "ready", COLOUR: "ready"})
        fleet.ingest_status(self.db, {"p_bbbbbbbbbbbb": {"state": "ready"}}, NOW)
        self.assertTrue(ops.queue_job(self.db, ORDER, 0, "warehouse", self.colour))

    def test_offline_printer_keeps_the_job_waiting_and_it_is_not_claimed(self):
        report(self.db, **{COLOUR: "paper-out"})
        self.assertIsNone(ops.claim_job(self.db, "agent", NOW))
        self.assertEqual(fleet.waiting_reason(self.db, ORDER, 0, NOW), "Out of paper")
        self.assertEqual(self.db.execute("SELECT state FROM print_jobs").fetchone()["state"], "queued")
        report(self.db, **{COLOUR: "ready"})
        self.assertIsNone(fleet.waiting_reason(self.db, ORDER, 0, NOW))
        self.assertIsNotNone(ops.claim_job(self.db, "agent", NOW))

    def test_a_silent_printer_counts_as_offline(self):
        self.assertIsNotNone(ops.claim_job(self.db, "agent", NOW + 60))
        self.db.execute("UPDATE print_jobs SET state='queued', worker=NULL")
        self.assertIsNone(ops.claim_job(self.db, "agent", NOW + 500))
        self.assertEqual(fleet.waiting_reason(self.db, ORDER, 0, NOW + 500), "No update from the print PC")

    def test_a_dead_printer_does_not_block_other_printers(self):
        second = "b" * 32
        self.db.execute("INSERT INTO orders VALUES (?,?,?)", (second, "paid", json.dumps({"items": [item()]})))
        self.db.execute("INSERT INTO files VALUES (?,0)", (second,))
        ops.queue_job(self.db, second, 0, "warehouse", self.mono)
        report(self.db, **{COLOUR: "offline"})
        job = ops.claim_job(self.db, "agent", NOW)
        self.assertEqual(job["order_id"], second)

    def test_reroute_moves_a_waiting_job_in_one_step_and_checks_fit(self):
        report(self.db, **{COLOUR: "offline"})
        with self.assertRaises(fleet.PrinterError):
            fleet.reroute(self.db, ORDER, 0, self.mono, "warehouse")                 # no colour
        fleet.reroute(self.db, ORDER, 0, self.colour2, "warehouse")
        self.assertEqual(ops.job_printer(self.db, {"order_id": ORDER, "position": 0}), "p_bbbbbbbbbbbb")
        job = ops.claim_job(self.db, "agent", NOW)
        self.assertEqual(job["order_id"], ORDER)
        self.assertEqual(self.db.execute("SELECT count(*) FROM audit WHERE action='print_rerouted'").fetchone()[0], 1)

    def test_a_job_being_printed_or_done_can_never_be_moved(self):
        job = ops.claim_job(self.db, "agent", NOW)
        with self.assertRaises(ops.Conflict):
            fleet.reroute(self.db, ORDER, 0, self.colour2, "warehouse")
        ops.finish_job(self.db, job["id"], "agent", "done", None)
        with self.assertRaises(ops.Conflict):
            fleet.reroute(self.db, ORDER, 0, self.colour2, "warehouse")

    def test_a_job_is_claimed_once_and_requeueing_never_prints_twice(self):
        job = ops.claim_job(self.db, "one", NOW)
        self.assertIsNone(ops.claim_job(self.db, "two", NOW))
        self.assertFalse(ops.queue_job(self.db, ORDER, 0, "warehouse", self.colour))          # still printing: no second job
        self.assertTrue(ops.finish_job(self.db, job["id"], "one", "done", None))
        self.assertFalse(ops.queue_job(self.db, ORDER, 0, "warehouse", self.colour))          # done: no second job
        self.assertEqual(self.db.execute("SELECT count(*) FROM print_jobs").fetchone()[0], 1)

    def test_used_counts_and_last_used(self):
        job = ops.claim_job(self.db, "one", NOW)
        ops.finish_job(self.db, job["id"], "one", "done", None)
        now = int(time.time())
        view = {p["id"]: p for p in fleet.fleet(self.db, now)["printers"]}
        self.assertEqual(view[self.colour]["jobsToday"], 1)
        self.assertIsNotNone(view[self.colour]["lastUsed"])
        self.assertEqual(view[self.mono]["jobsToday"], 0)


class TestPages(unittest.TestCase):
    def setUp(self):
        self.db = make_db()
        self.addCleanup(self.db.close)
        scan(self.db)
        self.mono = add(self.db, MONO, "Mono")
        report(self.db, **{MONO: "ready"})

    def test_test_page_is_queued_once_claimed_once_and_finished(self):
        self.assertTrue(fleet.queue_test(self.db, self.mono, "warehouse", NOW))
        self.assertFalse(fleet.queue_test(self.db, self.mono, "warehouse", NOW + 5))        # double press: one page
        test = fleet.claim_test(self.db, "c1", NOW)
        self.assertEqual((test["printer"], test["name"]), (MONO, "Mono"))
        self.assertIsNone(fleet.claim_test(self.db, "c2", NOW))
        self.assertFalse(fleet.finish_test(self.db, test["id"], "other", "done", None))
        self.assertTrue(fleet.finish_test(self.db, test["id"], "c1", "done", None))

    def test_no_test_page_for_a_paused_or_offline_printer(self):
        report(self.db, **{MONO: "offline"})
        with self.assertRaises(fleet.PrinterError):
            fleet.queue_test(self.db, self.mono, "warehouse", NOW)
        report(self.db, **{MONO: "ready"})
        fleet.update_printer(self.db, self.mono, {"enabled": False}, "warehouse")
        with self.assertRaises(fleet.PrinterError):
            fleet.queue_test(self.db, self.mono, "warehouse", NOW)

    def test_agent_makes_a_valid_test_pdf(self):
        pdf = print_agent.make_test_pdf("Front (desk) \\ é")
        self.assertTrue(pdf.startswith(b"%PDF-1.4") and pdf.rstrip().endswith(b"%%EOF"))
        start = int(pdf.split(b"startxref\n")[1].split(b"\n")[0])
        self.assertTrue(pdf[start:].startswith(b"xref"))


class Migration(unittest.TestCase):
    def test_an_old_database_is_upgraded_without_losing_printers_or_jobs(self):
        db = sqlite3.connect(":memory:")
        db.row_factory = sqlite3.Row
        db.executescript("""
            CREATE TABLE print_jobs (id INTEGER PRIMARY KEY, order_id TEXT NOT NULL, position INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'queued', worker TEXT, error TEXT, UNIQUE(order_id, position));
            CREATE TABLE printers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, system_name TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
            CREATE TABLE print_job_printer (order_id TEXT NOT NULL, position INTEGER NOT NULL, printer_id INTEGER NOT NULL, PRIMARY KEY(order_id, position));
            INSERT INTO printers VALUES (1,'Front desk','HP_Front',1,5);
        """)
        db.executescript(ops.SCHEMA)
        ops.migrate(db)
        ops.migrate(db)                                    # running it twice is harmless
        row = db.execute("SELECT * FROM printers").fetchone()
        self.assertEqual((row["name"], row["enabled"], row["device_id"]), ("Front desk", 1, None))
        self.assertEqual(ops.job_printer(db, {"order_id": "x", "position": 0}), "HP_Front")      # the older name still goes to the agent
        self.assertIn("finished", {c["name"] for c in db.execute("PRAGMA table_info(print_job_printer)")})
        db.execute("INSERT INTO printers(name, system_name, created, device_id) VALUES ('a','a',0,'p_x')")
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute("INSERT INTO printers(name, system_name, created, device_id) VALUES ('b','b',0,'p_x')")


class HttpRoutes(unittest.TestCase):
    """The routes end to end: permissions, the agent loop with the mock printers, and a job going to the right printer."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = patch.object(app, "DATA", Path(self.tmp.name))
        patcher.start()
        self.addCleanup(patcher.stop)
        with closing(app.connect()) as db, db:
            db.executescript(app.auth.SCHEMA + app.ops.SCHEMA + """
                CREATE TABLE orders(id TEXT PRIMARY KEY, token TEXT, status TEXT, details TEXT);
                CREATE TABLE files(order_id TEXT, position INTEGER, content BLOB, object_key TEXT, PRIMARY KEY(order_id, position));
                CREATE TABLE order_owners(order_id TEXT, order_number TEXT, email TEXT);
            """)
            items = [item(), item(colour=True)]
            db.execute("INSERT INTO orders VALUES (?,?,?,?)", (ORDER, "t", "paid", json.dumps({"items": items})))
            db.executemany("INSERT INTO files(order_id, position, content) VALUES (?,?,?)", [(ORDER, 0, b"%PDF-1.4 a"), (ORDER, 1, b"%PDF-1.4 b")])
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), app.PrintBee)
        self.server.keys = {"warehouse": "wh-key", "admin": "ad-key", "delivery": "de-key", "print-agent": "ag-key"}
        self.server.google_access = {"warehouse": {}, "admin": {}, "partner": {}}
        self.server.partners, self.server.partner_phones, self.server.checkout_terms = {}, {}, {}
        thread = Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(lambda: (self.server.shutdown(), thread.join(), self.server.server_close()))

    def call(self, key, path, body=None):
        headers = {"X-Staff-Key": key, "Content-Type": "application/json"}
        request = Request(f"http://127.0.0.1:{self.server.server_port}{path}", None if body is None else json.dumps(body).encode(), headers)
        try:
            with urlopen(request, timeout=5) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            with error:
                return error.code, json.loads(error.read() or b"{}")

    def test_permissions(self):
        for path, body in (("/api/staff/printers", None), ("/api/staff/printers/scan", {}), ("/api/staff/printers/1/update", {"name": "x"}),
                           ("/api/staff/printers/1/remove", {}), ("/api/staff/printers/1/test", {}), ("/api/staff/printers", {"deviceId": MONO, "name": "x"})):
            for key in ("", "de-key", "ag-key"):
                self.assertEqual(self.call(key, path, body)[0], 403, (path, key))
        for key in ("", "wh-key", "ad-key", "de-key"):
            self.assertIn(self.call(key, "/api/print-agent/config")[0], (403, 404))          # not found to anyone but the agent
            self.assertEqual(self.call(key, "/api/print-agent/inventory", {"printers": []})[0], 403)
        self.assertEqual(self.call("ag-key", "/api/print-agent/config")[0], 200)
        self.assertEqual(self.call("wh-key", "/api/staff/printers")[0], 200)
        self.assertEqual(self.call("ad-key", "/api/staff/printers")[0], 200)

    def test_scan_to_print_with_the_mock_agent(self):
        self.assertEqual(self.call("wh-key", "/api/staff/printers/scan", {})[1]["pending"], True)
        config = self.call("ag-key", "/api/print-agent/config")[1]
        self.assertTrue(config["scan"])
        manager = disc.PrinterManager(mock=True, background=False)

        def agent_request(path, body=None, claim=""):
            status, data = self.call("ag-key", "/api/print-agent/" + path, body)
            if status != 200:
                raise HTTPError("u", status, "x", {}, None)
            return json.dumps(data).encode()
        manager.tick(agent_request)
        view = self.call("wh-key", "/api/staff/printers")[1]
        self.assertEqual(len(view["inventory"]["printers"]), 4)
        self.assertFalse(view["inventory"]["scanning"])
        for device, name in ((MONO, "Mono desk"), (COLOUR, "Colour desk")):
            self.assertEqual(self.call("wh-key", "/api/staff/printers", {"deviceId": device, "name": name})[0], 200)
        agent_request("claim", {})           # a poll with status; the mock agent reports ready
        manager.manual, manager.wanted, manager.config_known = [], {MONO, COLOUR}, True
        manager.states = {MONO: {"state": "ready", "reasons": [], "supplies": []}, COLOUR: {"state": "ready", "reasons": [], "supplies": []}}
        agent_request("claim", manager.heartbeat())
        # a colour file with no printer chosen goes to the colour printer; a black and white one to the black and white printer
        status, queued = self.call("wh-key", f"/api/staff/orders/{ORDER}/print/all", {})
        self.assertEqual(status, 200, queued)
        printers = self.call("wh-key", "/api/staff/printers")[1]["printers"]
        by_device = {p["deviceId"]: p["id"] for p in printers}
        self.assertEqual(queued["printers"], {"0": by_device[MONO], "1": by_device[COLOUR]})
        sent = []
        for _ in range(2):
            job = agent_request("claim", manager.heartbeat())
            job = json.loads(job)["job"]
            sent.append(job["printer"])
        self.assertEqual(sorted(sent), sorted([MONO, COLOUR]))

    def test_incompatible_choice_is_refused_and_nothing_is_queued(self):
        with closing(app.connect()) as db, db:
            fleet.store_inventory(db, {"printers": MOCK}, int(time.time()))
            mono = fleet.add_printer(db, {"deviceId": MONO, "name": "Mono"}, "warehouse")
            fleet.ingest_status(db, {MONO: {"state": "ready"}})
        status, body = self.call("wh-key", f"/api/staff/orders/{ORDER}/print/all", {"printerId": mono})
        self.assertEqual(status, 400)
        self.assertIn("No colour", body["error"])
        with closing(app.connect()) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM print_jobs").fetchone()[0], 0)
        self.assertEqual(self.call("wh-key", f"/api/staff/orders/{ORDER}/print/0", {"printerId": mono})[0], 200)

    def test_scan_route_is_rate_limited(self):
        self.call("wh-key", "/api/staff/printers/scan", {})
        with closing(app.connect()) as db, db:
            fleet.store_inventory(db, {"printers": []}, int(time.time()))
        status, body = self.call("wh-key", "/api/staff/printers/scan", {})
        self.assertEqual(status, 429)

    def test_bad_requests_get_clean_errors(self):
        self.assertEqual(self.call("wh-key", "/api/staff/printers/scan", {"address": 5})[0], 400)
        self.assertEqual(self.call("wh-key", "/api/staff/printers", {"deviceId": "p_aaaaaaaaaaaa", "name": "x"})[0], 400)
        self.assertEqual(self.call("wh-key", "/api/staff/printers/99/update", {"name": "x"})[0], 400)
        self.assertEqual(self.call("ag-key", "/api/print-agent/inventory", {"printers": 3})[0], 400)

    def test_test_page_route_reaches_the_agent(self):
        with closing(app.connect()) as db, db:
            fleet.store_inventory(db, {"printers": MOCK}, int(time.time()))
            mono = fleet.add_printer(db, {"deviceId": MONO, "name": "Mono"}, "warehouse")
            fleet.ingest_status(db, {MONO: {"state": "ready"}})
        self.assertEqual(self.call("wh-key", f"/api/staff/printers/{mono}/test", {})[1]["queued"], True)
        job = self.call("ag-key", "/api/print-agent/claim", {})[1]["job"]
        self.assertTrue(job["test"])
        self.assertEqual(job["printer"], MONO)


if __name__ == "__main__":
    unittest.main()

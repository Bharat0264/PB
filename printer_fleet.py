"""Server side of printer discovery: what the agent found, which printers staff approved, their live state, and which printer fits a job.

The server never contacts a printer. The agent on the print-room PC scans, then posts what it found (`store_inventory`) and the state of the
approved printers (`ingest_status`); staff turn a found printer into an approved one (`add_printer`). Everything the agent sends is checked and
trimmed here before it is stored: it is a suggestion, never an instruction.
"""

import json
import re
import time

import fulfillment as ops
from fulfillment import PrinterError, audit

STATES = ("ready", "busy", "offline", "paper-out", "toner-low", "error")
CONNECTIONS = ("usb", "network", "pc")
PAPERS = ("A5", "Letter", "A4", "Legal", "A3")
DEVICE_ID = re.compile(r"p_[0-9a-f]{12}")
HOST = re.compile(r"[A-Za-z0-9.:\-\[\]]{1,64}")
SCAN_PENDING_SECONDS = 120        # a scan request the agent has not answered by now is given up
SCAN_MIN_GAP = 10                 # seconds between finished scan and the next request
AGENT_ONLINE_SECONDS = 180
REASON_TEXT = {"offline": "Printer is offline", "no-answer": "Printer did not answer", "agent-silent": "No update from the print PC", "paused": "Paused by staff",
               "paper-out": "Out of paper", "media-empty": "Out of paper", "media-needed": "Out of paper", "toner-low": "Toner low", "toner-empty": "Out of toner", "media-jam": "Paper jam",
               "door-open": "Cover open", "error": "Printer error"}


class RateLimited(PrinterError):
    """Too many scan requests."""


def _text(value, limit):
    return " ".join(str(value or "").split())[:limit] if isinstance(value, (str, int)) and not isinstance(value, bool) else ""


def _loads(text, default):
    try:
        return json.loads(text) if text else default
    except ValueError:
        return default


# ---- what the agent sends: checked and trimmed -------------------------------------------------------------------

def clean_supplies(items):
    out = []
    for item in (items if isinstance(items, list) else [])[:8]:
        if isinstance(item, dict):
            level = item.get("level")
            out.append({"name": _text(item.get("name"), 40), "type": _text(item.get("type"), 24),
                        "level": level if type(level) is int and 0 <= level <= 100 else None})
    return out


def clean_state(value):
    return value if value in STATES else "error"


def clean_reasons(items):
    return [_text(r, 40) for r in (items if isinstance(items, list) else [])[:6] if _text(r, 40)]


def clean_printer(item):
    """One found printer, or None when it is not usable. Only known fields survive, and only in a safe form."""
    if not isinstance(item, dict) or not DEVICE_ID.fullmatch(str(item.get("id", ""))):
        return None
    caps = item.get("capabilities") if isinstance(item.get("capabilities"), dict) else {}
    sizes = [p for p in PAPERS if p in (caps.get("paperSizes") if isinstance(caps.get("paperSizes"), list) else [])]
    host = item.get("host")
    return {"id": item["id"], "model": _text(item.get("model"), 80) or "Printer",
            "connection": item.get("connection") if item.get("connection") in CONNECTIONS else "pc",
            "host": host if isinstance(host, str) and HOST.fullmatch(host) else None,
            "queue": _text(item.get("queue"), 120) or None, "state": clean_state(item.get("state")), "reasons": clean_reasons(item.get("reasons")),
            "capabilities": {"colour": caps.get("colour") is True, "duplex": caps.get("duplex") is True, "paperSizes": sizes,
                             "maxSize": sizes[-1] if sizes else None, "pdf": caps.get("pdf") is True},
            "supplies": clean_supplies(item.get("supplies")), "mock": item.get("mock") is True, "note": _text(item.get("note"), 120)}


def store_inventory(db, data, now=None):
    """The agent's latest scan. Replaces the previous one, clears the scan request, and refreshes the saved printers it knows."""
    now = int(time.time()) if now is None else now
    if not isinstance(data, dict) or not isinstance(data.get("printers"), list):
        raise PrinterError("Invalid inventory.")
    printers = [p for p in (clean_printer(i) for i in data["printers"][:60]) if p]
    errors = [_text(e, 200) for e in (data.get("errors") if isinstance(data.get("errors"), list) else [])[:6] if _text(e, 200)]
    db.execute("INSERT INTO printer_inventory(id, data, errors, scanned_at, scan_requested) VALUES (1,?,?,?,NULL) "
               "ON CONFLICT(id) DO UPDATE SET data=excluded.data, errors=excluded.errors, scanned_at=excluded.scanned_at, scan_requested=NULL",
               (json.dumps(printers), json.dumps(errors), now))
    for p in printers:                    # keep saved printers' address and abilities current (their IP can change)
        db.execute("UPDATE printers SET host=?, connection=?, capabilities=?, model=? WHERE device_id=?",
                   (p["host"], p["connection"], json.dumps(p["capabilities"]), p["model"], p["id"]))
    return len(printers)


def ingest_status(db, status, now=None):
    """The agent's report on approved printers: {device id: {state, reasons, supplies}}. Unknown ids are ignored."""
    now = int(time.time()) if now is None else now
    if not isinstance(status, dict):
        return 0
    saved = 0
    for device_id, report in list(status.items())[:40]:
        row = db.execute("SELECT id FROM printers WHERE device_id=?", (device_id,)).fetchone() if isinstance(device_id, str) and isinstance(report, dict) else None
        if row:
            db.execute("INSERT INTO printer_status(printer_id, state, reasons, supplies, updated_at) VALUES (?,?,?,?,?) "
                       "ON CONFLICT(printer_id) DO UPDATE SET state=excluded.state, reasons=excluded.reasons, supplies=excluded.supplies, updated_at=excluded.updated_at",
                       (row["id"], clean_state(report.get("state")), json.dumps(clean_reasons(report.get("reasons"))),
                        json.dumps(clean_supplies(report.get("supplies"))), now))
            saved += 1
    return saved


# ---- scan requests -----------------------------------------------------------------------------------------------

def request_scan(db, address=None, now=None):
    """Staff pressed 'Add printer'. Sets a flag the agent sees on its next poll. Returns {'pending': True}; a request already waiting is not repeated,
    and asking again right after a scan finished is refused (the printers were only just looked at)."""
    now = int(time.time()) if now is None else now
    row = db.execute("SELECT scan_requested, scanned_at, scan_manual FROM printer_inventory WHERE id=1").fetchone()
    manual = _loads(row["scan_manual"], []) if row else []
    if address is not None:
        if not isinstance(address, str) or len(address) > 100:
            raise PrinterError("Enter an IP address or hostname, like 192.168.1.40.")
        address = _text(address, 100)
        if not re.fullmatch(r"[A-Za-z0-9.:\-\[\]]{1,100}", address):
            raise PrinterError("Enter an IP address or hostname, like 192.168.1.40.")
        manual = ([address] + [m for m in manual if m != address])[:5]
    else:
        if row and row["scan_requested"] and now - row["scan_requested"] < SCAN_PENDING_SECONDS:
            return {"pending": True, "requestedAt": row["scan_requested"]}
        if row and row["scanned_at"] and now - row["scanned_at"] < SCAN_MIN_GAP:
            raise RateLimited("Printers were just scanned. Wait a few seconds and try again.")
    db.execute("INSERT INTO printer_inventory(id, scan_requested, scan_manual) VALUES (1,?,?) "
               "ON CONFLICT(id) DO UPDATE SET scan_requested=excluded.scan_requested, scan_manual=excluded.scan_manual", (now, json.dumps(manual)))
    return {"pending": True, "requestedAt": now}


def agent_config(db, now=None):
    """What the agent asks every poll: which printer ids it may print to, whether staff want a scan now, and addresses to look at by hand."""
    now = int(time.time()) if now is None else now
    inventory = db.execute("SELECT scan_requested, scan_manual FROM printer_inventory WHERE id=1").fetchone()
    printers = db.execute("SELECT device_id, enabled, host, connection FROM printers WHERE device_id IS NOT NULL").fetchall()
    manual = _loads(inventory["scan_manual"], []) if inventory else []
    manual += [p["host"] for p in printers if p["host"] and p["connection"] == "network" and p["host"] not in manual]
    return {"printers": [{"deviceId": p["device_id"], "enabled": bool(p["enabled"])} for p in printers],
            "scan": bool(inventory and inventory["scan_requested"] and now - inventory["scan_requested"] < SCAN_PENDING_SECONDS),
            "manual": manual[:5]}


# ---- fit and routing -----------------------------------------------------------------------------------------------

def fit_problem(printer, item):
    """Why this printer cannot print this job ('No colour', 'No A3', ...), or None. A printer with no recorded abilities (an older one) is not checked."""
    if not printer["enabled"]:
        return "Paused"
    caps = _loads(printer["capabilities"], None)
    if not isinstance(caps, dict):
        return None
    if item.get("colour") and not caps.get("colour"):
        return "No colour"
    if item.get("duplex") and not caps.get("duplex"):
        return "No double-sided"
    sizes = caps.get("paperSizes") or []
    paper = item.get("paper", "A4")
    if sizes and paper not in sizes:
        return f"No {paper}"
    return None


def effective_state(db, printer, now=None):
    """(state, reasons) the warehouse should believe: paused, or silent for too long, counts as offline; never reported counts as ready."""
    now = int(time.time()) if now is None else now
    if not printer["enabled"]:
        return "offline", ["paused"]
    if not printer["device_id"]:
        return "ready", []
    row = db.execute("SELECT state, reasons, updated_at FROM printer_status WHERE printer_id=?", (printer["id"],)).fetchone()
    if not row:
        return "ready", []
    if now - row["updated_at"] > ops.STATUS_FRESH:
        return "offline", ["agent-silent"]
    return row["state"], _loads(row["reasons"], [])


def job_item(db, order_id, position):
    row = db.execute("SELECT details FROM orders WHERE id=?", (order_id,)).fetchone()
    try:
        return json.loads(row["details"])["items"][position] if row else None
    except (ValueError, KeyError, IndexError, TypeError):
        return None


def choose_printer(db, item, now=None):
    """The best approved printer for a job when staff did not pick one: colour job -> the default colour printer, black and white -> the default
    black and white printer, else any printer that fits and is working, else any that fits. None when no discovered printers are set up
    (the older single-printer behaviour then applies). Raises PrinterError when printers exist but none can print the job."""
    printers = db.execute("SELECT * FROM printers WHERE device_id IS NOT NULL ORDER BY id").fetchall()
    if not printers:
        return None
    fitting = [p for p in printers if not fit_problem(p, item)]
    if not fitting:
        raise PrinterError("No printer can print this job: " + (fit_problem(printers[0], item) or "none fit") + ".")
    working = [p for p in fitting if effective_state(db, p, now)[0] not in ops.HOLD_STATES]
    default_column = "default_colour" if item.get("colour") else "default_mono"
    for pool in (working, fitting):
        for p in pool:
            if p[default_column]:
                return p["id"]
        if pool:
            return pool[0]["id"]
    return None


def check_choice(db, printer_id, item):
    """The printer staff picked must exist, be approved and fit the job. Raises PrinterError with the exact reason."""
    printer = db.execute("SELECT * FROM printers WHERE id=?", (printer_id,)).fetchone()
    if not printer:
        raise PrinterError("Choose one of the saved printers.")
    problem = fit_problem(printer, item) if item else None
    if problem:
        raise PrinterError(f"{printer['name']} can't print this job: {problem}.")
    return printer


def reroute(db, order_id, position, printer_id, actor):
    """Send a job that is still waiting to another printer, in one step. Only a queued job can move: one being printed or done never does."""
    job = db.execute("SELECT state FROM print_jobs WHERE order_id=? AND position=?", (order_id, position)).fetchone()
    if not job or job["state"] != "queued":
        raise ops.Conflict("This file is no longer waiting, so it can't be moved.")
    check_choice(db, printer_id, job_item(db, order_id, position))
    db.execute("INSERT INTO print_job_printer(order_id, position, printer_id) VALUES (?,?,?) "
               "ON CONFLICT(order_id, position) DO UPDATE SET printer_id=excluded.printer_id", (order_id, position, printer_id))
    audit(db, actor, "print_rerouted", order_id)


def waiting_reason(db, order_id, position, now=None):
    """Why a queued job is not printing yet ('Printer is offline'...), or None when the agent can take it."""
    row = db.execute("SELECT printers.* FROM print_job_printer JOIN printers ON printers.id=print_job_printer.printer_id "
                     "WHERE order_id=? AND position=?", (order_id, position)).fetchone()
    if not row:
        return None
    state, reasons = effective_state(db, row, now)
    if state in ops.HOLD_STATES:
        return REASON_TEXT.get(reasons[0] if reasons else state, "Printer is not ready")
    return None


# ---- approved printers --------------------------------------------------------------------------------------------

def _name(value):
    name = " ".join(str(value or "").split())
    if not name or len(name) > 40 or any(ord(c) < 32 for c in name):
        raise PrinterError("Enter a printer name of up to 40 characters.")
    return name


def _unique_name(db, name, ident=None):
    if db.execute("SELECT 1 FROM printers WHERE lower(name)=lower(?) AND (? IS NULL OR id!=?)", (name, ident, ident)).fetchone():
        raise PrinterError("Another printer already has that name.")


def _set_defaults(db, ident, mono, colour):
    printer = db.execute("SELECT capabilities FROM printers WHERE id=?", (ident,)).fetchone()
    caps = _loads(printer["capabilities"], None)
    if colour and isinstance(caps, dict) and not caps.get("colour"):
        raise PrinterError("This printer can't print in colour, so it can't be the colour default.")
    if mono:
        db.execute("UPDATE printers SET default_mono=(id=?)", (ident,))
        db.execute("UPDATE printers SET is_default=(id=?)", (ident,))      # the older single default follows the black and white one
    elif mono is False:
        db.execute("UPDATE printers SET default_mono=0 WHERE id=?", (ident,))
    if colour:
        db.execute("UPDATE printers SET default_colour=(id=?)", (ident,))
    elif colour is False:
        db.execute("UPDATE printers SET default_colour=0 WHERE id=?", (ident,))


def add_printer(db, data, actor, now=None):
    """Approve a printer the agent found. The device id must be in the latest scan; the model, address and abilities come from the scan,
    never from the request."""
    now = int(time.time()) if now is None else now
    device_id = data.get("deviceId")
    inventory = db.execute("SELECT data FROM printer_inventory WHERE id=1").fetchone()
    found = next((p for p in _loads(inventory["data"], []) if p["id"] == device_id), None) if inventory and isinstance(device_id, str) else None
    if not found:
        raise PrinterError("That printer was not found. Scan again and pick it from the list.")
    if db.execute("SELECT 1 FROM printers WHERE device_id=?", (device_id,)).fetchone():
        raise PrinterError("That printer is already added.")
    if db.execute("SELECT count(*) FROM printers").fetchone()[0] >= ops.MAX_PRINTERS:
        raise PrinterError(f"You can add up to {ops.MAX_PRINTERS} printers.")
    name = _name(data.get("name") or found["model"])
    _unique_name(db, name)
    first = not db.execute("SELECT 1 FROM printers WHERE device_id IS NOT NULL").fetchone()
    ident = db.execute(
        "INSERT INTO printers(name, system_name, is_default, created, device_id, model, connection, host, capabilities, enabled, created_by, created_at) "
        "VALUES (?,?,0,?,?,?,?,?,?,1,?,?)",
        (name, found["queue"] or device_id, now, device_id, found["model"], found["connection"], found["host"],
         json.dumps(found["capabilities"]), actor, now)).lastrowid
    colour = found["capabilities"]["colour"]
    mono = data.get("defaultMono") is True or (first and "defaultMono" not in data)
    wants_colour = data.get("defaultColour") is True or (first and colour and "defaultColour" not in data)
    _set_defaults(db, ident, mono or None, wants_colour or None)
    db.execute("INSERT INTO printer_status(printer_id, state, reasons, supplies, updated_at) VALUES (?,?,?,?,?)",
               (ident, found["state"], json.dumps(found["reasons"]), json.dumps(found["supplies"]), now))
    audit(db, actor, "printer_added", str(ident))
    return ident


def update_printer(db, ident, data, actor):
    """Rename, change the defaults, pause or resume. Each change is written to the audit log."""
    printer = db.execute("SELECT * FROM printers WHERE id=?", (ident,)).fetchone()
    if not printer:
        raise PrinterError("That printer no longer exists.")
    if "name" in data:
        name = _name(data["name"])
        _unique_name(db, name, ident)
        if name != printer["name"]:
            db.execute("UPDATE printers SET name=? WHERE id=?", (name, ident))
            audit(db, actor, "printer_renamed", str(ident))
    if "enabled" in data:
        if type(data["enabled"]) is not bool:
            raise PrinterError("Invalid request.")
        if data["enabled"] != bool(printer["enabled"]):
            db.execute("UPDATE printers SET enabled=? WHERE id=?", (int(data["enabled"]), ident))
            audit(db, actor, "printer_resumed" if data["enabled"] else "printer_paused", str(ident))
    mono = data.get("defaultMono") if type(data.get("defaultMono")) is bool else None
    colour = data.get("defaultColour") if type(data.get("defaultColour")) is bool else None
    if mono is not None or colour is not None:
        _set_defaults(db, ident, mono, colour)
        audit(db, actor, "printer_defaults_changed", str(ident))


def remove_printer(db, ident, actor):
    ops.remove_printer(db, ident, actor)
    db.execute("DELETE FROM printer_status WHERE printer_id=?", (ident,))
    db.execute("DELETE FROM printer_tests WHERE printer_id=?", (ident,))


# ---- test pages ------------------------------------------------------------------------------------------------------

def queue_test(db, ident, actor, now=None):
    now = int(time.time()) if now is None else now
    printer = db.execute("SELECT * FROM printers WHERE id=?", (ident,)).fetchone()
    if not printer:
        raise PrinterError("That printer no longer exists.")
    if not printer["enabled"]:
        raise PrinterError("This printer is paused. Resume it to print a test page.")
    if effective_state(db, printer, now)[0] == "offline":
        raise PrinterError("This printer is offline.")
    if db.execute("SELECT 1 FROM printer_tests WHERE printer_id=? AND state IN ('queued','printing') AND created>?", (ident, now - 120)).fetchone():
        return False                                      # one is already on its way: pressing twice never prints two
    db.execute("INSERT INTO printer_tests(printer_id, requested_by, created) VALUES (?,?,?)", (ident, actor, now))
    audit(db, actor, "printer_test", str(ident))
    return True


def claim_test(db, worker, now=None):
    """The next test page the agent can print (the printer must be approved, running and not on hold)."""
    now = int(time.time()) if now is None else now
    for test in db.execute("SELECT printer_tests.id AS test_id, printers.* FROM printer_tests JOIN printers ON printers.id=printer_tests.printer_id "
                           "WHERE printer_tests.state='queued' AND printer_tests.created>? ORDER BY printer_tests.id", (now - 600,)).fetchall():
        if test["enabled"] and effective_state(db, test, now)[0] not in ops.HOLD_STATES:
            row = db.execute("UPDATE printer_tests SET state='printing', worker=? WHERE id=? AND state='queued' RETURNING id", (worker, test["test_id"])).fetchone()
            if row:
                return {"id": row["id"], "printer": test["device_id"] or test["system_name"], "name": test["name"]}
    return None


def finish_test(db, test_id, worker, state, error):
    row = db.execute("UPDATE printer_tests SET state=?, error=? WHERE id=? AND state='printing' AND worker=? RETURNING id", (state, error, test_id, worker)).fetchone()
    saved = row or db.execute("SELECT id FROM printer_tests WHERE id=? AND worker=? AND state=?", (test_id, worker, state)).fetchone()
    return bool(saved)


# ---- what staff see ----------------------------------------------------------------------------------------------------

def midnight(now):
    t = time.localtime(now)
    return int(time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, -1)))


def agent_status(db, now=None):
    now = int(time.time()) if now is None else now
    seen = db.execute("SELECT seen FROM workstations WHERE role='print-agent'").fetchone()
    return {"online": bool(seen and seen["seen"] > now - AGENT_ONLINE_SECONDS), "lastSeen": seen["seen"] if seen else None}


ALERT_STATES = ("offline", "paper-out", "toner-low", "error")


def attention(db, now=None):
    """What needs a person: an approved printer that is out of paper, low on toner, offline or in error, and a print PC that has gone quiet while
    printers are set up. Plain text only; the Printers page, the top bar chip and the admin 'Needs attention' card all read this one list."""
    now = int(time.time()) if now is None else now
    out = []
    printers = db.execute("SELECT * FROM printers WHERE device_id IS NOT NULL ORDER BY name COLLATE NOCASE").fetchall()
    if printers and not agent_status(db, now)["online"]:
        out.append({"level": "bad", "printerId": None, "text": "The print agent is offline. Nothing will print until it is started."})
    for printer in printers:
        if not printer["enabled"]:
            continue
        state, reasons = effective_state(db, printer, now)
        if state in ALERT_STATES and not (state == "offline" and reasons == ["agent-silent"] and out and out[0]["printerId"] is None):
            out.append({"level": "attention" if state == "toner-low" else "bad", "printerId": printer["id"],
                        "text": f"{printer['name']}: " + (REASON_TEXT.get(reasons[0] if reasons else state) or REASON_TEXT.get(state, "needs attention"))})
    return out


def fleet(db, now=None):
    """Everything the Printers page needs: saved printers (with live state), the latest scan, and the agent."""
    now = int(time.time()) if now is None else now
    saved = []
    added = set()
    since = midnight(now)
    for row in db.execute("SELECT * FROM printers ORDER BY is_default DESC, name COLLATE NOCASE, id").fetchall():
        state, reasons = effective_state(db, row, now)
        status = db.execute("SELECT supplies, updated_at FROM printer_status WHERE printer_id=?", (row["id"],)).fetchone()
        used = db.execute("SELECT max(finished) AS last, sum(CASE WHEN finished>=? THEN 1 ELSE 0 END) AS today FROM print_job_printer WHERE printer_id=?",
                          (since, row["id"])).fetchone()
        queued = db.execute("SELECT count(*) FROM print_job_printer JOIN print_jobs ON print_jobs.order_id=print_job_printer.order_id "
                            "AND print_jobs.position=print_job_printer.position WHERE print_jobs.state='queued' AND printer_id=?", (row["id"],)).fetchone()[0]
        if row["device_id"]:
            added.add(row["device_id"])
        saved.append({"id": row["id"], "name": row["name"], "systemName": row["system_name"], "isDefault": bool(row["is_default"]),
                      "deviceId": row["device_id"], "model": row["model"], "connection": row["connection"], "host": row["host"],
                      "capabilities": _loads(row["capabilities"], None), "defaultMono": bool(row["default_mono"]), "defaultColour": bool(row["default_colour"]),
                      "enabled": bool(row["enabled"]), "state": state, "reasons": reasons,
                      "reasonText": REASON_TEXT.get(reasons[0] if reasons else state, "") if state != "ready" else "",
                      "supplies": _loads(status["supplies"], []) if status else [], "updatedAt": status["updated_at"] if status else None,
                      "lastUsed": used["last"], "jobsToday": used["today"] or 0, "queued": queued})
    inventory = db.execute("SELECT data, errors, scanned_at, scan_requested FROM printer_inventory WHERE id=1").fetchone()
    found = []
    if inventory:
        found = [{**p, "alreadyAdded": p["id"] in added} for p in _loads(inventory["data"], [])]
    return {"printers": saved,
            "inventory": {"printers": found, "errors": _loads(inventory["errors"], []) if inventory else [],
                          "scannedAt": inventory["scanned_at"] if inventory else None,
                          "scanning": bool(inventory and inventory["scan_requested"] and now - inventory["scan_requested"] < SCAN_PENDING_SECONDS)},
            "agent": agent_status(db, now), "alerts": attention(db, now)}

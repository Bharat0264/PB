"""Durable warehouse jobs, delivery assignments and audit records."""

import hmac
import json
import secrets
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS print_jobs (
    id INTEGER PRIMARY KEY, order_id TEXT NOT NULL, position INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued', worker TEXT, error TEXT,
    UNIQUE(order_id, position)
);
CREATE TABLE IF NOT EXISTS printers (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, system_name TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL,
    device_id TEXT, model TEXT, connection TEXT, host TEXT, capabilities TEXT,
    default_mono INTEGER NOT NULL DEFAULT 0, default_colour INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1, created_by TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS print_job_printer (
    order_id TEXT NOT NULL, position INTEGER NOT NULL, printer_id INTEGER NOT NULL,
    finished INTEGER,
    PRIMARY KEY(order_id, position)
);
CREATE TABLE IF NOT EXISTS printer_inventory (
    id INTEGER PRIMARY KEY, data TEXT NOT NULL DEFAULT '[]', errors TEXT NOT NULL DEFAULT '[]',
    scanned_at INTEGER, scan_requested INTEGER, scan_manual TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS printer_status (
    printer_id INTEGER PRIMARY KEY, state TEXT NOT NULL, reasons TEXT NOT NULL DEFAULT '[]',
    supplies TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS printer_tests (
    id INTEGER PRIMARY KEY, printer_id INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
    worker TEXT, error TEXT, requested_by TEXT, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
    order_id TEXT PRIMARY KEY, partner TEXT NOT NULL, nonce TEXT,
    expires INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
    lat REAL, lng REAL, located_at INTEGER
);
CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
    order_id TEXT, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS order_events (
    id INTEGER PRIMARY KEY, order_id TEXT NOT NULL, event TEXT NOT NULL, actor TEXT NOT NULL,
    from_status TEXT, to_status TEXT, created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS order_events_order ON order_events(order_id, id);
CREATE TABLE IF NOT EXISTS pricing_versions (
    id INTEGER PRIMARY KEY, terms TEXT NOT NULL, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workstations (
    role TEXT PRIMARY KEY, seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS partner_availability (
    partner TEXT PRIMARY KEY, available INTEGER NOT NULL, updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS partner_earnings (
    order_id TEXT PRIMARY KEY, partner TEXT NOT NULL, amount INTEGER NOT NULL,
    earned INTEGER NOT NULL, settled INTEGER, reference TEXT
);
CREATE TABLE IF NOT EXISTS notification_reads (
    email TEXT PRIMARY KEY, last_seen INTEGER NOT NULL
);
"""


class Conflict(ValueError):
    pass


NEW_PRINTER_COLUMNS = (("device_id", "TEXT"), ("model", "TEXT"), ("connection", "TEXT"), ("host", "TEXT"), ("capabilities", "TEXT"),
                       ("default_mono", "INTEGER NOT NULL DEFAULT 0"), ("default_colour", "INTEGER NOT NULL DEFAULT 0"),
                       ("enabled", "INTEGER NOT NULL DEFAULT 1"), ("created_by", "TEXT"), ("created_at", "INTEGER"))


def migrate(db):
    """Bring a database made before printer discovery up to date (the CREATE TABLE statements above only cover new databases).
    print_jobs is left alone on purpose: its columns are written positionally elsewhere, so the chosen printer lives in print_job_printer."""
    have = {column["name"] for column in db.execute("PRAGMA table_info(printers)")}
    for name, kind in NEW_PRINTER_COLUMNS:
        if name not in have:
            db.execute(f"ALTER TABLE printers ADD COLUMN {name} {kind}")
    if "finished" not in {column["name"] for column in db.execute("PRAGMA table_info(print_job_printer)")}:
        db.execute("ALTER TABLE print_job_printer ADD COLUMN finished INTEGER")
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS printers_device ON printers(device_id)")


def audit(db, actor, action, order_id=None):
    """Record an action. For real orders this also writes the central `order_events` row.

    Callers invoke this inside the same transaction, right after the change, so the event carries
    the order's new status (`to_status`) and the status of the previous event (`from_status`).
    The event reuses the audit row id, so notification cursors and the live feed share one sequence.
    """
    now = int(time.time())
    cursor = db.execute("INSERT INTO audit(actor, action, order_id, created) VALUES (?, ?, ?, ?)",
                        (actor, action, order_id, now))
    if not order_id:
        return
    row = db.execute("SELECT status FROM orders WHERE id=?", (order_id,)).fetchone()
    if row:
        last = db.execute("SELECT to_status FROM order_events WHERE order_id=? ORDER BY id DESC LIMIT 1",
                          (order_id,)).fetchone()
        db.execute("INSERT INTO order_events(id, order_id, event, actor, from_status, to_status, created) "
                   "VALUES (?,?,?,?,?,?,?)",
                   (cursor.lastrowid, order_id, action, actor, last["to_status"] if last else None,
                    row["status"], now))


class PrinterError(ValueError):
    """A printer request the warehouse can fix; the message is safe to show."""


MAX_PRINTERS = 12


def list_printers(db):
    return [{"id": row["id"], "name": row["name"], "systemName": row["system_name"], "isDefault": bool(row["is_default"])}
            for row in db.execute("SELECT * FROM printers ORDER BY is_default DESC, name COLLATE NOCASE, id")]


def _clean(value, label, limit):
    if not isinstance(value, str) or not value.strip():
        raise PrinterError(f"Enter the {label}.")
    value = " ".join(value.split())
    if len(value) > limit or any(ord(ch) < 32 for ch in value):
        raise PrinterError(f"The {label} is too long.")
    return value


def save_printer(db, data, actor="warehouse"):
    """Add a printer, or rename / re-point / make default an existing one."""
    ident = data.get("id")
    if ident is not None and (type(ident) is not int or not db.execute("SELECT 1 FROM printers WHERE id=?", (ident,)).fetchone()):
        raise PrinterError("That printer no longer exists.")
    name = _clean(data.get("name"), "printer name", 40)
    system_name = _clean(data.get("systemName"), "system printer name", 120)
    if ident is None:
        if db.execute("SELECT count(*) FROM printers").fetchone()[0] >= MAX_PRINTERS:
            raise PrinterError(f"You can add up to {MAX_PRINTERS} printers.")
        make_default = bool(data.get("isDefault")) or not db.execute("SELECT 1 FROM printers").fetchone()
        ident = db.execute("INSERT INTO printers(name, system_name, is_default, created) VALUES (?,?,0,?)",
                           (name, system_name, int(time.time()))).lastrowid
        audit(db, actor, "printer_added", str(ident))
    else:
        make_default = bool(data.get("isDefault"))
        db.execute("UPDATE printers SET name=?, system_name=? WHERE id=?", (name, system_name, ident))
        audit(db, actor, "printer_updated", str(ident))
    if make_default:
        db.execute("UPDATE printers SET is_default=(id=?)", (ident,))
    return ident


def remove_printer(db, ident, actor="warehouse"):
    row = db.execute("SELECT is_default FROM printers WHERE id=?", (ident,)).fetchone()
    if not row:
        raise PrinterError("That printer no longer exists.")
    db.execute("DELETE FROM printers WHERE id=?", (ident,))
    db.execute("DELETE FROM print_job_printer WHERE printer_id=?", (ident,))
    if row["is_default"]:
        db.execute("UPDATE printers SET is_default=1 WHERE id=(SELECT id FROM printers ORDER BY name COLLATE NOCASE, id LIMIT 1)")
    audit(db, actor, "printer_removed", str(ident))


def job_printer(db, job):
    """Where a job should go: the printer picked in the warehouse, else the default, else None (the agent then uses its own --printer).
    A printer found by the agent is named by its device id (which the agent matches to what it found); an older one by its system name."""
    row = db.execute("SELECT printers.system_name, printers.device_id FROM print_job_printer JOIN printers ON printers.id=print_job_printer.printer_id "
                     "WHERE order_id=? AND position=?", (job["order_id"], job["position"])).fetchone()
    if not row:
        row = db.execute("SELECT system_name, device_id FROM printers WHERE is_default=1").fetchone()
    return (row["device_id"] or row["system_name"]) if row else None


def queue_job(db, order_id, position, actor="warehouse", printer_id=None):
    changed = db.execute(
        "INSERT INTO print_jobs(order_id, position) "
        "SELECT files.order_id, files.position FROM files JOIN orders ON orders.id=files.order_id "
        "WHERE files.order_id=? AND position=? AND orders.status IN ('paid','printing') "
        "ON CONFLICT(order_id, position) DO UPDATE SET state='queued', worker=NULL, error=NULL "
        "WHERE print_jobs.state='failed'", (order_id, position)
    ).rowcount
    if not changed:
        return False
    db.execute("UPDATE orders SET status='printing' WHERE id=? AND status='paid'", (order_id,))
    if printer_id is None:
        db.execute("DELETE FROM print_job_printer WHERE order_id=? AND position=?", (order_id, position))
    else:
        db.execute("INSERT INTO print_job_printer(order_id, position, printer_id) VALUES (?,?,?) "
                   "ON CONFLICT(order_id, position) DO UPDATE SET printer_id=excluded.printer_id", (order_id, position, printer_id))
    audit(db, actor, "print_queued", order_id)
    return True


STATUS_FRESH = 120          # seconds: the agent reports every ~20, so a status older than this means the printer (or the agent) has gone quiet
HOLD_STATES = ("offline", "paper-out", "error")


def claim_job(db, worker, now=None):
    """The next job the agent can actually print. A job whose chosen printer is paused, offline, out of paper, in error or silent is skipped
    (it stays queued, shown as 'Waiting for printer'), so one dead printer never blocks the others."""
    now = int(time.time()) if now is None else now
    return db.execute(
        "UPDATE print_jobs SET state='printing', worker=? "
        "WHERE id=(SELECT print_jobs.id FROM print_jobs JOIN orders ON orders.id=print_jobs.order_id "
        "LEFT JOIN print_job_printer AS pjp ON pjp.order_id=print_jobs.order_id AND pjp.position=print_jobs.position "
        "LEFT JOIN printers AS pr ON pr.id=pjp.printer_id LEFT JOIN printer_status AS ps ON ps.printer_id=pr.id "
        "WHERE print_jobs.state='queued' AND orders.status='printing' AND (pr.id IS NULL OR (pr.enabled=1 AND "
        "(ps.printer_id IS NULL OR (ps.state NOT IN ('offline','paper-out','error') AND ps.updated_at>=?)))) "
        "ORDER BY print_jobs.id LIMIT 1) RETURNING *", (worker, now - STATUS_FRESH)
    ).fetchone()


def finish_job(db, job, worker, state, error):
    row = db.execute(
        "UPDATE print_jobs SET state=?, error=? WHERE id=? AND state='printing' AND worker=? RETURNING order_id",
        (state, error, job, worker)
    ).fetchone()
    if row:
        audit(db, "print-agent", "print_" + state, row["order_id"])
        if state == "done":
            db.execute("UPDATE print_job_printer SET finished=? WHERE (order_id, position) IN "
                       "(SELECT order_id, position FROM print_jobs WHERE id=?)", (int(time.time()), job))
        return row["order_id"]
    saved = db.execute("SELECT order_id FROM print_jobs WHERE id=? AND worker=? AND state=?",
                       (job, worker, state)).fetchone()
    return saved["order_id"] if saved else None


def ready_printed_orders(db, actor, order_id=None, eligible_partners=()):
    """Make fully printed orders eligible for pickup in the caller's transaction."""
    scope = "printed.id=?" if order_id is not None else "1=1"
    params = (order_id,) if order_id is not None else ()
    rows = db.execute(
        f"UPDATE orders AS printed SET status='packed' WHERE {scope} AND printed.status='printing' "
        "AND EXISTS (SELECT 1 FROM files WHERE order_id=printed.id) "
        "AND NOT EXISTS (SELECT 1 FROM files LEFT JOIN print_jobs "
        "ON print_jobs.order_id=files.order_id AND print_jobs.position=files.position "
        "WHERE files.order_id=printed.id AND (print_jobs.state IS NULL OR print_jobs.state!='done')) "
        "RETURNING id", params,
    ).fetchall()
    for row in rows:
        audit(db, actor, "packed", row["id"])
        if eligible_partners:
            dispatch_available(db, row["id"], eligible_partners)
    return len(rows)


def assign_delivery(db, order_id, partner):
    if not db.execute("SELECT 1 FROM orders WHERE id=? AND status='packed'", (order_id,)).fetchone():
        raise Conflict("This order is unavailable for pickup.")
    changed = db.execute(
        "INSERT INTO deliveries(order_id, partner) VALUES (?,?) ON CONFLICT DO NOTHING", (order_id, partner)
    ).rowcount
    if not changed:
        raise Conflict("Another partner has accepted this order.")
    audit(db, partner, "delivery_accepted", order_id)


def dispatch_available(db, order_id, eligible):
    available = [row["partner"] for row in db.execute(
        "SELECT partner FROM partner_availability WHERE available=1 AND updated>? "
        "AND NOT EXISTS(SELECT 1 FROM deliveries JOIN orders ON orders.id=deliveries.order_id "
        "WHERE deliveries.partner=partner_availability.partner AND orders.status IN ('packed','out_for_delivery')) "
        "ORDER BY updated DESC", (int(time.time()) - 900,)
    ) if row["partner"] in eligible]
    if available:
        assign_delivery(db, order_id, available[0])


def cancel_order(db, order_id):
    changed = db.execute(
        "UPDATE orders SET status='cancelled' WHERE id=? AND status='paid' "
        "AND NOT EXISTS(SELECT 1 FROM razorpay_orders WHERE order_id=? AND payment_id IS NOT NULL)",
        (order_id, order_id),
    ).rowcount
    if not changed:
        raise Conflict("Only unprinted orders without a captured Razorpay payment can be cancelled here.")
    audit(db, "admin", "order_cancelled", order_id)


def pickup(db, order_id, partner):
    changed = db.execute(
        "UPDATE orders SET status='out_for_delivery' WHERE id=? AND status='packed' AND "
        "EXISTS(SELECT 1 FROM deliveries WHERE order_id=? AND partner=?)", (order_id, order_id, partner)
    ).rowcount
    if not changed:
        raise Conflict("Accept this order before confirming pickup.")
    db.execute("UPDATE deliveries SET nonce=?, expires=?, attempts=0 WHERE order_id=?",
               (secrets.token_hex(16), int(time.time()) + 7200, order_id))
    audit(db, partner, "delivery_picked_up", order_id)


def mark_undeliverable(db, order_id, actor, partner=None):
    """A delivery that cannot be completed. Partners may only flag their own; admin may flag any."""
    changed = db.execute(
        "UPDATE orders SET status='undeliverable' WHERE id=? AND status='out_for_delivery' AND "
        "(? IS NULL OR EXISTS(SELECT 1 FROM deliveries WHERE order_id=? AND partner=?))",
        (order_id, partner, order_id, partner),
    ).rowcount
    if not changed:
        raise Conflict("Only an active delivery can be marked undeliverable.")
    db.execute("UPDATE deliveries SET nonce=NULL, expires=NULL WHERE order_id=?", (order_id,))
    audit(db, actor, "delivery_undeliverable", order_id)


def reassign(db, order_id):
    """Return an order to the ready pool so another partner can accept it (admin only)."""
    row = db.execute("SELECT status FROM orders WHERE id=?", (order_id,)).fetchone()
    if not row or row["status"] not in ("packed", "undeliverable"):
        raise Conflict("Only an order that has not been picked up, or an undeliverable one, can be reassigned.")
    removed = db.execute("DELETE FROM deliveries WHERE order_id=? RETURNING partner", (order_id,)).fetchone()
    if row["status"] == "packed" and not removed:
        raise Conflict("This order has no assigned partner to replace.")
    if row["status"] == "undeliverable":
        db.execute("UPDATE orders SET status='packed' WHERE id=?", (order_id,))
    audit(db, "admin", "delivery_reassigned", order_id)


def renew_delivery_code(db, order_id):
    row = db.execute(
        "UPDATE deliveries SET nonce=?, expires=?, attempts=0 WHERE order_id=? AND "
        "EXISTS(SELECT 1 FROM orders WHERE id=? AND status='out_for_delivery') RETURNING order_id",
        (secrets.token_hex(16), int(time.time()) + 7200, order_id, order_id),
    ).fetchone()
    if not row:
        raise Conflict("A code can only be renewed for an active delivery.")
    audit(db, "admin", "delivery_code_renewed", order_id)


def delivery_code(secret, nonce):
    digest = hmac.digest(secret, nonce.encode(), "sha256")
    return f"{int.from_bytes(digest[:8], 'big') % 10000:04d}"


def deliver(db, order_id, partner, secret, code):
    row = db.execute(
        "SELECT nonce, expires, attempts FROM deliveries JOIN orders ON orders.id=deliveries.order_id "
        "WHERE order_id=? AND partner=? AND status='out_for_delivery'", (order_id, partner)
    ).fetchone()
    if not row or row["expires"] < time.time() or row["attempts"] >= 3:
        return "The delivery code is unavailable or locked."
    if not hmac.compare_digest(delivery_code(secret, row["nonce"]).encode(), code.encode()):
        db.execute("UPDATE deliveries SET attempts=attempts+1 WHERE order_id=?", (order_id,))
        audit(db, partner, "delivery_code_rejected", order_id)
        return "Incorrect delivery code."
    db.execute("UPDATE orders SET status='delivered' WHERE id=?", (order_id,))
    db.execute("UPDATE deliveries SET nonce=NULL, expires=NULL WHERE order_id=?", (order_id,))
    details = json.loads(db.execute("SELECT details FROM orders WHERE id=?", (order_id,)).fetchone()["details"])
    db.execute("INSERT INTO partner_earnings(order_id, partner, amount, earned) VALUES (?,?,?,?)",
               (order_id, partner, details.get("partnerPayout", 0), int(time.time())))
    audit(db, partner, "delivery_completed", order_id)
    return None


def settle_earning(db, order_id, reference):
    changed = db.execute(
        "UPDATE partner_earnings SET settled=?, reference=? WHERE order_id=? AND settled IS NULL RETURNING partner",
        (int(time.time()), reference, order_id)
    ).fetchone()
    if not changed:
        raise Conflict("This earning is unavailable or already settled.")
    audit(db, "admin", "payout_recorded", order_id)

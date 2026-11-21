"""Durable warehouse jobs, delivery assignments and audit records."""

import hmac
import json
import secrets
import time
from file_retention import SCHEMA as FILE_RETENTION_SCHEMA, delete_delivered_files

SCHEMA = """
CREATE TABLE IF NOT EXISTS print_jobs (
    id INTEGER PRIMARY KEY, order_id TEXT NOT NULL, position INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued', worker TEXT, error TEXT,
    UNIQUE(order_id, position)
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
""" + FILE_RETENTION_SCHEMA


class Conflict(ValueError):
    pass


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


def deliver(db, order_id, partner, secret, code, remote_storage=False):
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
    delete_delivered_files(db, order_id, remote_storage)
    return None


def settle_earning(db, order_id, reference):
    changed = db.execute(
        "UPDATE partner_earnings SET settled=?, reference=? WHERE order_id=? AND settled IS NULL RETURNING partner",
        (int(time.time()), reference, order_id)
    ).fetchone()
    if not changed:
        raise Conflict("This earning is unavailable or already settled.")
    audit(db, "admin", "payout_recorded", order_id)

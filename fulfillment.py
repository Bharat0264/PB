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
CREATE TABLE IF NOT EXISTS deliveries (
    order_id TEXT PRIMARY KEY, partner TEXT NOT NULL, nonce TEXT,
    expires INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
    lat REAL, lng REAL, located_at INTEGER
);
CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
    order_id TEXT, created INTEGER NOT NULL
);
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


def audit(db, actor, action, order_id=None):
    db.execute("INSERT INTO audit(actor, action, order_id, created) VALUES (?, ?, ?, ?)",
               (actor, action, order_id, int(time.time())))


def queue_job(db, order_id, position):
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
    audit(db, "warehouse", "print_queued", order_id)
    return True


def claim_job(db, worker):
    return db.execute(
        "UPDATE print_jobs SET state='printing', worker=? "
        "WHERE id=(SELECT print_jobs.id FROM print_jobs JOIN orders ON orders.id=print_jobs.order_id "
        "WHERE state='queued' AND orders.status='printing' ORDER BY print_jobs.id LIMIT 1) RETURNING *", (worker,)
    ).fetchone()


def finish_job(db, job, worker, state, error):
    row = db.execute(
        "UPDATE print_jobs SET state=?, error=? WHERE id=? AND state='printing' AND worker=? RETURNING order_id",
        (state, error, job, worker)
    ).fetchone()
    if row:
        audit(db, "print-agent", "print_" + state, row["order_id"])
        return True
    return bool(db.execute("SELECT 1 FROM print_jobs WHERE id=? AND worker=? AND state=?",
                           (job, worker, state)).fetchone())


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

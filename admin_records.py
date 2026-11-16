import re
import secrets
import time
from datetime import datetime, timedelta, timezone

import fulfillment as ops


SCHEMA = """
CREATE TABLE IF NOT EXISTS warehouse_pickups (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL,
    email TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS one_default_pickup
    ON warehouse_pickups(is_default) WHERE is_default=1;
CREATE TABLE IF NOT EXISTS offline_sales (
    id TEXT PRIMARY KEY, customer TEXT NOT NULL, product TEXT NOT NULL,
    total INTEGER NOT NULL, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS partner_accounts (
    email TEXT PRIMARY KEY, partner TEXT NOT NULL UNIQUE, created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS offline_sales_created ON offline_sales(created);
CREATE INDEX IF NOT EXISTS audit_paid_at ON audit(created, order_id) WHERE action='paid';
CREATE INDEX IF NOT EXISTS audit_paid_order ON audit(order_id, created) WHERE action='paid';
"""
INDIA = timezone(timedelta(hours=5, minutes=30))


class InputError(ValueError):
    pass


def required_text(data, key, limit):
    value = data.get(key)
    if not isinstance(value, str) or not 0 < len(value.strip()) <= limit:
        raise InputError(f"Enter a valid {key}.")
    return value.strip()


def warehouse_directory(db):
    return [dict(row) for row in db.execute(
        "SELECT id, name, address, email, is_default FROM warehouse_pickups ORDER BY is_default DESC, name"
    )]


def default_pickup(db):
    row = db.execute("SELECT name, address FROM warehouse_pickups WHERE is_default=1").fetchone()
    return dict(row) if row else None


def save_warehouse(db, data, actor):
    name = required_text(data, "name", 70)
    address = required_text(data, "address", 500)
    email = required_text(data, "email", 254).lower()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise InputError("Enter a valid warehouse staff email.")
    if type(data.get("useForPickup")) is not bool:
        raise InputError("Invalid pickup setting.")
    use_default = data["useForPickup"] or default_pickup(db) is None
    existing = db.execute("SELECT id, is_default FROM warehouse_pickups WHERE name=? AND address=? AND email=?",
                          (name, address, email)).fetchone()
    if existing and (not use_default or existing["is_default"]):
        return {"saved": True}
    if use_default:
        db.execute("UPDATE warehouse_pickups SET is_default=0 WHERE is_default=1")
    if existing:
        db.execute("UPDATE warehouse_pickups SET is_default=1 WHERE id=?", (existing["id"],))
        ops.audit(db, actor, "warehouse_pickup_changed", str(existing["id"]))
        return {"saved": True}
    entry = db.execute("INSERT INTO warehouse_pickups(name, address, email, is_default) VALUES (?,?,?,?)",
                       (name, address, email, use_default))
    ops.audit(db, actor, "warehouse_added", str(entry.lastrowid))
    return {"saved": True}


def partner_accounts(db):
    return {row["email"]: row["partner"] for row in db.execute("SELECT email, partner FROM partner_accounts")}


def add_partner(db, data, actor):
    """Verify a delivery partner's Google account. Returns (email, partner id)."""
    email = required_text(data, "email", 254).lower()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise InputError("Enter a valid Google email address.")
    existing = db.execute("SELECT partner FROM partner_accounts WHERE email=?", (email,)).fetchone()
    if existing:
        return email, existing["partner"]
    partner = "rider-" + secrets.token_hex(4)
    db.execute("INSERT INTO partner_accounts(email, partner, created) VALUES (?,?,?)", (email, partner, int(time.time())))
    ops.audit(db, actor, "partner_added", partner)
    return email, partner


def remove_partner(db, data, actor):
    email = required_text(data, "email", 254).lower()
    row = db.execute("SELECT partner FROM partner_accounts WHERE email=?", (email,)).fetchone()
    if not row:
        raise InputError("Only partners added here can be removed.")
    db.execute("DELETE FROM partner_accounts WHERE email=?", (email,))
    ops.audit(db, actor, "partner_removed", row["partner"])
    return email


def record_offline_sales(db, rows, actor):
    if not isinstance(rows, list) or not 1 <= len(rows) <= 25:
        raise InputError("Add between 1 and 25 offline orders.")
    seen = set()
    saved = 0
    now = int(time.time())
    for row in rows:
        if not isinstance(row, dict):
            raise InputError("Invalid offline order.")
        order_id = required_text(row, "id", 36)
        if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", order_id):
            raise InputError("Invalid offline order ID.")
        if order_id in seen:
            raise InputError("Each offline order needs its own ID.")
        seen.add(order_id)
        amount = required_text(row, "amount", 9)
        if not re.fullmatch(r"[0-9]{1,6}(\.[0-9]{1,2})?", amount):
            raise InputError("Enter an amount with up to two decimal places.")
        rupees, _, paise = amount.partition(".")
        total = int(rupees) * 100 + int(paise.ljust(2, "0"))
        if not 0 < total <= 99_999_900:
            raise InputError("Enter an amount between ₹0.01 and ₹999,999.")
        sale = (required_text(row, "customer", 70), required_text(row, "product", 100), total)
        existing = db.execute("SELECT customer, product, total FROM offline_sales WHERE id=?", (order_id,)).fetchone()
        if existing:
            if tuple(existing) != sale:
                raise ops.Conflict("An offline order changed after it was saved. Reopen the form to add a new order.")
            continue
        db.execute("INSERT INTO offline_sales VALUES (?,?,?,?,?)", (order_id, *sale, now))
        ops.audit(db, actor, "offline_order_added", order_id)
        saved += 1
    return {"saved": saved}


def today_totals(db, now=None):
    date = now.astimezone(INDIA) if now else datetime.now(INDIA)
    start = date.replace(hour=0, minute=0, second=0, microsecond=0)
    day = (int(start.timestamp()), int((start + timedelta(days=1)).timestamp()))
    count, revenue = db.execute("""
        SELECT count(*), COALESCE(sum(CASE WHEN status NOT IN ('cancelled', 'refund_pending', 'refunded')
            THEN COALESCE(json_extract(details,'$.bill.total'),json_extract(details,'$.subtotal')) ELSE 0 END),0)
        FROM orders JOIN (
            SELECT DISTINCT order_id FROM audit WHERE action='paid' AND created>=? AND created<?
        ) AS payments ON orders.id=payments.order_id
    """, day).fetchone()
    offline_count, offline_revenue = db.execute(
        "SELECT count(*), COALESCE(sum(total),0) FROM offline_sales WHERE created>=? AND created<?", day
    ).fetchone()
    return {"orders": count + offline_count, "revenue": revenue + offline_revenue}

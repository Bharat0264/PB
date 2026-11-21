import re
import secrets
import time
from datetime import datetime, timedelta, timezone

import fulfillment as ops
from finance import LIVE as PAID_STATUSES


SCHEMA = """
CREATE TABLE IF NOT EXISTS warehouse_availability (
    id INTEGER PRIMARY KEY CHECK(id=1), is_open INTEGER NOT NULL CHECK(is_open IN (0,1)),
    updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS warehouse_pickups (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL,
    email TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS warehouse_service_states (
    warehouse_id INTEGER PRIMARY KEY REFERENCES warehouse_pickups(id) ON DELETE CASCADE,
    is_open INTEGER NOT NULL CHECK(is_open IN (0,1)),
    updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS website_ordering (
    id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL CHECK(paused IN (0,1)),
    updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL
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
CREATE TABLE IF NOT EXISTS partner_details (
    partner TEXT PRIMARY KEY REFERENCES partner_accounts(partner) ON DELETE CASCADE,
    name TEXT NOT NULL, phone TEXT NOT NULL, roll_no TEXT NOT NULL DEFAULT '',
    licence TEXT NOT NULL, payout TEXT NOT NULL, vehicle TEXT NOT NULL,
    updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL
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


def warehouse_availability(db, email=None):
    """Public aggregate, or the signed-in operator's own warehouses.

    Existing installations without a directory retain their shared switch. Stores
    without an individual setting inherit that switch until their operator changes it.
    """
    row = db.execute("SELECT is_open, updated_at FROM warehouse_availability WHERE id=1").fetchone()
    fallback = bool(row["is_open"]) if row else True
    stores = db.execute("SELECT w.id, s.is_open, s.updated_at FROM warehouse_pickups w "
                        "LEFT JOIN warehouse_service_states s ON s.warehouse_id=w.id" +
                        (" WHERE lower(w.email)=?" if email else ""), (email.lower(),) if email else ()).fetchall()
    if stores:
        return {"open": any(bool(s["is_open"]) if s["is_open"] is not None else fallback for s in stores),
                "updatedAt": max((s["updated_at"] or 0 for s in stores), default=0) or None}
    if email and db.execute("SELECT 1 FROM warehouse_pickups LIMIT 1").fetchone():
        return {"open": False, "updatedAt": None}
    return {"open": fallback, "updatedAt": row["updated_at"] if row else None}


def ordering_availability(db):
    warehouse = warehouse_availability(db)
    row = db.execute("SELECT paused FROM website_ordering WHERE id=1").fetchone()
    paused = bool(row["paused"]) if row else False
    return {"serviceOpen": warehouse["open"] and not paused, "orderingPaused": paused,
            "warehouseOpen": warehouse["open"],
            "closureReason": "paused" if paused else "warehouses_closed" if not warehouse["open"] else None}


def set_ordering_availability(db, data, actor):
    if not isinstance(data, dict) or type(data.get("paused")) is not bool:
        raise InputError("Choose whether to pause new orders.")
    if ordering_availability(db)["orderingPaused"] != data["paused"]:
        db.execute("INSERT INTO website_ordering VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET "
                   "paused=excluded.paused, updated_at=excluded.updated_at, updated_by=excluded.updated_by",
                   (int(data["paused"]), int(time.time()), actor))
        ops.audit(db, actor, "website_orders_paused" if data["paused"] else "website_orders_resumed", "website")
    return ordering_availability(db)


def set_warehouse_availability(db, data, actor, email=None):
    if not isinstance(data, dict) or type(data.get("open")) is not bool:
        raise InputError("Choose Open or Closed.")
    stores = db.execute("SELECT id FROM warehouse_pickups" + (" WHERE lower(email)=?" if email else ""),
                        (email.lower(),) if email else ()).fetchall()
    if email and not stores and db.execute("SELECT 1 FROM warehouse_pickups LIMIT 1").fetchone():
        raise InputError("Ask the admin to link your account to a warehouse.")
    # Check every store: an aggregate of Open must not hide a closed sibling store.
    current = warehouse_availability(db, email)
    if current["open"] == data["open"] and not stores:
        return current
    now = int(time.time())
    changed = False
    legacy = db.execute("SELECT is_open FROM warehouse_availability WHERE id=1").fetchone()
    for store in stores:
        old = db.execute("SELECT is_open FROM warehouse_service_states WHERE warehouse_id=?", (store["id"],)).fetchone()
        fallback = bool(old["is_open"]) if old else bool(legacy["is_open"]) if legacy else True
        # Always persist the operator's explicit state, including inherited defaults.
        db.execute("INSERT INTO warehouse_service_states VALUES (?,?,?,?) ON CONFLICT(warehouse_id) DO UPDATE SET "
                   "is_open=excluded.is_open, updated_at=excluded.updated_at, updated_by=excluded.updated_by",
                   (store["id"], int(data["open"]), now, actor))
        changed = changed or fallback != data["open"]
    if not email or not stores:
        db.execute("INSERT INTO warehouse_availability VALUES (1,?,?,?) "
               "ON CONFLICT(id) DO UPDATE SET is_open=excluded.is_open, updated_at=excluded.updated_at, "
               "updated_by=excluded.updated_by", (int(data["open"]), now, actor))
        changed = changed or current["open"] != data["open"]
    if changed:
        ops.audit(db, actor, "warehouse_opened" if data["open"] else "warehouse_closed", email or "warehouse")
    return warehouse_availability(db, email)


def available_pickup(db):
    """Route new orders to an open store, preferring the configured default."""
    fallback = db.execute("SELECT is_open FROM warehouse_availability WHERE id=1").fetchone()
    row = db.execute("SELECT w.id, w.name, w.address FROM warehouse_pickups w "
                     "LEFT JOIN warehouse_service_states s ON s.warehouse_id=w.id "
                     "WHERE COALESCE(s.is_open,?)=1 ORDER BY w.is_default DESC, w.id LIMIT 1",
                     (fallback["is_open"] if fallback else 1,)).fetchone()
    return dict(row) if row else None


def warehouse_directory(db):
    stores = [dict(row) for row in db.execute(
        "SELECT id, name, address, email, is_default FROM warehouse_pickups ORDER BY is_default DESC, name"
    )]
    by_id = {store["id"]: store for store in stores}
    legacy = {}
    for store in stores:
        store.update(revenue=0, paidOrders=0)
        legacy.setdefault((store["name"], store["address"]), []).append(store)
    # Bills are checkout snapshots in paise; exclude cancelled, pending and refunded orders.
    marks = ",".join("?" for _ in PAID_STATUSES)
    totals = db.execute("""SELECT json_extract(details,'$.pickupWarehouse.id') AS warehouse_id,
        json_extract(details,'$.pickupWarehouse.name') AS name,
        json_extract(details,'$.pickupWarehouse.address') AS address,
        count(*) AS orders, COALESCE(sum(CAST(COALESCE(json_extract(details,'$.bill.total'),
            json_extract(details,'$.subtotal'),0) AS INTEGER)),0) AS revenue
        FROM orders WHERE status IN (""" + marks + """) GROUP BY warehouse_id, name, address""", PAID_STATUSES)
    for row in totals:
        if row["warehouse_id"] is not None:
            store = by_id.get(row["warehouse_id"])
            # Never assign a removed store's revenue to a different store reusing its numeric ID.
            if store and (store["name"], store["address"]) != (row["name"], row["address"]):
                store = None
        else:
            matches = legacy.get((row["name"], row["address"]), [])
            store = matches[0] if len(matches) == 1 else None
        if store is not None:
            store["revenue"] += row["revenue"]
            store["paidOrders"] += row["orders"]
    return stores


def default_pickup(db):
    row = db.execute("SELECT id, name, address FROM warehouse_pickups WHERE is_default=1").fetchone()
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


def remove_warehouse(db, data, actor):
    """Delete a saved warehouse. If it was the default pickup, another one takes over. Returns its email."""
    ident = data.get("id")
    if type(ident) is not int:
        raise InputError("Choose a warehouse to remove.")
    row = db.execute("SELECT email, is_default FROM warehouse_pickups WHERE id=?", (ident,)).fetchone()
    if not row:
        raise InputError("That warehouse no longer exists.")
    db.execute("DELETE FROM warehouse_service_states WHERE warehouse_id=?", (ident,))
    db.execute("DELETE FROM warehouse_pickups WHERE id=?", (ident,))
    if row["is_default"]:
        db.execute("UPDATE warehouse_pickups SET is_default=1 WHERE id=(SELECT id FROM warehouse_pickups ORDER BY name LIMIT 1)")
    ops.audit(db, actor, "warehouse_removed", str(ident))
    return row["email"].strip().lower()


def warehouse_staff(db):
    """Emails the admin saved as warehouse staff. They may sign in to the warehouse portal."""
    return {row["email"].strip().lower() for row in db.execute("SELECT email FROM warehouse_pickups")}


def partner_accounts(db):
    return {row["email"]: row["partner"] for row in db.execute("SELECT email, partner FROM partner_accounts")}


def partner_profile(db, partner):
    row = db.execute("""SELECT a.partner AS id, a.email, a.created, d.name, d.phone, d.roll_no AS rollNo,
        d.licence, d.payout, d.vehicle FROM partner_accounts a LEFT JOIN partner_details d
        ON a.partner=d.partner WHERE a.partner=?""", (partner,)).fetchone()
    return dict(row) if row else {"id": partner}


def add_partner(db, data, actor):
    """Save an admin-verified identity and grant its Google account partner access."""
    email = required_text(data, "email", 254).lower()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise InputError("Enter a valid Google email address.")
    name = required_text(data, "name", 70)
    phone = required_text(data, "phone", 20)
    if not re.fullmatch(r"\+?[0-9 ()-]{7,20}", phone) or not 7 <= len(re.sub(r"\D", "", phone)) <= 15:
        raise InputError("Enter a valid phone number.")
    roll = data.get("rollNo", "")
    if not isinstance(roll, str) or len(roll.strip()) > 40:
        raise InputError("Enter a valid SRM roll number or leave it blank.")
    licence = required_text(data, "licence", 40)
    payout = required_text(data, "payout", 150)
    if not re.fullmatch(r"[A-Za-z0-9._-]{2,100}@[A-Za-z][A-Za-z0-9.-]{1,49}", payout):
        raise InputError("Enter a valid payout UPI ID.")
    vehicle = required_text(data, "vehicle", 100)
    if data.get("verified") is not True:
        raise InputError("Confirm that you have verified this delivery partner's identity.")
    existing = db.execute("SELECT partner FROM partner_accounts WHERE email=?", (email,)).fetchone()
    partner = existing["partner"] if existing else "rider-" + secrets.token_hex(4)
    details = (name, phone, roll.strip(), licence, payout, vehicle)
    current = db.execute("SELECT name, phone, roll_no, licence, payout, vehicle FROM partner_details WHERE partner=?", (partner,)).fetchone()
    if current and tuple(current) == details:
        return email, partner
    now = int(time.time())
    if not existing:
        db.execute("INSERT INTO partner_accounts(email, partner, created) VALUES (?,?,?)", (email, partner, now))
    db.execute("""INSERT INTO partner_details VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(partner) DO UPDATE SET
        name=excluded.name, phone=excluded.phone, roll_no=excluded.roll_no, licence=excluded.licence,
        payout=excluded.payout, vehicle=excluded.vehicle, updated_at=excluded.updated_at, updated_by=excluded.updated_by""",
        (partner, *details, now, actor))
    ops.audit(db, actor, "partner_updated" if existing else "partner_added", partner)
    return email, partner


def remove_partner(db, data, actor):
    email = required_text(data, "email", 254).lower()
    row = db.execute("SELECT partner FROM partner_accounts WHERE email=?", (email,)).fetchone()
    if not row:
        raise InputError("Only partners added here can be removed.")
    db.execute("DELETE FROM partner_details WHERE partner=?", (row["partner"],))
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

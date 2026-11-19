"""Support tickets: one tickets table for every channel (customer form, admin, and later the Buzz chatbot).

Everything here is plain SQL over sqlite3 (INTEGER PRIMARY KEY, epoch-second integers, no SQLite-only features)
so it ports to PostgreSQL unchanged. server.py only routes requests and checks who is calling.

Message kinds
    customer  written by the customer (visible to the customer)
    agent     a reply from support staff (visible to the customer)
    internal  a private admin note (NEVER shown to the customer)
    event     an automatic log line: status / priority / assignment changes (staff only)

Buzz (the AI chatbot) creates tickets through `create_ticket(..., source="buzz", ai_summary="...")`, the same
function the customer form uses. There is no second tickets table.
"""

import json
import re
import time
from posixpath import basename

SCHEMA = """
CREATE TABLE IF NOT EXISTS support_tickets (
    id INTEGER PRIMARY KEY,
    ticket_number TEXT UNIQUE,
    customer_email TEXT NOT NULL,
    order_id TEXT,
    category TEXT NOT NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    priority TEXT NOT NULL DEFAULT 'normal',
    assignee TEXT,
    source TEXT NOT NULL DEFAULT 'customer',
    ai_summary TEXT,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    closed INTEGER
);
CREATE TABLE IF NOT EXISTS support_messages (
    id INTEGER PRIMARY KEY,
    ticket_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS support_attachments (
    id INTEGER PRIMARY KEY,
    ticket_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    object_key TEXT,
    content BLOB,
    uploaded_by TEXT NOT NULL,
    created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS support_rate (
    bucket TEXT NOT NULL,
    key TEXT NOT NULL,
    ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS support_idempotency (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    response TEXT NOT NULL,
    created INTEGER NOT NULL,
    PRIMARY KEY (scope, key)
);
CREATE INDEX IF NOT EXISTS support_attachments_ticket ON support_attachments(ticket_id, message_id);
CREATE INDEX IF NOT EXISTS support_rate_lookup ON support_rate(bucket, key, ts);
CREATE INDEX IF NOT EXISTS support_tickets_customer ON support_tickets(customer_email, updated);
CREATE INDEX IF NOT EXISTS support_tickets_status ON support_tickets(status, updated);
CREATE INDEX IF NOT EXISTS support_tickets_assignee ON support_tickets(assignee, status);
CREATE INDEX IF NOT EXISTS support_tickets_order ON support_tickets(order_id);
CREATE INDEX IF NOT EXISTS support_messages_ticket ON support_messages(ticket_id, id);
"""

# key -> (label shown to people, needs an order)
CATEGORIES = {
    "order": ("Order or payment", False),
    "delivery": ("Bee Runner / Delivery issue", True),
    "print_quality": ("Print quality", True),
    "account": ("Account or sign-in", False),
    "other": ("Something else", False),
}
# open -> in_progress -> pending (waiting for the customer) -> resolved -> closed
STATUSES = ("open", "in_progress", "pending", "resolved", "closed")
TRANSITIONS = {
    "open": {"in_progress", "pending", "resolved", "closed"},
    "in_progress": {"open", "pending", "resolved", "closed"},
    "pending": {"open", "in_progress", "resolved", "closed"},
    "resolved": {"open", "in_progress", "closed"},       # reopen, or finish
    "closed": {"open"},                                  # only a reopen
}
ACTIVE = ("open", "in_progress", "pending")
PRIORITIES = ("low", "normal", "high", "urgent")
SOURCES = ("customer", "buzz", "admin")
CUSTOMER_VISIBLE = ("customer", "agent")
MAX_OPEN_PER_CUSTOMER = 5
MAX_MESSAGES = 300


class SupportError(ValueError):
    """A request the caller can fix. The message is safe to show."""


class NotFound(SupportError):
    pass


class RateLimited(SupportError):
    pass


# ---- rate limits and idempotency ----------------------------------------------------------------------

# action -> ((count, seconds) per user, (count, seconds) per IP address)
LIMITS = {
    "ticket": ((5, 3600), (10, 3600)),
    "message": ((20, 600), (40, 600)),
    "upload": ((30, 600), (60, 600)),
}
KEY_PATTERN = re.compile(r"[A-Za-z0-9_-]{16,64}")


def check_rate(db, action, user, ip, now=None):
    """Raise RateLimited when this user or IP address did `action` too often recently. Call record_rate on success."""
    now = now or _now()
    db.execute("DELETE FROM support_rate WHERE ts<?", (now - 86400,))
    for kind, key, (limit, window) in (("user", user, LIMITS[action][0]), ("ip", ip, LIMITS[action][1])):
        if key and db.execute("SELECT count(*) FROM support_rate WHERE bucket=? AND key=? AND ts>?",
                              (f"{action}:{kind}", key, now - window)).fetchone()[0] >= limit:
            raise RateLimited("You are doing that too often. Please wait a few minutes and try again.")


def record_rate(db, action, user, ip, now=None):
    now = now or _now()
    for kind, key in (("user", user), ("ip", ip)):
        if key:
            db.execute("INSERT INTO support_rate(bucket, key, ts) VALUES (?,?,?)", (f"{action}:{kind}", key, now))


def idempotent(db, scope, key, run):
    """Run `run()` once per (scope, key). A repeat of the same key (a double click, a retry) returns the first response
    instead of creating a second ticket or message. No key means no protection, the request just runs."""
    if not key or not KEY_PATTERN.fullmatch(key):
        return run()
    now = _now()
    db.execute("DELETE FROM support_idempotency WHERE created<?", (now - 86400,))
    saved = db.execute("SELECT response FROM support_idempotency WHERE scope=? AND key=?", (scope, key)).fetchone()
    if saved:
        return json.loads(saved["response"])
    result = run()
    db.execute("INSERT INTO support_idempotency(scope, key, response, created) VALUES (?,?,?,?)", (scope, key, json.dumps(result), now))
    return result


def _text(value, label, limit, minimum=1):
    if not isinstance(value, str):
        raise SupportError(f"Enter the {label}.")
    value = value.strip()
    if len(value) < minimum:
        raise SupportError(f"Enter the {label}.")
    if len(value) > limit:
        raise SupportError(f"The {label} is too long (up to {limit} characters).")
    if any(ord(ch) < 32 and ch not in "\n\t\r" for ch in value):
        raise SupportError(f"The {label} has characters that are not allowed.")
    return value


def categories():
    return [{"key": key, "label": label, "needsOrder": needs} for key, (label, needs) in CATEGORIES.items()]


def _now():
    return int(time.time())


def _owned_order(db, order_id, email):
    """The customer's own paid order, or None. Never reveals other customers' orders."""
    if not isinstance(order_id, str) or not re.fullmatch(r"[a-f0-9]{32}", order_id):
        return None
    return db.execute(
        "SELECT orders.id, order_owners.order_number, orders.status FROM order_owners JOIN orders "
        "ON orders.id=order_owners.order_id WHERE orders.id=? AND order_owners.email=? AND orders.status!='pending'",
        (order_id, email)).fetchone()


def _add_message(db, ticket_id, kind, author, body):
    count = db.execute("SELECT count(*) FROM support_messages WHERE ticket_id=?", (ticket_id,)).fetchone()[0]
    if count >= MAX_MESSAGES:
        raise SupportError("This ticket has too many messages. Please open a new ticket.")
    db.execute("INSERT INTO support_messages(ticket_id, kind, author, body, created) VALUES (?,?,?,?,?)",
               (ticket_id, kind, author, body, _now()))


def create_ticket(db, *, email, category, subject, message, order_id=None, source="customer",
                  ai_summary=None, priority="normal", assignee=None, actor=None):
    """Create a ticket and its first customer message. Returns the new ticket id.

    The customer form, an admin on a customer's behalf, and Buzz all call this one function.
    """
    email = _text(email, "email", 254).lower()
    if category not in CATEGORIES:
        raise SupportError("Choose a category.")
    if source not in SOURCES:
        raise SupportError("Unknown ticket source.")
    if priority not in PRIORITIES:
        raise SupportError("Unknown priority.")
    subject = _text(subject, "subject", 120, 3)
    message = _text(message, "message", 4000, 3)
    if ai_summary is not None:
        ai_summary = _text(ai_summary, "summary", 1000)
    label, needs_order = CATEGORIES[category]
    order = None
    if order_id:
        order = _owned_order(db, order_id, email)
        if not order:
            raise SupportError("Choose one of your own orders.")
    elif needs_order:
        raise SupportError(f"Choose the order this is about. “{label}” tickets are linked to an order.")
    open_now = db.execute("SELECT count(*) FROM support_tickets WHERE customer_email=? AND status IN ('open','in_progress','pending')",
                          (email,)).fetchone()[0]
    if source == "customer" and open_now >= MAX_OPEN_PER_CUSTOMER:
        raise SupportError("You already have several open tickets. Please wait for a reply or close one first.")
    now = _now()
    ticket_id = db.execute(
        "INSERT INTO support_tickets(customer_email, order_id, category, subject, status, priority, assignee, "
        "source, ai_summary, created, updated) VALUES (?,?,?,?, 'open', ?,?,?,?,?,?)",
        (email, order["id"] if order else None, category, subject, priority, assignee, source, ai_summary, now, now),
    ).lastrowid
    db.execute("UPDATE support_tickets SET ticket_number=? WHERE id=?", (f"SP-{ticket_id:05d}", ticket_id))
    _add_message(db, ticket_id, "customer", email, message)
    via = {"buzz": "Created by Buzz", "admin": "Created by support on the customer's behalf"}.get(source)
    if via:
        _add_message(db, ticket_id, "event", actor or source, via)
    return ticket_id


def _ticket(db, ticket_id):
    row = db.execute("SELECT * FROM support_tickets WHERE id=?", (ticket_id,)).fetchone() if isinstance(ticket_id, int) else None
    if not row:
        raise NotFound("That ticket was not found.")
    return row


def _touch(db, ticket_id, status=None):
    if status:
        db.execute("UPDATE support_tickets SET status=?, updated=?, closed=? WHERE id=?",
                   (status, _now(), _now() if status == "closed" else None, ticket_id))
    else:
        db.execute("UPDATE support_tickets SET updated=? WHERE id=?", (_now(), ticket_id))


# ---- customer side -------------------------------------------------------------------------------------

def customer_reply(db, ticket_id, email, message):
    ticket = _ticket(db, ticket_id)
    if ticket["customer_email"] != email:
        raise NotFound("That ticket was not found.")
    if ticket["status"] == "closed":
        raise SupportError("This ticket is closed. Please open a new ticket.")
    _add_message(db, ticket_id, "customer", email, _text(message, "message", 4000))
    if ticket["status"] == "pending":       # the customer answered: back to the team (to the same agent if assigned)
        _touch(db, ticket_id, "in_progress" if ticket["assignee"] else "open")
    elif ticket["status"] == "resolved":
        _touch(db, ticket_id, "open")
    else:
        _touch(db, ticket_id)


def customer_resolve(db, ticket_id, email):
    ticket = _ticket(db, ticket_id)
    if ticket["customer_email"] != email:
        raise NotFound("That ticket was not found.")
    if ticket["status"] in ("resolved", "closed"):
        return
    _add_message(db, ticket_id, "event", email, "Customer marked this as resolved")
    _touch(db, ticket_id, "resolved")


def _public_ticket(db, row):
    order = None
    if row["order_id"]:
        found = db.execute("SELECT orders.status, order_owners.order_number FROM orders LEFT JOIN order_owners "
                           "ON orders.id=order_owners.order_id WHERE orders.id=?", (row["order_id"],)).fetchone()
        if found:
            order = {"id": row["order_id"], "number": found["order_number"] or "PB-" + row["order_id"][:8].upper(),
                     "status": found["status"]}
    return {"id": row["id"], "number": row["ticket_number"], "category": row["category"],
            "categoryLabel": CATEGORIES.get(row["category"], (row["category"],))[0], "subject": row["subject"],
            "status": row["status"], "created": row["created"], "updated": row["updated"], "order": order}


def customer_tickets(db, email):
    rows = db.execute("SELECT * FROM support_tickets WHERE customer_email=? ORDER BY updated DESC, id DESC LIMIT 100",
                      (email,)).fetchall()
    return [_public_ticket(db, row) for row in rows]


def customer_ticket(db, ticket_id, email):
    row = _ticket(db, ticket_id)
    if row["customer_email"] != email:
        raise NotFound("That ticket was not found.")
    ticket = _public_ticket(db, row)
    # Only customer and agent messages. Internal notes and event lines never leave the server.
    files = _attachments(db, ticket_id)
    ticket["messages"] = [
        {"id": m["id"], "from": "you" if m["kind"] == "customer" else "support", "body": m["body"], "created": m["created"],
         "attachments": files.get(m["id"], [])}
        for m in db.execute("SELECT * FROM support_messages WHERE ticket_id=? AND kind IN ('customer','agent') ORDER BY id",
                            (ticket_id,))]
    return ticket


# ---- attachments ---------------------------------------------------------------------------------------

MAX_FILES_PER_MESSAGE = 5
MAX_FILES_PER_TICKET = 20
MAX_FILE_BYTES = 10 * 1024 * 1024
# The type is decided by the file's own first bytes, never by its name or the browser's claim.
SIGNATURES = ((b"%PDF-", "application/pdf", "pdf"), (b"\xff\xd8\xff", "image/jpeg", "jpg"),
              (b"\x89PNG\r\n\x1a\n", "image/png", "png"))


def sniff(body):
    for magic, content_type, extension in SIGNATURES:
        if body.startswith(magic):
            return content_type, extension
    raise SupportError("Only PDF, JPG and PNG files can be attached.")


def safe_filename(name, extension):
    """A harmless display / download name: no path, no odd characters, and an extension that matches the real type."""
    name = basename(str(name or "").replace("\\", "/"))
    stem = name.rsplit(".", 1)[0] if "." in name else name
    stem = re.sub(r"[^A-Za-z0-9 ._()-]+", "", stem)
    stem = re.sub(r"\s+", " ", stem).strip(" .-_")[:60]
    return f"{stem or 'attachment'}.{extension}"


def _attachments(db, ticket_id):
    grouped = {}
    for row in db.execute("SELECT id, message_id, filename, content_type, size FROM support_attachments WHERE ticket_id=? ORDER BY id",
                          (ticket_id,)):
        grouped.setdefault(row["message_id"], []).append(
            {"id": row["id"], "name": row["filename"], "type": row["content_type"], "size": row["size"]})
    return grouped


def add_attachment(db, ticket_id, message_id, uploader, filename, body, storage=None):
    """Store one file on a message the uploader wrote. `storage` is the existing private file store (S3) or None
    (then the bytes live in the database like order files). Returns the attachment's public description."""
    ticket = _ticket(db, ticket_id)
    message = db.execute("SELECT kind, author FROM support_messages WHERE id=? AND ticket_id=?", (message_id, ticket_id)).fetchone()
    # A stranger gets exactly the same "not found" as for a ticket that does not exist, so ids cannot be probed.
    if ticket["customer_email"] != uploader and not (message and message["kind"] == "agent" and message["author"] == uploader):
        raise NotFound("That ticket was not found.")
    if not message or message["kind"] not in ("customer", "agent") or message["author"] != uploader:
        raise SupportError("Attach files to a message you wrote.")
    if ticket["status"] == "closed":
        raise SupportError("This ticket is closed.")
    if not isinstance(body, (bytes, bytearray)) or not 0 < len(body) <= MAX_FILE_BYTES:
        raise SupportError("Each file must be between 1 byte and 10 MB.")
    content_type, extension = sniff(bytes(body[:16]))
    if db.execute("SELECT count(*) FROM support_attachments WHERE message_id=?", (message_id,)).fetchone()[0] >= MAX_FILES_PER_MESSAGE:
        raise SupportError(f"You can attach up to {MAX_FILES_PER_MESSAGE} files per message.")
    if db.execute("SELECT count(*) FROM support_attachments WHERE ticket_id=?", (ticket_id,)).fetchone()[0] >= MAX_FILES_PER_TICKET:
        raise SupportError("This ticket has reached its file limit.")
    name = safe_filename(filename, extension)
    ident = db.execute("INSERT INTO support_attachments(ticket_id, message_id, filename, content_type, size, uploaded_by, created) "
                       "VALUES (?,?,?,?,?,?,?)", (ticket_id, message_id, name, content_type, len(body), uploader, _now())).lastrowid
    if storage:
        key = storage.put_support(ticket_id, ident, bytes(body))
        db.execute("UPDATE support_attachments SET object_key=? WHERE id=?", (key, ident))
    else:
        db.execute("UPDATE support_attachments SET content=? WHERE id=?", (bytes(body), ident))
    _touch(db, ticket_id)
    return {"id": ident, "name": name, "type": content_type, "size": len(body)}


def attachment_for_customer(db, attachment_id, email):
    """The attachment row, only if the ticket belongs to this customer."""
    row = db.execute("SELECT a.*, t.customer_email FROM support_attachments a JOIN support_tickets t ON t.id=a.ticket_id "
                     "WHERE a.id=?", (attachment_id,)).fetchone() if isinstance(attachment_id, int) else None
    if not row or row["customer_email"] != email:
        raise NotFound("That file was not found.")
    return row


def attachment_for_staff(db, attachment_id):
    row = db.execute("SELECT * FROM support_attachments WHERE id=?", (attachment_id,)).fetchone() if isinstance(attachment_id, int) else None
    if not row:
        raise NotFound("That file was not found.")
    return row


# ---- staff side ----------------------------------------------------------------------------------------

def staff_reply(db, ticket_id, actor, message, internal=False):
    ticket = _ticket(db, ticket_id)
    if not internal and ticket["status"] == "closed":
        raise SupportError("This ticket is closed. Reopen it to reply.")
    _add_message(db, ticket_id, "internal" if internal else "agent", actor, _text(message, "message", 4000))
    if internal:
        _touch(db, ticket_id)
    else:   # a reply now waits on the customer
        _touch(db, ticket_id, "pending" if ticket["status"] in ("open", "in_progress") else None)


def set_status(db, ticket_id, actor, status):
    if status not in STATUSES:
        raise SupportError("Unknown status.")
    ticket = _ticket(db, ticket_id)
    if ticket["status"] == status:
        return
    if status not in TRANSITIONS[ticket["status"]]:
        raise SupportError(f"A {ticket['status'].replace('_', ' ')} ticket cannot go to {status.replace('_', ' ')}.")
    _add_message(db, ticket_id, "event", actor, f"Status changed from {ticket['status']} to {status}")
    _touch(db, ticket_id, status)


def set_priority(db, ticket_id, actor, priority):
    if priority not in PRIORITIES:
        raise SupportError("Unknown priority.")
    ticket = _ticket(db, ticket_id)
    if ticket["priority"] == priority:
        return
    _add_message(db, ticket_id, "event", actor, f"Priority changed from {ticket['priority']} to {priority}")
    db.execute("UPDATE support_tickets SET priority=? WHERE id=?", (priority, ticket_id))
    _touch(db, ticket_id)


def assign(db, ticket_id, actor, assignee, allowed):
    """Assign to an admin or warehouse user (`allowed` is the set of their emails), or None to unassign."""
    ticket = _ticket(db, ticket_id)
    if assignee in ("", None):
        assignee = None
    else:
        assignee = _text(assignee, "assignee", 254).lower()
        if assignee not in allowed:
            raise SupportError("Choose an admin or warehouse team member.")
    if ticket["assignee"] == assignee:
        return
    _add_message(db, ticket_id, "event", actor, f"Assigned to {assignee}" if assignee else "Unassigned")
    db.execute("UPDATE support_tickets SET assignee=? WHERE id=?", (assignee, ticket_id))
    if assignee and ticket["status"] == "open":       # someone owns it now, so work has started
        _add_message(db, ticket_id, "event", actor, "Status changed from open to in_progress")
        _touch(db, ticket_id, "in_progress")
    else:
        _touch(db, ticket_id)


SORTS = {
    "updated": "t.updated DESC, t.id DESC",                      # latest activity first (the default)
    "newest": "t.created DESC, t.id DESC",
    "oldest": "t.created ASC, t.id ASC",
    "priority": "CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.updated DESC, t.id DESC",
}


def staff_tickets(db, *, status=None, priority=None, assignee=None, category=None, query=None, sort="updated", limit=25, offset=0):
    where, params = [], []
    if status in STATUSES:
        where.append("t.status=?"); params.append(status)
    elif status == "active":
        where.append("t.status IN ('open','in_progress','pending')")
    if priority in PRIORITIES:
        where.append("t.priority=?"); params.append(priority)
    if category in CATEGORIES:
        where.append("t.category=?"); params.append(category)
    if assignee == "unassigned":
        where.append("t.assignee IS NULL")
    elif assignee:
        where.append("t.assignee=?"); params.append(assignee.lower())
    if query:
        like = "%" + query.strip().lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        where.append("(lower(t.ticket_number) LIKE ? ESCAPE '\\' OR lower(t.subject) LIKE ? ESCAPE '\\' "
                     "OR lower(t.customer_email) LIKE ? ESCAPE '\\' OR lower(COALESCE(o.order_number,'')) LIKE ? ESCAPE '\\')")
        params += [like] * 4
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    limit = max(1, min(int(limit), 100))
    offset = max(0, int(offset))
    base = "FROM support_tickets t LEFT JOIN order_owners o ON o.order_id=t.order_id " + clause
    total = db.execute("SELECT count(*) " + base, params).fetchone()[0]
    rows = db.execute(
        "SELECT t.*, o.order_number, (SELECT body FROM support_messages m WHERE m.ticket_id=t.id AND m.kind IN ('customer','agent') "
        "ORDER BY m.id DESC LIMIT 1) AS preview " + base + " ORDER BY " + SORTS.get(sort, SORTS["updated"]) + " LIMIT ? OFFSET ?",
        (*params, limit, offset)).fetchall()
    counts = {row["status"]: row["n"] for row in db.execute("SELECT status, count(*) AS n FROM support_tickets GROUP BY status")}
    new = db.execute("SELECT count(*) FROM support_tickets WHERE status='open' AND assignee IS NULL").fetchone()[0]
    return {"tickets": [_staff_summary(row) for row in rows], "total": total, "limit": limit, "offset": offset,
            "counts": {s: counts.get(s, 0) for s in STATUSES}, "new": new}


def _staff_summary(row):
    return {"id": row["id"], "number": row["ticket_number"], "customer": row["customer_email"], "category": row["category"],
            "categoryLabel": CATEGORIES.get(row["category"], (row["category"],))[0], "subject": row["subject"],
            "status": row["status"], "priority": row["priority"], "assignee": row["assignee"], "source": row["source"],
            "orderNumber": row["order_number"] if "order_number" in row.keys() else None,
            "preview": " ".join(str(row["preview"]).split())[:140] if "preview" in row.keys() and row["preview"] else "",
            "created": row["created"], "updated": row["updated"]}


def staff_ticket(db, ticket_id):
    row = _ticket(db, ticket_id)
    number = db.execute("SELECT order_number FROM order_owners WHERE order_id=?", (row["order_id"],)).fetchone() if row["order_id"] else None
    ticket = _staff_summary(_with_number(row, number))
    files = _attachments(db, ticket_id)
    ticket.update({"orderId": row["order_id"], "aiSummary": row["ai_summary"],
                   "messages": [{"id": m["id"], "kind": m["kind"], "author": m["author"], "body": m["body"], "created": m["created"],
                                 "attachments": files.get(m["id"], [])}
                                for m in db.execute("SELECT * FROM support_messages WHERE ticket_id=? ORDER BY id", (ticket_id,))]})
    ticket["order"] = order_context(db, row["order_id"]) if row["order_id"] else None
    ticket["nextStatuses"] = [s for s in STATUSES if s in TRANSITIONS[row["status"]]]
    return ticket


class _Row(dict):
    def keys(self):
        return list(super().keys())


def _with_number(row, number):
    data = _Row(dict(row))
    data["order_number"] = number["order_number"] if number else None
    return data


def _display_name(identifier):
    return re.sub(r"[-_.]+", " ", str(identifier).split("@")[0]).strip().title()


def order_context(db, order_id):
    """What a support agent needs about the linked order. The delivery code itself is NEVER included, only its state."""
    row = db.execute(
        "SELECT orders.status, orders.details, order_owners.order_number, "
        "(SELECT min(created) FROM audit WHERE audit.order_id=orders.id AND action='paid') AS paid_at "
        "FROM orders LEFT JOIN order_owners ON orders.id=order_owners.order_id WHERE orders.id=?", (order_id,)).fetchone()
    if not row:
        return None
    details = json.loads(row["details"] or "{}")
    number = row["order_number"] or "PB-" + order_id[:8].upper()
    total = details.get("bill", {}).get("total", details.get("subtotal"))
    context = {
        "id": order_id, "number": number, "status": row["status"], "paidAt": row["paid_at"],
        "customerName": details.get("customer"), "address": details.get("address"),
        "files": len(details.get("items", [])), "total": total,
        "events": [{"event": e["event"], "to": e["to_status"], "created": e["created"]} for e in db.execute(
            "SELECT event, to_status, created FROM order_events WHERE order_id=? ORDER BY id DESC LIMIT 6", (order_id,))],
        "invoice": {"number": number, "total": total, "url": f"/api/admin/orders/{order_id}/invoice"},
        "delivery": None,
    }
    delivery = db.execute("SELECT partner, nonce, expires, attempts, located_at FROM deliveries WHERE order_id=?", (order_id,)).fetchone()
    if delivery:
        if row["status"] != "out_for_delivery" or not delivery["nonce"]:
            otp = "not_issued"
        elif delivery["attempts"] >= 3:
            otp = "locked"
        elif delivery["expires"] and delivery["expires"] <= time.time():
            otp = "expired"
        else:
            otp = "active"
        context["delivery"] = {"beeRunner": _display_name(delivery["partner"]), "beeRunnerId": delivery["partner"],
                               "otpState": otp, "attempts": delivery["attempts"],
                               "lastLocationAt": delivery["located_at"]}
    return context

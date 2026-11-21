"""Role-filtered reads of the central `order_events` log: the data behind the live feed.

One feed, four audiences. Payloads carry only what the audience may see: order id and number,
the event, the status change and the time. Never customer details, addresses or delivery codes.
"""

# What a delivery partner may learn about an order that is not (or no longer) theirs: only that
# something changed on an order that reached the ready pool, so their list can refresh.
PARTNER_POOL_EVENTS = ("packed", "delivery_accepted", "delivery_reassigned", "order_cancelled", "refund_requested")


def latest(db):
    return db.execute("SELECT COALESCE(max(id),0) FROM order_events").fetchone()[0]


def public(row, audience):
    event = {
        "id": row["id"], "order": row["order_id"],
        "number": row["order_number"] or "PB-" + row["order_id"][:8].upper(),
        "event": row["event"], "from": row["from_status"], "to": row["to_status"], "at": row["created"],
    }
    if audience in ("admin", "warehouse"):
        event["actor"] = row["actor"]
    return event


def fetch(db, audience, identity, since, limit=100):
    """Events with id > since that `audience` (signed in as `identity`) may see, oldest first."""
    sql = ("SELECT e.id, e.order_id, e.event, e.actor, e.from_status, e.to_status, e.created, o.order_number "
           "FROM order_events e LEFT JOIN order_owners o ON o.order_id=e.order_id WHERE e.id>? ")
    params = [since]
    if audience in ("admin", "warehouse"):
        pass
    elif audience == "customer":
        sql += "AND o.email=? "
        params.append(identity)
    elif audience == "partner":
        sql += ("AND EXISTS (SELECT 1 FROM order_events p WHERE p.order_id=e.order_id AND p.to_status='packed') "
                "AND (e.event IN (" + ",".join("?" for _ in PARTNER_POOL_EVENTS) + ") "
                "OR EXISTS (SELECT 1 FROM deliveries d WHERE d.order_id=e.order_id AND d.partner=?)) ")
        params += [*PARTNER_POOL_EVENTS, identity]
    else:
        return []
    rows = db.execute(sql + "ORDER BY e.id LIMIT ?", (*params, limit)).fetchall()
    return [public(row, audience) for row in rows]


def timeline(db, order_id, audience="customer"):
    """Ordered status history of one order (callers check ownership/role first)."""
    rows = db.execute(
        "SELECT e.id, e.order_id, e.event, e.actor, e.from_status, e.to_status, e.created, o.order_number "
        "FROM order_events e LEFT JOIN order_owners o ON o.order_id=e.order_id WHERE e.order_id=? ORDER BY e.id",
        (order_id,)).fetchall()
    return [public(row, audience) for row in rows]

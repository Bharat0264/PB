"""Admin ledger derived from confirmed payment, refund, and settlement records."""

PAGE_SIZE = 25
KINDS = ("payment", "offline", "refund", "payout")
ENTRIES = """
WITH entries(kind, order_number, description, reference, amount, date) AS (
    SELECT 'payment', COALESCE(o.order_number, 'PB-' || upper(substr(p.order_id,1,8))),
           'Razorpay payment', p.payment_id, p.amount,
           (SELECT min(created) FROM audit WHERE action='paid' AND order_id=p.order_id)
    FROM razorpay_orders AS p LEFT JOIN order_owners AS o ON o.order_id=p.order_id
    WHERE p.payment_id IS NOT NULL
    UNION ALL
    SELECT 'offline', 'PB-OFF-' || upper(substr(id,1,8)), product, id, total, created
    FROM offline_sales
    UNION ALL
    SELECT 'refund', COALESCE(o.order_number, 'PB-' || upper(substr(r.order_id,1,8))),
           'Razorpay refund', r.provider_id, -p.amount,
           (SELECT min(created) FROM audit WHERE action='refund.processed' AND order_id=r.order_id)
    FROM razorpay_refunds AS r JOIN razorpay_orders AS p ON p.order_id=r.order_id
    LEFT JOIN order_owners AS o ON o.order_id=r.order_id
    WHERE r.state='processed' AND p.payment_id IS NOT NULL
    UNION ALL
    SELECT 'payout', COALESCE(o.order_number, 'PB-' || upper(substr(e.order_id,1,8))),
           'Partner payout · ' || e.partner, e.reference, -e.amount, e.settled
    FROM partner_earnings AS e LEFT JOIN order_owners AS o ON o.order_id=e.order_id
    WHERE e.settled IS NOT NULL AND e.amount>0
)
"""


def ledger(db, page, kind):
    totals = dict.fromkeys(KINDS, 0)
    count = 0
    rows = db.execute(ENTRIES + "SELECT kind, sum(amount), count(*) FROM entries GROUP BY kind")
    for key, total, size in rows:
        totals[key] = total
        if not kind or key == kind:
            count += size
    pages = max(1, (count + PAGE_SIZE - 1) // PAGE_SIZE)
    page = min(page, pages)
    rows = db.execute(ENTRIES + """
        SELECT * FROM entries WHERE ?='' OR kind=?
        ORDER BY date DESC, order_number DESC, kind, reference
        LIMIT ? OFFSET ?
    """, (kind, kind, PAGE_SIZE, (page - 1) * PAGE_SIZE))
    return {"entries": [dict(row) for row in rows], "totals": totals, "page": page, "pages": pages}

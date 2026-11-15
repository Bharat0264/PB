"""Admin money figures, derived from the stored order bills, partner earnings and refund states.

All amounts are integer paise. Definitions (also in docs/connected-workflow):
  revenue          money in for orders that are paid and not refunded or cancelled (tax included)
  delivered        the part of that revenue for orders already delivered
  profit           delivered sales excluding tax, minus partner earnings accrued on those deliveries
                   (before paper, toner and rent, which PrintBee does not record)
Order bills are the snapshot saved at checkout, so later price changes never rewrite history.
"""
LIVE = ("paid", "printing", "packed", "out_for_delivery", "undeliverable", "delivered")
_BILLS = ("SELECT status, "
          "CAST(COALESCE(json_extract(details,'$.bill.total'), json_extract(details,'$.subtotal'), 0) AS INTEGER) AS total, "
          "CAST(COALESCE(json_extract(details,'$.bill.tax'), 0) AS INTEGER) AS tax FROM orders")


def summary(db):
    marks = ",".join("?" for _ in LIVE)
    row = db.execute(
        "SELECT COALESCE(sum(CASE WHEN status IN (" + marks + ") THEN total END), 0) AS revenue, "
        "COALESCE(sum(CASE WHEN status='delivered' THEN total END), 0) AS delivered, "
        "COALESCE(sum(CASE WHEN status='delivered' THEN tax END), 0) AS delivered_tax, "
        "COALESCE(sum(CASE WHEN status IN (" + marks + ") THEN tax END), 0) AS tax, "
        "COALESCE(sum(CASE WHEN status='refunded' THEN total END), 0) AS refunded, "
        "COALESCE(sum(CASE WHEN status IN ('refund_pending','refund_failed') THEN total END), 0) AS refunding, "
        "count(CASE WHEN status IN (" + marks + ") THEN 1 END) AS orders FROM (" + _BILLS + ")",
        (*LIVE, *LIVE, *LIVE),
    ).fetchone()
    earnings = db.execute(
        "SELECT COALESCE(sum(amount), 0) AS accrued, "
        "COALESCE(sum(CASE WHEN settled IS NOT NULL THEN amount END), 0) AS settled, "
        "COALESCE(sum(CASE WHEN settled IS NULL THEN amount END), 0) AS outstanding FROM partner_earnings"
    ).fetchone()
    return {
        "orders": row["orders"], "revenue": row["revenue"], "delivered": row["delivered"], "tax": row["tax"],
        "refunded": row["refunded"], "refunding": row["refunding"],
        "partnerEarnings": dict(earnings),
        "profit": row["delivered"] - row["delivered_tax"] - earnings["accrued"],
    }

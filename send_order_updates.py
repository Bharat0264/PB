"""Send order update emails from the audit log using the configured SMTP account."""

import os
import smtplib
import ssl
from contextlib import closing
from email.message import EmailMessage
from urllib.parse import urlsplit

from customer_auth import public_origin
from server import connect

EVENTS = {
    "paid": "Order received", "printing": "Printing", "packed": "Packed",
    "delivery_picked_up": "Out for delivery", "delivery_completed": "Delivered",
    "order_cancelled": "Cancelled", "refund_requested": "Refund requested",
    "refund.processed": "Refunded", "refund.failed": "Refund needs assistance",
}


def send_batch(smtp, sender, origin, limit=50):
    with closing(connect()) as db:
        with db:
            db.execute("CREATE TABLE IF NOT EXISTS order_email_cursor "
                       "(singleton INTEGER PRIMARY KEY CHECK(singleton=1), last_seen INTEGER NOT NULL)")
            db.execute("INSERT OR IGNORE INTO order_email_cursor VALUES (1, COALESCE((SELECT max(id) FROM audit),0))")
        cursor = db.execute("SELECT last_seen FROM order_email_cursor").fetchone()[0]
        rows = db.execute(
            "SELECT audit.id, action, audit.order_id, order_number, email FROM audit JOIN order_owners USING(order_id) "
            "WHERE audit.id>? AND action IN (" + ",".join("?" for _ in EVENTS) + ") "
            "ORDER BY audit.id LIMIT ?", (cursor, *EVENTS, limit)
        ).fetchall()
        for row in rows:
            number = row["order_number"] or "PB-" + row["order_id"][:8].upper()
            status = EVENTS[row["action"]]
            mail = EmailMessage()
            mail["From"] = sender
            mail["To"] = row["email"]
            mail["Subject"] = f"PrintBee {number} · {status}"
            mail.set_content(f"{number}\n{status}\n\nView your order: {origin}/orders.html\n")
            smtp.send_message(mail)
            with db:
                db.execute("UPDATE order_email_cursor SET last_seen=? WHERE singleton=1", (row["id"],))
    return len(rows)


if __name__ == "__main__":
    origin = public_origin()
    if urlsplit(origin).scheme != "https":
        raise SystemExit("Configure the public HTTPS PrintBee origin before sending order updates.")
    with smtplib.SMTP(os.environ["PRINTBEE_SMTP_HOST"], int(os.environ.get("PRINTBEE_SMTP_PORT", "587")),
                      timeout=10) as smtp:
        smtp.starttls(context=ssl.create_default_context())
        if os.environ.get("PRINTBEE_SMTP_USER"):
            smtp.login(os.environ["PRINTBEE_SMTP_USER"], os.environ["PRINTBEE_SMTP_PASSWORD"])
        print(f"Sent {send_batch(smtp, os.environ['PRINTBEE_SMTP_FROM'], origin)} order updates.")

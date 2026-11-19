"""Send order update emails from the central order_events log using the configured SMTP account.

One email per real status change (paid, printing, ready, out for delivery, delivered, cancelled,
refund updates, undeliverable) plus "partner assigned". Wording comes from order_status.py, the same
text every portal shows. The out-for-delivery email carries the customer's delivery code: it goes
only to the order's owner, exactly like the code on the tracking page.
"""

import os
import smtplib
import ssl
from contextlib import closing
from email.message import EmailMessage
from urllib.parse import urlsplit

import fulfillment as ops
import order_status
from customer_auth import public_origin
from server import connect, staff_keys

# Events that are worth an email. Status changes use the model's label; the rest have fixed wording.
EXTRA = {"delivery_accepted": ("Delivery partner assigned", "A delivery partner has been assigned to your order.")}


def message_for(row, secret, db, origin):
    """(subject status, body lines) for one event row, or None when it is not email-worthy."""
    number = row["order_number"] or "PB-" + row["order_id"][:8].upper()
    if row["event"] in EXTRA:
        title, text = EXTRA[row["event"]]
    elif row["to_status"] != row["from_status"] and row["to_status"] in order_status.STATUSES and row["to_status"] != "pending":
        info = order_status.STATUSES[row["to_status"]]
        title, text = info["label"], info["customer"]
    else:
        return None
    lines = [number, title, "", text]
    if row["to_status"] == "out_for_delivery":
        delivery = db.execute("SELECT nonce FROM deliveries WHERE order_id=?", (row["order_id"],)).fetchone()
        if delivery and delivery["nonce"]:
            lines += ["", "Delivery code: " + ops.delivery_code(secret, delivery["nonce"]),
                      "Give this code to the delivery partner only when you have your order."]
    lines += ["", "View your order: " + origin + "/orders.html"]
    return number, title, "\n".join(lines) + "\n"


def send_batch(smtp, sender, origin, limit=50):
    secret = staff_keys()["delivery-code"].encode()
    with closing(connect()) as db:
        with db:
            db.execute("CREATE TABLE IF NOT EXISTS order_event_email_cursor "
                       "(singleton INTEGER PRIMARY KEY CHECK(singleton=1), last_seen INTEGER NOT NULL)")
            db.execute("INSERT OR IGNORE INTO order_event_email_cursor VALUES "
                       "(1, COALESCE((SELECT max(id) FROM order_events),0))")
        cursor = db.execute("SELECT last_seen FROM order_event_email_cursor").fetchone()[0]
        rows = db.execute(
            "SELECT e.id, e.order_id, e.event, e.from_status, e.to_status, o.order_number, o.email "
            "FROM order_events e JOIN order_owners o ON o.order_id=e.order_id "
            "WHERE e.id>? ORDER BY e.id LIMIT ?", (cursor, limit)
        ).fetchall()
        sent = 0
        for row in rows:
            built = message_for(row, secret, db, origin)
            if built:
                number, title, body = built
                mail = EmailMessage()
                mail["From"] = sender
                mail["To"] = row["email"]
                mail["Subject"] = f"PrintBee {number} · {title}"
                mail.set_content(body)
                smtp.send_message(mail)
                sent += 1
            with db:
                db.execute("UPDATE order_event_email_cursor SET last_seen=? WHERE singleton=1", (row["id"],))
    return sent


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
        import support_notify
        print(f"Sent {support_notify.send_batch(smtp, os.environ['PRINTBEE_SMTP_FROM'], origin)} support emails.")
        if os.environ.get("PRINTBEE_OWNER_EMAIL"):
            with closing(connect()) as db:
                print(f"Sent {support_notify.send_escalations(smtp, os.environ['PRINTBEE_SMTP_FROM'], origin, os.environ['PRINTBEE_OWNER_EMAIL'], db)} owner alerts.")

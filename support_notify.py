"""Email customers when support replies to their ticket, using the same SMTP account as the order-update worker.

Run it from send_order_updates.py (one worker, one schedule) or on its own. A cursor remembers the last support
message that was handled, so each reply is emailed once. The email never contains the reply itself: it only says
there is a reply and links to the ticket, where the customer signs in to read it.
"""

import os
import smtplib
import ssl
from contextlib import closing
from email.message import EmailMessage
from urllib.parse import urlsplit

from customer_auth import public_origin


def build_message(ticket, origin):
    """(subject, body) for one staff reply."""
    subject = f"PrintBee support · reply on {ticket['ticket_number']}"
    body = "\n".join([
        f"Hello,",
        "",
        f"PrintBee Support replied to your ticket {ticket['ticket_number']}: {ticket['subject']}",
        "",
        f"Read the reply and answer here (sign in first): {origin}/help.html#/ticket/{ticket['id']}",
        "",
        "For your privacy the reply is not included in this email.",
    ]) + "\n"
    return subject, body


def send_batch(smtp, sender, origin, limit=50):
    from server import connect       # imported here so importing this module never starts the server module's work early

    with closing(connect()) as db:
        with db:
            db.execute("CREATE TABLE IF NOT EXISTS support_email_cursor "
                       "(singleton INTEGER PRIMARY KEY CHECK(singleton=1), last_seen INTEGER NOT NULL)")
            db.execute("INSERT OR IGNORE INTO support_email_cursor VALUES "
                       "(1, COALESCE((SELECT max(id) FROM support_messages),0))")
        cursor = db.execute("SELECT last_seen FROM support_email_cursor").fetchone()[0]
        rows = db.execute(
            "SELECT m.id AS message_id, t.id, t.ticket_number, t.subject, t.customer_email FROM support_messages m "
            "JOIN support_tickets t ON t.id=m.ticket_id WHERE m.id>? AND m.kind='agent' AND t.customer_email LIKE '%@%' "
            "AND t.source!='runner' ORDER BY m.id LIMIT ?",
            (cursor, limit)).fetchall()
        sent = 0
        for row in rows:
            subject, body = build_message(row, origin)
            mail = EmailMessage()
            mail["From"] = sender
            mail["To"] = row["customer_email"]
            mail["Subject"] = subject
            mail.set_content(body)
            smtp.send_message(mail)
            sent += 1
            with db:
                db.execute("UPDATE support_email_cursor SET last_seen=? WHERE singleton=1", (row["message_id"],))
        if not rows:    # nothing to send: still move past internal notes and customer messages
            top = db.execute("SELECT COALESCE(max(id),0) FROM support_messages").fetchone()[0]
            with db:
                db.execute("UPDATE support_email_cursor SET last_seen=? WHERE singleton=1 AND last_seen<?", (top, top))
    return sent


REASONS = {
    "urgent": "A ticket was marked URGENT",
    "buzz_escalation": "Buzz escalated a ticket",
    "overdue": "A ticket has had no staff reply for too long",
}


def build_escalation(row, origin):
    """(subject, body) for the owner. It names the ticket and why, and links to it; it never quotes the conversation."""
    subject = f"[PrintBee] {REASONS.get(row['reason'], 'Support escalation')}: {row['ticket_number']}"
    body = chr(10).join([
        REASONS.get(row["reason"], "Support escalation") + ".",
        "",
        f"Ticket: {row['ticket_number']}",
        f"Category: {row['category'].replace('_', ' ')}",
        f"Priority: {row['priority']}",
        f"Created by: {row['source']}",
        "",
        f"Open it in the admin portal: {origin}/admin#support/{row['ticket_id']}",
    ]) + chr(10)
    return subject, body


def send_escalations(smtp, sender, origin, owner, db):
    """Email the owner about urgent / escalated / overdue tickets that have not been reported yet. Returns how many."""
    import support
    with db:
        support.queue_overdue(db)
    sent = 0
    for row in support.pending_escalations(db):
        subject, body = build_escalation(row, origin)
        mail = EmailMessage()
        mail["From"], mail["To"], mail["Subject"] = sender, owner, subject
        mail.set_content(body)
        smtp.send_message(mail)
        with db:
            support.mark_escalation_sent(db, row["id"])
        sent += 1
    return sent


def send_pending_now():
    """Called by the web server in the background right after an urgent / escalated ticket is created."""
    owner, host, sender = os.environ.get("PRINTBEE_OWNER_EMAIL"), os.environ.get("PRINTBEE_SMTP_HOST"), os.environ.get("PRINTBEE_SMTP_FROM")
    origin = public_origin()
    if not (owner and host and sender and origin.startswith("https://")):
        return 0
    from server import connect
    try:
        with closing(connect()) as db, smtplib.SMTP(host, int(os.environ.get("PRINTBEE_SMTP_PORT", "587")), timeout=10) as smtp:
            smtp.starttls(context=ssl.create_default_context())
            if os.environ.get("PRINTBEE_SMTP_USER"):
                smtp.login(os.environ["PRINTBEE_SMTP_USER"], os.environ["PRINTBEE_SMTP_PASSWORD"])
            return send_escalations(smtp, sender, origin, owner, db)
    except (OSError, smtplib.SMTPException):
        return 0          # the scheduled worker tries again


if __name__ == "__main__":
    origin = public_origin()
    if urlsplit(origin).scheme != "https":
        raise SystemExit("Configure the public HTTPS PrintBee origin before sending support emails.")
    with smtplib.SMTP(os.environ["PRINTBEE_SMTP_HOST"], int(os.environ.get("PRINTBEE_SMTP_PORT", "587")), timeout=10) as smtp:
        smtp.starttls(context=ssl.create_default_context())
        if os.environ.get("PRINTBEE_SMTP_USER"):
            smtp.login(os.environ["PRINTBEE_SMTP_USER"], os.environ["PRINTBEE_SMTP_PASSWORD"])
        print(f"Sent {send_batch(smtp, os.environ['PRINTBEE_SMTP_FROM'], origin)} support emails.")
        if os.environ.get("PRINTBEE_OWNER_EMAIL"):
            from server import connect
            with closing(connect()) as db:
                print(f"Sent {send_escalations(smtp, os.environ['PRINTBEE_SMTP_FROM'], origin, os.environ['PRINTBEE_OWNER_EMAIL'], db)} owner alerts.")

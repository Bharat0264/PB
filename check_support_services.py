"""Check the two outside services that support tickets use, without touching any real customer data.

    python check_support_services.py                 # checks file storage (S3 / R2) only
    python check_support_services.py you@example.com # also sends one real test email to that address

File storage: uploads a tiny test PDF under printbee/support/check/, reads it back, compares it, then deletes it.
Email: sends the exact "support replied" email (with a made-up ticket) through the configured SMTP account.
Nothing is created in the PrintBee database.
"""

import os
import smtplib
import ssl
import sys
from email.message import EmailMessage

from customer_auth import public_origin

REQUIRED_STORAGE = ["PRINTBEE_S3_BUCKET"]
REQUIRED_SMTP = ["PRINTBEE_SMTP_HOST", "PRINTBEE_SMTP_FROM"]


def check_storage():
    bucket = os.environ.get("PRINTBEE_S3_BUCKET")
    if not bucket:
        print("STORAGE: not configured. Attachments are stored inside the database (this works, it is just not S3).")
        print("         To test S3 / Cloudflare R2, set PRINTBEE_S3_BUCKET (a private bucket), PRINTBEE_S3_ENDPOINT (R2 or other")
        print("         S3-compatible only) and the AWS credentials AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_DEFAULT_REGION,")
        print("         then run this script again. The key needs read, write and delete on printbee/orders/ and printbee/support/.")
        return None
    try:
        from order_documents import PrivateFiles
        files = PrivateFiles(bucket)
        body = b"%PDF-1.4\n% PrintBee storage check\n"
        key = files.put_support("check", 0, body)
        try:
            same = files.read(key) == body
        finally:
            files.client.delete_object(Bucket=bucket, Key=key)
        print(f"STORAGE: {'OK' if same else 'FAILED (read back different bytes)'}: wrote, read and deleted {key} in bucket {bucket!r}.")
        return same
    except Exception as error:      # any boto/credential/network error: show it plainly
        print(f"STORAGE: FAILED: {type(error).__name__}: {error}")
        return False


def check_email(address):
    missing = [name for name in REQUIRED_SMTP if not os.environ.get(name)]
    origin = public_origin()
    if missing or not address:
        if missing:
            print("EMAIL: not configured. Set " + ", ".join(missing) + " (and PRINTBEE_SMTP_PORT, PRINTBEE_SMTP_USER,")
            print("       PRINTBEE_SMTP_PASSWORD if your provider needs them), set PRINTBEE_ORIGIN to your public https address,")
            print("       then run:  python check_support_services.py you@example.com")
        else:
            print("EMAIL: configured. Run again with an address to send a real test: python check_support_services.py you@example.com")
        return None
    if not origin.startswith("https://"):
        print(f"EMAIL: PRINTBEE_ORIGIN is {origin!r}. It must be your public https address, because the link in the email is built from it.")
        return False
    from support_notify import build_message
    subject, text = build_message({"id": 0, "ticket_number": "SP-00000", "subject": "Test ticket (not real)"}, origin)
    mail = EmailMessage()
    mail["From"], mail["To"], mail["Subject"] = os.environ["PRINTBEE_SMTP_FROM"], address, "[TEST] " + subject
    mail.set_content(text)
    try:
        with smtplib.SMTP(os.environ["PRINTBEE_SMTP_HOST"], int(os.environ.get("PRINTBEE_SMTP_PORT", "587")), timeout=15) as smtp:
            smtp.starttls(context=ssl.create_default_context())
            if os.environ.get("PRINTBEE_SMTP_USER"):
                smtp.login(os.environ["PRINTBEE_SMTP_USER"], os.environ["PRINTBEE_SMTP_PASSWORD"])
            smtp.send_message(mail)
    except Exception as error:
        print(f"EMAIL: FAILED: {type(error).__name__}: {error}")
        return False
    print(f"EMAIL: OK: sent a test support-reply email to {address}. Its link points to {origin}/help.html#/ticket/0")
    return True


if __name__ == "__main__":
    results = [check_storage(), check_email(sys.argv[1] if len(sys.argv) > 1 else None)]
    raise SystemExit(1 if False in results else 0)

"""Phone verification for enrolled delivery partners."""

import base64
import json
import os
import re
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

SCHEMA = """
CREATE TABLE IF NOT EXISTS partner_sessions (
    digest TEXT PRIMARY KEY, partner TEXT NOT NULL, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS partner_auth_limits (
    scope TEXT NOT NULL, created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS partner_auth_time ON partner_auth_limits(created);
"""


PER_PHONE, PER_IP, SITE_WIDE, WINDOW = 5, 20, 1000, 600     # per 10 minutes; the site-wide number is only an emergency brake


def allow_attempt(db, action, phone_digest, ip_digest, now):
    """Run inside BEGIN IMMEDIATE. True (and the attempt is counted) unless this phone or this visitor address
    has tried too often, or the site as a whole is flooded. One caller can no longer lock every partner out."""
    db.execute("DELETE FROM partner_auth_limits WHERE created<=?", (now - WINDOW,))
    scope, visitor = action + ":" + phone_digest, "ip:" + ip_digest
    count, last = db.execute("SELECT count(*), max(created) FROM partner_auth_limits WHERE scope=?", (scope,)).fetchone()
    from_ip = db.execute("SELECT count(*) FROM partner_auth_limits WHERE scope=?", (visitor,)).fetchone()[0]
    total = db.execute("SELECT count(*) FROM partner_auth_limits").fetchone()[0]
    if total >= SITE_WIDE or count >= PER_PHONE or from_ip >= PER_IP or (action == "send" and last and last > now - 60):
        return False
    db.executemany("INSERT INTO partner_auth_limits VALUES (?,?)", [(scope, now), (visitor, now)])
    return True


class Verify:
    def __init__(self, service, account, secret):
        self.url = "https://verify.twilio.com/v2/Services/" + service + "/"
        self.authorization = base64.b64encode(f"{account}:{secret}".encode()).decode()

    @classmethod
    def from_environment(cls):
        service, account, secret = (os.environ.get("PRINTBEE_TWILIO_" + name, "") for name in
                                    ("VERIFY_SERVICE", "ACCOUNT", "TOKEN"))
        if not any((service, account, secret)):
            return None
        if not re.fullmatch(r"VA[0-9a-fA-F]{32}", service) or not re.fullmatch(r"AC[0-9a-fA-F]{32}", account) or not secret:
            raise SystemExit("Configure the Twilio Verify service, account and token.")
        return cls(service, account, secret)

    def request(self, path, fields):
        request = Request(self.url + path, data=urlencode(fields).encode(),
                          headers={"Authorization": "Basic " + self.authorization,
                                   "Content-Type": "application/x-www-form-urlencoded"})
        with urlopen(request, timeout=8) as response:
            return json.load(response)

    def send(self, phone):
        return self.request("Verifications", {"To": phone, "Channel": "sms"})["status"] == "pending"

    def approved(self, phone, code):
        try:
            return self.request("VerificationCheck", {"To": phone, "Code": code})["status"] == "approved"
        except HTTPError as error:
            if error.code in (400, 404):
                return False
            raise

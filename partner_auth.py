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

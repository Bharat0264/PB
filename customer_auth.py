"""Email sign-in for PrintBee customers."""
import base64
import hashlib
import json
import os
import re
import secrets
import smtplib
import ssl
import time
from email.message import EmailMessage
from http.cookies import CookieError, SimpleCookie
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

COOKIE = "printbee_session"
SESSION_AGE = 7 * 86400
LINK_AGE = 15 * 60

SCHEMA = """
CREATE TABLE IF NOT EXISTS login_links (
    digest TEXT PRIMARY KEY, email TEXT NOT NULL, created INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS login_links_email_time ON login_links(email, created);
CREATE TABLE IF NOT EXISTS customer_sessions (
    digest TEXT PRIMARY KEY, email TEXT NOT NULL, expires INTEGER NOT NULL
);
"""


def digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def session_token(headers, name=COOKIE):
    try:
        cookie = SimpleCookie(headers.get("Cookie", "")).get(name)
        if cookie and re.fullmatch(r"[A-Za-z0-9_-]{43}", cookie.value):
            return cookie.value
    except CookieError:
        pass
    return ""


def session_email(db, headers):
    row = db.execute("SELECT email FROM customer_sessions WHERE digest=? AND expires>?",
                     (digest(session_token(headers)), int(time.time()))).fetchone()
    return row["email"] if row else None


def public_origin():
    return os.environ.get("PRINTBEE_ORIGIN", "").rstrip("/")


def session_cookie(token, age, name=COOKIE):
    secure = "; Secure" if urlsplit(public_origin()).scheme == "https" else ""
    return f"{name}={token}; Path=/; Max-Age={age}; HttpOnly; SameSite=Lax{secure}"


def send_link(email, token):
    origin = public_origin()
    parsed = urlsplit(origin)
    host = os.environ["PRINTBEE_SMTP_HOST"]
    sender = os.environ["PRINTBEE_SMTP_FROM"]
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost")):
        raise ValueError("Configure PRINTBEE_ORIGIN with the site URL.")
    message = EmailMessage()
    message["From"] = sender
    message["To"] = email
    message["Subject"] = "Your PrintBee sign-in link"
    message.set_content(f"Sign in to PrintBee within 15 minutes:\n\n{origin}/profile.html#sign-in={token}\n\nIf you did not request this link, you can ignore this email.")
    with smtplib.SMTP(host, int(os.environ.get("PRINTBEE_SMTP_PORT", "587")), timeout=10) as smtp:
        smtp.starttls(context=ssl.create_default_context())
        if os.environ.get("PRINTBEE_SMTP_USER"):
            smtp.login(os.environ["PRINTBEE_SMTP_USER"], os.environ["PRINTBEE_SMTP_PASSWORD"])
        smtp.send_message(message)


def request_link(db, email, deliver=send_link):
    email = email.strip().lower()
    if len(email) > 254 or not re.fullmatch(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z0-9-]+", email):
        return 400, {"error": "Enter a valid email address."}
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    with db:
        db.execute("BEGIN IMMEDIATE")
        db.execute("DELETE FROM login_links WHERE created<=?", (now - LINK_AGE,))
        db.execute("DELETE FROM customer_sessions WHERE expires<=?", (now,))
        recent = db.execute("SELECT MAX(created), COUNT(*) FROM login_links WHERE email=?", (email,)).fetchone()
        count = db.execute("SELECT COUNT(*) FROM login_links").fetchone()[0]
        if recent[1] >= 5 or (recent[0] and recent[0] > now - 60) or count >= 50:
            return 429, {"error": "Too many sign-in requests. Please try again later."}
        db.execute("INSERT INTO login_links(digest,email,created) VALUES (?,?,?)", (digest(token), email, now))
    try:
        deliver(email, token)
    except (OSError, smtplib.SMTPException, ValueError, KeyError):
        return 503, {"error": "Email sign-in is temporarily unavailable. Please try again later."}
    return 200, {"sent": True}


def redeem(db, token, old_token):
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
        return None
    now = int(time.time())
    with db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT email FROM login_links WHERE digest=? AND used=0 AND created>?",
                         (digest(token), now - LINK_AGE)).fetchone()
        if not row:
            return None
        db.execute("UPDATE login_links SET used=1 WHERE digest=?", (digest(token),))
        return row["email"], create_session(db, row["email"], old_token)


def create_session(db, email, old_token):
    db.execute("DELETE FROM customer_sessions WHERE digest=?", (digest(old_token),))
    session = secrets.token_urlsafe(32)
    db.execute("INSERT INTO customer_sessions VALUES (?,?,?)",
               (digest(session), email, int(time.time()) + SESSION_AGE))
    return session_cookie(session, SESSION_AGE)


GOOGLE_COOKIE = "printbee_google_flow"
GOOGLE_CALLBACK = "/api/auth/google/callback"


def google_config():
    origin = public_origin()
    parsed = urlsplit(origin)
    if not (parsed.scheme == "https" and parsed.hostname or
            parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1")):
        return None
    client = os.environ.get("PRINTBEE_GOOGLE_CLIENT_ID")
    secret = os.environ.get("PRINTBEE_GOOGLE_CLIENT_SECRET")
    if client and secret:
        return {"client_id": client, "client_secret": secret, "redirect_uri": origin + GOOGLE_CALLBACK}
    return None


def google_authorization(config, verifier):
    challenge = base64.urlsafe_b64encode(bytes.fromhex(digest(verifier))).decode().rstrip("=")
    query = urlencode({
        "client_id": config["client_id"], "redirect_uri": config["redirect_uri"],
        "response_type": "code", "scope": "openid email",
        "state": digest("state:" + verifier),
        "code_challenge": challenge, "code_challenge_method": "S256",
    })
    return "https://accounts.google.com/o/oauth2/v2/auth?" + query


def google_email(config, code, verifier):
    body = urlencode({**config, "grant_type": "authorization_code", "code": code,
                      "code_verifier": verifier}).encode()
    with urlopen(Request("https://oauth2.googleapis.com/token", data=body), timeout=10) as response:
        access_token = json.load(response)["access_token"]
    request = Request("https://openidconnect.googleapis.com/v1/userinfo",
                      headers={"Authorization": "Bearer " + access_token})
    with urlopen(request, timeout=10) as response:
        user = json.load(response)
    email = user.get("email")
    if user.get("email_verified") is not True or not user.get("sub") or not isinstance(email, str) or not email:
        raise ValueError("Google account email is unavailable or unverified.")
    return email.lower()

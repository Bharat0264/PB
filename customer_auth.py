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
EXPIRED_FLAG = "printbee_expired"
# A customer stays signed in for SESSION_AGE after their LAST activity (a sliding window).
# Activity is renewed at most once per RENEW_AFTER seconds, so busy pages do not write on every request.
SESSION_AGE = int(os.environ.get("PRINTBEE_SESSION_DAYS", "7")) * 86400
RENEW_AFTER = 300
LINK_AGE = 15 * 60
# Sign-in link limits inside one LINK_AGE window. Per email and per visitor address, so one person cannot use up
# everybody's turns. The site-wide number is only an emergency brake, far above normal traffic.
PER_EMAIL, PER_IP, SITE_WIDE = 5, 10, 2000

SCHEMA = """
CREATE TABLE IF NOT EXISTS login_links (
    digest TEXT PRIMARY KEY, email TEXT NOT NULL, created INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0, ip TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS login_links_email_time ON login_links(email, created);
CREATE TABLE IF NOT EXISTS customer_sessions (
    digest TEXT PRIMARY KEY, email TEXT NOT NULL, expires INTEGER NOT NULL, last_active INTEGER
);
CREATE TABLE IF NOT EXISTS google_portal_sessions (
    digest TEXT PRIMARY KEY, email TEXT NOT NULL, expires INTEGER NOT NULL, portal TEXT
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


def slide_session(db, headers, now=None):
    """Slide the customer session window forward on activity.

    Returns (state, cookies). state is "none" (no session cookie), "active" or "expired". cookies is a list of
    Set-Cookie values: a fresh session cookie when the window was renewed, or, when the session has expired,
    one that clears it plus a short-lived "printbee_expired" flag so the sign-in page can say why.
    """
    token = session_token(headers)
    if not token:
        return "none", None
    now = int(now if now is not None else time.time())
    row = db.execute("SELECT email, expires, last_active FROM customer_sessions WHERE digest=?",
                     (digest(token),)).fetchone()
    last = row["last_active"] or (row["expires"] - SESSION_AGE) if row else 0
    if not row or row["expires"] <= now or now - last > SESSION_AGE:
        with db:
            db.execute("DELETE FROM customer_sessions WHERE digest=?", (digest(token),))
        return "expired", [session_cookie("", 0), expired_flag_cookie()]
    if now - last < RENEW_AFTER:
        return "active", []
    with db:
        db.execute("UPDATE customer_sessions SET expires=?, last_active=? WHERE digest=?",
                   (now + SESSION_AGE, now, digest(token)))
    return "active", [session_cookie(token, SESSION_AGE)]


def expired_flag_cookie():
    """Readable by the sign-in page (not HttpOnly) so it can show "Session expired". Holds no secret."""
    secure = "; Secure" if urlsplit(public_origin()).scheme == "https" else ""
    return f"{EXPIRED_FLAG}=1; Path=/; Max-Age=120; SameSite=Lax{secure}"


def end_all_sessions(db, email):
    """Log out of all devices: remove every customer session for this email."""
    with db:
        db.execute("DELETE FROM customer_sessions WHERE email=?", (email,))


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


def add_ip_column(db):
    """Older databases have no `ip` column on login_links yet."""
    if "ip" not in {column[1] for column in db.execute("PRAGMA table_info(login_links)")}:
        db.execute("ALTER TABLE login_links ADD COLUMN ip TEXT NOT NULL DEFAULT ''")


def request_link(db, email, ip="", deliver=send_link):
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
        from_ip = db.execute("SELECT COUNT(*) FROM login_links WHERE ip=?", (ip,)).fetchone()[0] if ip else 0
        if (recent[1] >= PER_EMAIL or (recent[0] and recent[0] > now - 60) or from_ip >= PER_IP or count >= SITE_WIDE):
            return 429, {"error": "Too many sign-in requests. Please try again later."}
        db.execute("INSERT INTO login_links(digest,email,created,ip) VALUES (?,?,?,?)", (digest(token), email, now, ip))
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
    now = int(time.time())
    db.execute("INSERT INTO customer_sessions (digest, email, expires, last_active) VALUES (?,?,?,?)",
               (digest(session), email, now + SESSION_AGE, now))
    return session_cookie(session, SESSION_AGE)


GOOGLE_COOKIE = "printbee_google_flow"
GOOGLE_CALLBACK = "/api/auth/google/callback"
GOOGLE_PORTAL_COOKIE = "printbee_google_portal"
GOOGLE_PORTALS = {"warehouse": "/warehouse", "partner": "/partner", "admin": "/admin"}


def portal_session(db, headers, email, portal):
    token = secrets.token_urlsafe(32)
    age = 43200
    now = int(time.time())
    db.execute("DELETE FROM google_portal_sessions WHERE expires<=? OR digest=?",
               (now, digest(session_token(headers, GOOGLE_PORTAL_COOKIE))))
    db.execute("INSERT INTO google_portal_sessions (digest, email, expires, portal) VALUES (?,?,?,?)",
               (digest(token), email, now + age, portal))
    return session_cookie(token, age, GOOGLE_PORTAL_COOKIE)


def portal_google_email(db, headers, portal):
    token = session_token(headers, GOOGLE_PORTAL_COOKIE)
    if not token:
        return None
    row = db.execute("SELECT email FROM google_portal_sessions WHERE digest=? AND expires>? AND portal=?",
                     (digest(token), int(time.time()), portal)).fetchone()
    return row["email"] if row else None


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


def google_state(verifier, portal=""):
    return digest("state:" + verifier + ("." + portal if portal else ""))


def google_authorization(config, verifier, portal=""):
    challenge = base64.urlsafe_b64encode(bytes.fromhex(digest(verifier))).decode().rstrip("=")
    query = urlencode({
        "client_id": config["client_id"], "redirect_uri": config["redirect_uri"],
        "response_type": "code", "scope": "openid email",
        "state": google_state(verifier, portal),
        **({"prompt": "select_account"} if portal else {}),
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

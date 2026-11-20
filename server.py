import argparse
import hashlib
import buzz
import support
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
from contextlib import closing
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit
from http.cookies import CookieError, SimpleCookie
import threading
from threading import BoundedSemaphore

import admin_ledger
import admin_records
import event_feed
import finance
import order_status
import customer_auth as auth
import fulfillment as ops
import partner_auth
import razorpay_checkout
from checkout_terms import DeliveryQuoteError, bill_for, configured_terms, coordinates, delivery_terms, require_pickup_coordinates, validate_terms
from document_pages import count_pages
from order_documents import PrivateFiles, invoice_pdf, packing_label_pdf
from order_rules import LIMIT, TRANSITIONS, advance_order, quote_items

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("PRINTBEE_DATA_DIR") or (Path(os.environ.get("LOCALAPPDATA", ROOT.parent)) / "PrintBeeLocal"))
DATA.mkdir(parents=True, exist_ok=True)
DOCUMENT_READERS = BoundedSemaphore(2)


def connect():
    db = sqlite3.connect(DATA / "orders.sqlite", timeout=30)
    db.row_factory = sqlite3.Row
    return db


def staff_keys():
    path = DATA / "staff-keys.json"
    keys = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    updated = {**keys, **{role: secrets.token_urlsafe(24) for role in
                          ("warehouse", "delivery", "admin", "delivery-code")
                          if role not in keys}}
    if updated != keys:
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(updated), encoding="utf-8")
        temporary.replace(path)
    return updated


def order_number(db):
    date = datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime("%y%m%d")
    while True:
        value = f"PB-{date}-{secrets.token_hex(2).upper()}"
        if not db.execute("SELECT 1 FROM order_owners WHERE order_number=?", (value,)).fetchone():
            return value


# Demo identities for local testing (PRINTBEE_DEMO=1, test payments, local origin only).
DEMO_USERS = {
    "customer": {"email": "customer@demo.printbee.test", "label": "Customer", "customer": True, "destination": "/index.html"},
    "warehouse": {"email": "warehouse@demo.printbee.test", "label": "Warehouse", "portal": "warehouse", "destination": "/warehouse"},
    "partner": {"email": "partner@demo.printbee.test", "label": "Delivery partner 1", "portal": "partner", "destination": "/partner"},
    "partner2": {"email": "partner2@demo.printbee.test", "label": "Delivery partner 2", "portal": "partner", "destination": "/partner"},
    "admin": {"email": "admin@demo.printbee.test", "label": "Admin", "portal": "admin", "destination": "/admin"},
    "all": {"email": "all@demo.printbee.test", "label": "All roles (try Switch portal)", "customer": True,
            "portal": "admin", "destination": "/admin"},
}
DEMO_PARTNERS = {"partner@demo.printbee.test": "demo-rider-1", "partner2@demo.printbee.test": "demo-rider-2",
                 "all@demo.printbee.test": "demo-rider-3"}


def eta_minutes(here, there, speed_kmh=18):
    """Rough minutes to go (straight line at campus-scooter speed). An estimate, never a promise."""
    import math
    lat1, lng1, lat2, lng2 = map(math.radians, (*here, *there))
    a = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    km = 6371 * 2 * math.asin(math.sqrt(min(1, a)))
    return max(1, math.ceil(km / speed_kmh * 60))


def active_checkout_terms(db, default):
    row = db.execute("SELECT terms FROM pricing_versions ORDER BY id DESC LIMIT 1").fetchone()
    if not row:
        return default
    saved = json.loads(row["terms"])
    # Pricing saved before Bond paper existed still offers it, at the default rates, until an admin sets them.
    saved["paperRates"] = {**saved.get("paperRates", {}), **{k: v for k, v in default.get("paperRates", {}).items()
                                                            if k == "A4 Bond" and k not in saved.get("paperRates", {})}}
    return {"surge": 0, "deliveryPerKm": 0, **saved, "campuses": default.get("campuses", [])}


def customer_print_specs(items):
    fields = ("name", "pages", "copies", "colour", "duplex", "orientation",
              "binding", "colourPages", "pageRange", "paper")
    return [{key: item[key] for key in fields if key in item} for item in items]


class PrintBee(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def json_response(self, status, value, cookie=None):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        if cookie:
            for value in ((cookie,) if isinstance(cookie, str) else cookie):
                self.send_header("Set-Cookie", value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    PORTAL_LABELS = {"customer": ("Customer app", "/index.html"), "warehouse": ("Warehouse", "/warehouse"),
                     "partner": ("Delivery partner", "/partner"), "admin": ("Admin", "/admin")}
    SESSION_COOKIES = (("customer_sessions", auth.COOKIE), ("google_portal_sessions", auth.GOOGLE_PORTAL_COOKIE),
                       ("partner_sessions", "printbee_partner"))

    def previews_allowed(self):
        """Sample-data screens (?preview=1, /admin-preview.html) exist for local development only,
        unless PRINTBEE_ALLOW_PREVIEW=1. They never read or write live orders either way."""
        origin = auth.public_origin()
        return (os.environ.get("PRINTBEE_ALLOW_PREVIEW") == "1" or not origin
                or urlsplit(origin).hostname in ("127.0.0.1", "localhost"))

    def dev_login(self, path):
        """Local demo sign-in: one click per role. Exists only when the server was started with PRINTBEE_DEMO=1."""
        if not self.server.demo:
            return self.send_error(404)
        if path == "/api/dev/roles":
            return self.json_response(200, {"roles": [{"role": key, "label": user["label"], "email": user["email"]}
                                                      for key, user in DEMO_USERS.items()]})
        user = DEMO_USERS.get(parse_qs(urlsplit(self.path).query).get("role", [""])[0])
        if not user:
            return self.json_response(400, {"error": "Unknown demo role."})
        cookies = []
        with closing(connect()) as db, db:
            if user.get("customer"):
                cookies.append(auth.create_session(db, user["email"], auth.session_token(self.headers)))
            if user.get("portal"):
                cookies.append(auth.portal_session(db, self.headers, user["email"], user["portal"]))
        return self.auth_redirect(user["destination"], *cookies)

    def clear_all_sessions(self, db):
        """One logout for everything: customer, staff-portal and partner sessions, plus their cookies."""
        cookies = []
        for table, name in self.SESSION_COOKIES:
            token = auth.session_token(self.headers, name)
            if token:
                db.execute(f"DELETE FROM {table} WHERE digest=?", (auth.digest(token),))
            cookies.append(auth.session_cookie("", 0, name))
        return cookies

    def identity_roles(self, db):
        """Everything the current browser is signed in as: the customer email, the portal roles any
        of its identities may use, and the identity that holds each role (for switching)."""
        customer = auth.session_email(db, self.headers)
        emails = {customer} if customer else set()
        token = auth.session_token(self.headers, auth.GOOGLE_PORTAL_COOKIE)
        current = None
        if token:
            row = db.execute("SELECT email, portal FROM google_portal_sessions WHERE digest=? AND expires>?",
                             (auth.digest(token), int(time.time()))).fetchone()
            if row:
                emails.add(row["email"])
                current = row["portal"]
        holders = {}
        for email in emails:
            role = self.staff_role(email)
            if role:
                holders.setdefault(role, email)
        partner_token = auth.session_token(self.headers, "printbee_partner")
        if partner_token and db.execute("SELECT 1 FROM partner_sessions WHERE digest=? AND expires>?",
                                        (auth.digest(partner_token), int(time.time()))).fetchone():
            holders.setdefault("partner", None)
            current = current or "partner"
        return customer, holders, current

    def get_role(self):
        key = self.headers.get("X-Staff-Key", "").encode()
        if key:
            return next((role for role, secret in self.server.keys.items()
                         if role != "delivery-code" and hmac.compare_digest(key, secret.encode())), None)
        path = urlsplit(self.path).path
        role = "admin" if path.startswith("/api/admin") else "warehouse" if path.startswith("/api/staff/") else None
        if role and self.google_portal_access(role):
            return role
        return None

    def staff_role(self, email):
        """An email holds exactly one role: admin first, then warehouse, then delivery partner."""
        return next((role for role in ("admin", "warehouse", "partner")
                     if email in self.server.google_access.get(role, {})), None)

    def google_portal_access(self, portal):
        with closing(connect()) as db:
            email = auth.portal_google_email(db, self.headers, portal)
        return self.server.google_access[portal].get(email) if self.staff_role(email) == portal else None

    def google_destination(self, mode):
        if mode == "welcome":
            return "/"
        return auth.GOOGLE_PORTALS.get(mode, "/profile.html")

    def same_origin(self):
        origin = auth.public_origin() or f"http://{self.headers.get('Host')}"
        return self.headers.get("Origin") == origin

    def get_partner(self):
        key = self.headers.get("X-Staff-Key", "").encode()
        partner = next((name for name, secret in self.server.partners.items()
                        if hmac.compare_digest(key, secret.encode())), None)
        if partner:
            return partner
        partner = self.google_portal_access("partner")
        if partner:
            return partner
        cookie = auth.session_token(self.headers, "printbee_partner")
        if cookie:
            with closing(connect()) as db:
                row = db.execute("SELECT partner FROM partner_sessions WHERE digest=? AND expires>?",
                                 (auth.digest(cookie), int(time.time()))).fetchone()
            if row and row["partner"] in self.server.partner_phones.values():
                return row["partner"]
        return None

    def checkout_terms(self, db=None):
        if db is None:
            with closing(connect()) as connection:
                return self.checkout_terms(connection)
        return active_checkout_terms(db, self.server.checkout_terms)

    def ready_printed_order(self, db, actor, order_id):
        eligible = ()
        if self.checkout_terms(db).get("autoDispatch"):
            eligible = (set(self.server.partners) | set(self.server.partner_phones.values()) |
                        set(self.server.google_access["partner"].values()))
        return ops.ready_printed_orders(db, actor, order_id, eligible)

    def log_request(self, code="-", size="-"):
        if urlsplit(self.path).path == auth.GOOGLE_CALLBACK:
            self.log_message("Google sign-in callback %s", code)
        else:
            super().log_request(code, size)

    def auth_redirect(self, location, *cookies):
        self.send_response(303)
        self.send_header("Location", location)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        for cookie in cookies:
            self.send_header("Set-Cookie", cookie)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def google_sign_in(self, path):
        config = auth.google_config()
        if path != auth.GOOGLE_CALLBACK:
            portal = parse_qs(urlsplit(self.path).query, max_num_fields=20).get("portal", [""])[0]
            if portal and portal != "welcome" and portal not in auth.GOOGLE_PORTALS:
                return self.send_error(400)
            if not config:
                return self.auth_redirect(self.google_destination(portal) + "#google-unavailable")
            verifier = secrets.token_urlsafe(32)
            return self.auth_redirect(auth.google_authorization(config, verifier, portal),
                                      auth.session_cookie(verifier + "." + portal if portal else verifier,
                                                          600, auth.GOOGLE_COOKIE))
        clear = auth.session_cookie("", 0, auth.GOOGLE_COOKIE)
        destination = "/profile.html"
        try:
            cookie = SimpleCookie(self.headers.get("Cookie", "")).get(auth.GOOGLE_COOKIE)
            query = parse_qs(urlsplit(self.path).query, max_num_fields=20)
            verifier, _, portal = (cookie.value if cookie else "").partition(".")
            destination = self.google_destination(portal)
            if (not config or (portal and portal != "welcome" and portal not in auth.GOOGLE_PORTALS)
                    or not re.fullmatch(r"[A-Za-z0-9_-]{43}", verifier)
                    or not hmac.compare_digest(query.get("state", [""])[0].encode(),
                                               auth.google_state(verifier, portal).encode())):
                raise ValueError("Invalid Google sign-in state")
            email = auth.google_email(config, query["code"][0], verifier)
            from_welcome = portal == "welcome"
            if from_welcome:
                portal = next((role for role in ("admin", "warehouse", "partner")
                               if email in self.server.google_access[role]), "")
            cleared_sessions = []
            with closing(connect()) as db, db:
                if portal:
                    if self.staff_role(email) != portal:
                        return self.auth_redirect(destination + "#google-denied", clear)
                    session = auth.portal_session(db, self.headers, email, portal)
                    destination = auth.GOOGLE_PORTALS[portal]
                elif self.staff_role(email):
                    return self.auth_redirect(destination + "#google-denied", clear)
                else:
                    session = auth.create_session(db, email, auth.session_token(self.headers))
                    destination = "/index.html"
                if from_welcome:
                    # A new identity on the welcome page replaces the other login context.
                    for table, name in (
                        ("partner_sessions", "printbee_partner"),
                        ("customer_sessions", auth.COOKIE) if portal
                        else ("google_portal_sessions", auth.GOOGLE_PORTAL_COOKIE),
                    ):
                        token = auth.session_token(self.headers, name)
                        if token:
                            db.execute(f"DELETE FROM {table} WHERE digest=?", (auth.digest(token),))
                            cleared_sessions.append(auth.session_cookie("", 0, name))
        except (CookieError, OSError, ValueError, KeyError, TypeError):
            return self.auth_redirect(destination + "#google-failed", clear)
        return self.auth_redirect(destination, clear, *cleared_sessions, session)

    session_state = "none"
    renewed_cookies = ()
    cookie_sent = False

    def parse_request(self):
        """Every API call counts as activity: it slides the customer's 7-day session window forward."""
        self.session_state, self.renewed_cookies, self.cookie_sent = "none", (), False
        if not super().parse_request():
            return False
        path = urlsplit(self.path).path
        if not path.startswith("/api/dev/") and auth.session_token(self.headers):
            # Staff emails never keep a customer session: an older one ends here.
            try:
                with closing(connect()) as db, db:
                    email = auth.session_email(db, self.headers)
                    if email and self.staff_role(email):
                        db.execute("DELETE FROM customer_sessions WHERE digest=?", (auth.digest(auth.session_token(self.headers)),))
            except sqlite3.Error:
                pass
        if path.startswith("/api/") and not path.startswith("/api/dev/") and path != "/api/auth/logout":
            try:
                with closing(connect()) as db:
                    self.session_state, self.renewed_cookies = auth.slide_session(db, self.headers)
            except sqlite3.Error:
                pass
        return True

    def send_header(self, keyword, value):
        if keyword.lower() == "set-cookie" and str(value).startswith(auth.COOKIE + "="):
            self.cookie_sent = True
        super().send_header(keyword, value)

    def end_headers(self):
        if self.renewed_cookies and not self.cookie_sent:
            self.cookie_sent = True
            for value in self.renewed_cookies:
                super().send_header("Set-Cookie", value)
        # Revalidate page markup so all pages use the current navigation.
        path = urlsplit(self.path).path
        if path == "/" or path.endswith(".html"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        path = urlsplit(self.path).path
        origin = auth.public_origin()
        if origin and urlsplit(origin).hostname in ("127.0.0.1", "localhost") and (
            path == "/" or path.endswith(".html") or path in ("/warehouse", "/partner", "/admin")
        ) and self.headers.get("Host", "") != urlsplit(origin).netloc:
            # localhost and 127.0.0.1 are different origins: cookies and sign-in only work on the configured one.
            return self.auth_redirect(origin + self.path)
        preview = parse_qs(urlsplit(self.path).query).get("preview", [""])[0] == "1"
        if not self.previews_allowed() and (path == "/admin-preview.html" or (preview and path in (
            "/warehouse", "/partner", "/admin", "/admin.html", "/staff.html", "/partner.html"
        ))):
            return self.auth_redirect({"/admin-preview.html": "/admin", "/admin.html": "/admin",
                                       "/staff.html": "/warehouse", "/partner.html": "/partner"}.get(path, path))
        if path in ("/api/dev/roles", "/api/dev/login"):
            return self.dev_login(path)
        if path == "/api/auth/me":
            with closing(connect()) as db:
                customer, holders, current = self.identity_roles(db)
            portals = [{"role": role, "label": self.PORTAL_LABELS[role][0], "path": self.PORTAL_LABELS[role][1]}
                       for role in (["customer"] if customer else []) + [r for r in ("admin", "warehouse", "partner") if r in holders]]
            return self.json_response(200, {"customer": customer, "roles": sorted(holders), "portals": portals,
                                           "current": current})
        if path == "/":
            self.path = "/welcome.html"
            return super().do_GET()
        if path.rstrip("/") in ("/home", "/upload", "/address"):
            self.path = "/navigation.html"
            return super().do_GET()
        if path.rstrip("/") in ("/orders", "/cart", "/profile", "/help", "/themes"):
            self.path = path.rstrip("/") + ".html"
            return super().do_GET()
        if re.fullmatch(r"/orders/[^/]+/?", path):
            self.path = "/orders.html"
            return super().do_GET()
        if path in ("/warehouse", "/partner"):
            self.path = "/staff.html" if path == "/warehouse" else "/partner.html"
            return super().do_GET()
        if path == "/admin":
            self.path = "/admin.html"
            return super().do_GET()
        if path in ("/api/auth/google", auth.GOOGLE_CALLBACK):
            return self.google_sign_in(path)
        if path == "/api/auth/session":
            with closing(connect()) as db:
                return self.json_response(200, {"email": auth.session_email(db, self.headers),
                                               "expired": self.session_state == "expired"})
        if path == "/api/auth/portal":
            portal = parse_qs(urlsplit(self.path).query).get("portal", [""])[0]
            if portal not in auth.GOOGLE_PORTALS:
                return self.send_error(400)
            signed_in = self.google_portal_access(portal) or (portal == "partner" and self.get_partner())
            return self.json_response(200, {"signedIn": bool(signed_in)})
        if path == "/api/staff/availability":
            if self.get_role() not in ("warehouse", "admin"):
                return self.json_response(403, {"error": "Warehouse access is required."})
            with closing(connect()) as db:
                return self.json_response(200, admin_records.warehouse_availability(db))
        if path == "/api/orders/notifications":
            return self.customer_notifications()
        if path == "/api/checkout":
            with closing(connect()) as db:
                db.execute("BEGIN")
                terms = {key: value for key, value in self.checkout_terms(db).items() if key != "coupons"}
                version = db.execute("SELECT COALESCE(max(id),0) FROM pricing_versions").fetchone()[0]
                service = admin_records.warehouse_availability(db)
            return self.json_response(200, {"serviceOpen": service["open"], "mode": self.server.payment_mode, "terms": terms,
                                           "maps": self.server.maps, "pricingVersion": version})
        if not path.startswith("/api/"):
            allowed = {"/welcome.html", "/welcome.css", "/index.html", "/studio.js", "/studio.css", "/clay.css", "/staff.html", "/staff.js", "/warehouse.css", "/warehouse.js", "/delivery-map.js",
                       "/footer-wave.css", "/footer-wave.js",
                       "/hive-theme.css", "/hive-theme.js", "/customer-theme.css", "/theme-registry.js", "/theme-engine.js", "/theme-engine.css", "/theme-adapter.css", "/themes.html", "/themes.js", "/themes.css", "/admin-hive.css", "/admin-mobile.css", "/warehouse-hive.css", "/staff-dock.css", "/staff-dock.js",
                       "/partner.html", "/partner.css", "/partner.js", "/partner-sw.js", "/admin.html", "/admin-preview.html", "/admin-dashboard.css", "/admin-tokens.css",
                       "/customer-pricing.js", "/customer-price-table.js", "/pricing-preview.js", "/admin-dashboard.js", "/admin-records.js", "/admin-ledger.js", "/admin-ledger.css", "/admin-pricing.js", "/admin-pricing.css", "/admin-data.js", "/admin-live-data.js", "/partner.webmanifest", "/portal-login.js", "/portal-loader.js",
                       "/pricing.html", "/terms.html", "/queue.html", "/cart.html", "/orders.html", "/profile.html", "/profile.js", "/address.html", "/address-book.js", "/address-book.css", "/customer-login.js", "/account-home.js", "/session-sync.js",
                       "/preloader.js", "/preloader.css", "/gsap-3.13.0.min.js", "/live.js", "/status-model.js", "/status-model.css", "/portal-switch.js", "/demo-login.js", "/backend-check.js",
                       "/navigation.html", "/navigation.css", "/bottom-nav.js", "/nav-tokens.js", "/embedded-tab.js",
                       "/order-tracking.js", "/order-tracking.css", "/help.html", "/help.js", "/help.css", "/admin-support.js", "/admin-support.css", "/support-bell.js", "/buzz-chat.js", "/buzz-bee3d.js", "/buzz-bee.glb", "/bee_hq.glb",
                       "/vendor/three/three.module.js", "/vendor/three/three.core.js", "/vendor/three/GLTFLoader.js", "/vendor/three/BufferGeometryUtils.js",
                       "/vendor/three/SkeletonUtils.js", "/vendor/three/RoomEnvironment.js", "/vendor/three/LICENSE"}
            if path in allowed:
                return super().do_GET()
            if re.fullmatch(r"/themes/[a-z0-9-]+\.(css|js|woff2)", path):
                return super().do_GET()
            if re.fullmatch(r"/[a-z0-9.-]+\.(png|webp|woff2)", path):
                return super().do_GET()
            return self.send_error(404)
        if path == "/api/status-model":
            return self.json_response(200, order_status.public_model())
        if path == "/api/events":
            return self.event_stream()
        match = re.fullmatch(r"/api/orders/([a-f0-9]{32})/events", path)
        if match:
            return self.order_events(match[1])
        with closing(connect()) as db:
            if path == "/api/admin":
                return self.admin_snapshot(db)
            if path == "/api/admin/ledger":
                return self.admin_ledger(db)
            if path == "/api/partner/orders":
                return self.partner_orders(db)
            if path == "/api/partner/auth":
                return self.json_response(200, {"sms": bool(self.server.partner_verify),
                                                "signedIn": bool(self.get_partner())})
            label = re.fullmatch(r"/api/staff/orders/([a-f0-9]{32})/label", path)
            if label and self.get_role() in ("warehouse", "admin"):
                row = db.execute(
                    "SELECT details, order_number FROM orders LEFT JOIN order_owners "
                    "ON orders.id=order_owners.order_id WHERE orders.id=? AND status='packed'", label.groups()
                ).fetchone()
                if row:
                    number = row["order_number"] or "PB-" + label[1][:8].upper()
                    body = packing_label_pdf(number, json.loads(row["details"]))
                    return self.send_download(body, "application/pdf", f'attachment; filename="{number}-packing.pdf"')
            if path == "/api/orders":
                email = auth.session_email(db, self.headers)
                if not email:
                    return self.json_response(401, {"error": "Sign in to see your orders."})
                rows = db.execute(
                    "SELECT orders.id, status, details, order_number, "
                    "(SELECT min(created) FROM audit WHERE audit.order_id=orders.id AND action='paid') AS paid_at FROM order_owners JOIN orders "
                    "ON orders.id=order_owners.order_id WHERE email=? AND status!='pending' "
                    "ORDER BY orders.rowid DESC", (email,)
                )
                orders = []
                for row in rows:
                    details = json.loads(row["details"])
                    order = {"id": row["id"], "number": row["order_number"], "status": row["status"],
                             "paidAt": row["paid_at"], "total": details.get("bill", {}).get("total"),
                             "items": customer_print_specs(details["items"])}
                    if row["status"] == "out_for_delivery":
                        delivery = self.customer_delivery(db, row["id"], row["status"]) or {}
                        if "etaMinutes" in delivery:
                            order["delivery"] = {"etaMinutes": delivery["etaMinutes"]}
                    orders.append(order)
                return self.json_response(200, {"orders": orders})
            if path.startswith(("/api/support/", "/api/admin/support/", "/api/staff/support/")) or re.fullmatch(r"/api/admin/orders/[a-f0-9]{32}/invoice", path):
                return self.support_api(path)
            if path == "/api/staff/orders":
                role = self.get_role()
                if role not in ("warehouse", "admin"):
                    return self.json_response(403, {"error": "Warehouse access is required."})
                rows = db.execute(
                    "SELECT orders.id, status, details, order_number, deliveries.partner, "
                    "(SELECT min(created) FROM audit WHERE audit.order_id=orders.id AND action='paid') AS paid_at "
                    "FROM orders LEFT JOIN order_owners ON orders.id=order_owners.order_id "
                    "LEFT JOIN deliveries ON orders.id=deliveries.order_id "
                    "WHERE status IN ('paid','printing','packed','out_for_delivery') OR orders.id IN "
                    "(SELECT id FROM orders WHERE status='delivered' ORDER BY rowid DESC LIMIT 100) "
                    "ORDER BY orders.rowid DESC"
                ).fetchall()
                jobs = {}
                timeline = {}
                order_ids = [row["id"] for row in rows]
                for offset in range(0, len(order_ids), 500):
                    batch = order_ids[offset:offset + 500]
                    placeholders = ",".join("?" for _ in batch)
                    for job in db.execute(
                        f"SELECT id, order_id, position, state, error FROM print_jobs WHERE order_id IN ({placeholders})", batch
                    ):
                        jobs.setdefault(job["order_id"], []).append(dict(job))
                    for event in db.execute(
                        f"SELECT action, created, order_id FROM audit WHERE order_id IN ({placeholders}) ORDER BY id", batch
                    ):
                        timeline.setdefault(event["order_id"], []).append(dict(event))
                return self.json_response(200, {"role": role,
                                               "availability": admin_records.warehouse_availability(db),
                                               "orders": [
                    {"id": row["id"], "number": row["order_number"], "status": row["status"],
                     "jobs": jobs.get(row["id"], []), "paidAt": row["paid_at"],
                     "partner": row["partner"], "timeline": timeline.get(row["id"], []),
                     **json.loads(row["details"])} for row in rows
                ]})
            match = re.fullmatch(r"/api/orders/([a-f0-9]{32})", path)
            if match:
                row = db.execute(
                    "SELECT status, token, email, provider_id, order_number, details, "
                    "(SELECT min(created) FROM audit WHERE audit.order_id=orders.id AND action='paid') AS paid_at FROM orders LEFT JOIN order_owners "
                    "ON orders.id=order_owners.order_id LEFT JOIN razorpay_orders "
                    "ON orders.id=razorpay_orders.order_id WHERE orders.id=?", match.groups()
                ).fetchone()
                token = self.headers.get("X-Order-Key", "")
                share = self.headers.get("X-Tracking-Key", "")
                owner = row and row["email"] and row["email"] == auth.session_email(db, self.headers)
                shared = row and row["status"] != "pending" and hmac.compare_digest(
                    self.tracking_key(match[1]).encode(), share.encode()
                )
                if shared:
                    return self.json_response(200, {"status": row["status"], "number": row["order_number"],
                                                    "paymentStarted": bool(row["provider_id"])})
                if row and not share and (
                    hmac.compare_digest(row["token"].encode(), token.encode())
                    or (row["status"] != "pending" and owner)
                ):
                    result = {"status": row["status"], "number": row["order_number"],
                              "paymentStarted": bool(row["provider_id"])}
                    if owner:
                        details = json.loads(row["details"])
                        result["summary"] = {key: details[key] for key in ("address", "deliveryType", "bill") if key in details}
                        result["summary"]["items"] = customer_print_specs(details["items"])
                        result["summary"]["paidAt"] = row["paid_at"]
                        result["timeline"] = event_feed.timeline(db, match[1])
                        result["delivery"] = self.customer_delivery(db, match[1], row["status"])
                        if row["status"] != "pending":
                            result["trackingKey"] = self.tracking_key(match[1])
                    return self.json_response(200, result)
            match = re.fullmatch(r"/api/staff/files/([a-f0-9]{32})/(\d+)", path)
            if match and self.get_role() in ("warehouse", "admin"):
                row = db.execute("SELECT content, object_key FROM files JOIN orders ON orders.id=files.order_id "
                                 "WHERE order_id=? AND position=? AND status IN ('paid','printing','packed')",
                                 match.groups()).fetchone()
                if row:
                    return self.send_file(row)
            match = re.fullmatch(r"/api/orders/([a-f0-9]{32})/(invoice|files/(\d+))", path)
            if match:
                return self.order_download(db, match[1], match[3])
        self.json_response(404, {"error": "Order or file unavailable."})

    def do_HEAD(self):
        self.send_error(405, "Use GET.")

    def tracking_key(self, order_id):
        secret = self.server.keys["delivery-code"].encode()
        return hmac.digest(secret, ("tracking:" + order_id).encode(), "sha256").hex()

    def customer_notifications(self, mark_read=False):
        if mark_read:
            origin = auth.public_origin() or f"http://{self.headers.get('Host')}"
            if self.headers.get("Origin") != origin:
                return self.json_response(403, {"error": "Open PrintBee directly and try again."})
        with closing(connect()) as db, db:
            email = auth.session_email(db, self.headers)
            if not email:
                return self.json_response(401, {"error": "Sign in to see order updates."})
            if mark_read:
                through = int(self.headers.get("X-Notification-Cursor", "0"))
                if through < 0 or through > 2**63 - 1:
                    raise ValueError()
                db.execute("INSERT INTO notification_reads VALUES (?,?) ON CONFLICT(email) DO UPDATE "
                           "SET last_seen=max(last_seen, excluded.last_seen)", (email, through))
                return self.json_response(200, {"saved": True})
            # Notifications are the order's real status changes (plus "partner assigned"), so a
            # step can never be skipped just because its audit action had a different name.
            rows = db.execute(
                "SELECT e.id, CASE WHEN e.event='delivery_accepted' THEN 'delivery_accepted' ELSE CASE e.to_status "
                "WHEN 'paid' THEN 'paid' WHEN 'printing' THEN 'printing' WHEN 'packed' THEN 'packed' "
                "WHEN 'out_for_delivery' THEN 'delivery_picked_up' WHEN 'delivered' THEN 'delivery_completed' "
                "WHEN 'undeliverable' THEN 'delivery_undeliverable' WHEN 'cancelled' THEN 'order_cancelled' "
                "WHEN 'refund_pending' THEN 'refund_requested' WHEN 'refunded' THEN 'refund.processed' "
                "WHEN 'refund_failed' THEN 'refund.failed' END END AS action, e.order_id, e.created, "
                "o.order_number, e.id>COALESCE(r.last_seen,0) AS unread "
                "FROM order_events e JOIN order_owners o ON o.order_id=e.order_id "
                "LEFT JOIN notification_reads r ON r.email=o.email WHERE o.email=? AND "
                "(e.event='delivery_accepted' OR (e.to_status IS NOT e.from_status AND e.to_status!='pending')) "
                "ORDER BY e.id DESC LIMIT 30", (email,)
            )
            return self.json_response(200, {"updates": [dict(row) for row in rows]})

    def event_audience(self, wanted):
        """(audience, identity) for the signed-in role the client asked to follow, else None."""
        if wanted in ("admin", "warehouse"):
            key = self.headers.get("X-Staff-Key", "").encode()
            if key:
                role = next((name for name, secret in self.server.keys.items()
                             if name != "delivery-code" and hmac.compare_digest(key, secret.encode())), None)
                return (wanted, role) if role == wanted or (role == "admin" and wanted == "warehouse") else None
            email = None
            with closing(connect()) as db:
                email = auth.portal_google_email(db, self.headers, wanted)
            return (wanted, email) if email and self.server.google_access[wanted].get(email) and self.staff_role(email) == wanted else None
        if wanted == "partner":
            partner = self.get_partner()
            return ("partner", partner) if partner else None
        if wanted == "customer":
            with closing(connect()) as db:
                email = auth.session_email(db, self.headers)
            return ("customer", email) if email else None
        return None

    def event_stream(self):
        """GET /api/events?as=<role>[&since=<id>]: the live feed.

        Server-Sent Events by default (EventSource reconnects with Last-Event-ID, which is the
        catch-up cursor). With `&poll=1` the same events come back as JSON for the polling fallback.
        """
        query = parse_qs(urlsplit(self.path).query)
        audience = self.event_audience(query.get("as", [""])[0])
        if not audience:
            return self.json_response(403, {"error": "Sign in to follow live updates."})
        kind, identity = audience
        try:
            cursor = self.headers.get("Last-Event-ID") or query.get("since", [None])[0]
            last = int(cursor) if cursor not in (None, "") else None
        except ValueError:
            return self.json_response(400, {"error": "Invalid event cursor."})
        db = connect()
        try:
            newest = event_feed.latest(db)
            if last is None or last > newest:
                last = newest          # first connect: no replay (clients load current state themselves)
            if "poll" in query:
                events = event_feed.fetch(db, kind, identity, last)
                return self.json_response(200, {"events": events, "latest": events[-1]["id"] if events else last})
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            self.wfile.write(b"retry: 3000\n\nevent: hello\ndata: " + json.dumps({"latest": last}).encode() + b"\n\n")
            self.wfile.flush()
            quiet = time.time()
            deadline = time.time() + 300      # clients reconnect and catch up from Last-Event-ID
            while time.time() < deadline:
                events = event_feed.fetch(db, kind, identity, last)
                for event in events:
                    self.wfile.write(f"id: {event['id']}\ndata: {json.dumps(event)}\n\n".encode())
                    last = event["id"]
                if events:
                    quiet = time.time()
                elif time.time() - quiet > 15:
                    self.wfile.write(b": keep-alive\n\n")
                    quiet = time.time()
                self.wfile.flush()
                time.sleep(1)
        except (OSError, ConnectionError):
            pass
        finally:
            db.close()

    def order_events(self, order_id):
        def snapshot(db):
            row = db.execute(
                "SELECT status, email FROM orders JOIN order_owners ON orders.id=order_owners.order_id "
                "WHERE orders.id=? AND status!='pending'", (order_id,)
            ).fetchone()
            if not row or row["email"] != auth.session_email(db, self.headers):
                return None
            return {"status": row["status"], "delivery": self.customer_delivery(db, order_id, row["status"])}

        with closing(connect()) as db:
            current = snapshot(db)
        if current is None:
            return self.json_response(404, {"error": "Order unavailable."})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        previous = None
        try:
            for _ in range(12):
                if current is None:
                    break
                if current != previous:
                    self.wfile.write(b"data: " + json.dumps(current).encode() + b"\n\n")
                    self.wfile.flush()
                    previous = current
                else:
                    self.wfile.write(b": keep-alive\n\n")
                    self.wfile.flush()
                time.sleep(2)
                with closing(connect()) as db:
                    current = snapshot(db)
        except (OSError, ConnectionError):
            pass

    def send_download(self, body, content_type, disposition="attachment"):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Disposition", disposition)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, row, signed=False):
        if row["object_key"]:
            storage = self.server.files
            if not storage:
                return self.json_response(503, {"error": "File storage is unavailable."})
            try:
                if signed:
                    return self.auth_redirect(storage.signed_download(row["object_key"]))
                body = storage.read(row["object_key"])
            except storage.errors:
                return self.json_response(502, {"error": "Could not retrieve the file. Please retry."})
        else:
            body = row["content"]
        return self.send_download(body, "application/octet-stream")

    def order_download(self, db, order_id, position):
        row = db.execute(
            "SELECT details, order_number, provider_id FROM order_owners JOIN orders "
            "ON orders.id=order_owners.order_id LEFT JOIN razorpay_orders "
            "ON orders.id=razorpay_orders.order_id WHERE orders.id=? AND email=? AND status!='pending'",
            (order_id, auth.session_email(db, self.headers)),
        ).fetchone()
        if row and position is None:
            number = row["order_number"] or "PB-" + order_id[:8].upper()
            body = invoice_pdf(number, json.loads(row["details"]), "razorpay" if row["provider_id"] else "test")
            return self.send_download(body, "application/pdf", f'attachment; filename="{number}.pdf"')
        if row:
            file = db.execute("SELECT content, object_key FROM files WHERE order_id=? AND position=?",
                              (order_id, int(position))).fetchone()
            if file:
                return self.send_file(file, signed=urlsplit(self.path).query == "download=1")
        self.json_response(404, {"error": "Order or file unavailable."})

    def do_POST(self):
        path = urlsplit(self.path).path
        try:
            if path == "/api/auth/portal/logout":
                if not self.same_origin():
                    return self.json_response(403, {"error": "Open PrintBee directly and try again."})
                with closing(connect()) as db, db:
                    cookies = self.clear_all_sessions(db)
                return self.json_response(200, {"saved": True}, cookies)
            if path == "/api/auth/switch":
                if not self.same_origin():
                    return self.json_response(403, {"error": "Open PrintBee directly and try again."})
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 1024:
                    raise ValueError()
                target = json.loads(self.rfile.read(length))["portal"]
                if target not in self.PORTAL_LABELS:
                    raise ValueError()
                with closing(connect()) as db, db:
                    customer, holders, _ = self.identity_roles(db)
                    destination = self.PORTAL_LABELS[target][1]
                    if target == "customer" and customer:
                        return self.json_response(200, {"path": destination})
                    if target not in holders:
                        return self.json_response(403, {"error": "This account cannot open that portal."})
                    if holders[target] is None:        # partner signed in by phone: its own cookie already works
                        return self.json_response(200, {"path": destination})
                    cookie = auth.portal_session(db, self.headers, holders[target], target)
                return self.json_response(200, {"path": destination}, cookie)
            if path.startswith(("/api/staff/", "/api/admin/")) and not self.headers.get("X-Staff-Key"):
                if not self.same_origin():
                    return self.json_response(403, {"error": "Open PrintBee directly and try again."})
            if path == "/api/staff/availability":
                role = self.get_role()
                if role not in ("warehouse", "admin"):
                    return self.json_response(403, {"error": "Warehouse access is required."})
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 1024:
                    raise ValueError()
                data = json.loads(self.rfile.read(length))
                with closing(connect()) as db, db:
                    db.execute("BEGIN IMMEDIATE")
                    actor = (auth.portal_google_email(db, self.headers, role) or role)
                    result = admin_records.set_warehouse_availability(db, data, actor)
                return self.json_response(200, result)
            if path == "/api/orders/notifications/read":
                return self.customer_notifications(mark_read=True)
            if path in ("/api/partner/auth/send", "/api/partner/auth/check", "/api/partner/auth/logout"):
                return self.verify_partner_phone(path.rsplit("/", 1)[1])
            if path in ("/api/support/chat", "/api/support/chat/feedback"):
                return self.chat_api(path)
            if path.startswith(("/api/support/", "/api/admin/support/")):
                return self.support_api(path)
            if path.startswith(("/api/partner/", "/api/admin/")):
                return self.operations_post(path)
            if path.startswith("/api/staff/support/"):
                return self.support_api(path)
            match = re.fullmatch(r"/api/staff/orders/([a-f0-9]{32})/printed/(\d+)", path)
            if match:
                return self.confirm_manual_print(*match.groups())
            if path.startswith("/api/auth/"):
                return self.customer_auth(path)
            if path == "/api/webhooks/razorpay":
                return self.razorpay_webhook()
            if path == "/api/checkout/quote":
                return self.checkout_quote()
            if path == "/api/checkout/pages":
                return self.inspect_document()
            if path == "/api/orders":
                with closing(connect()) as db:
                    email = auth.session_email(db, self.headers)
                if not email:
                    self.close_connection = True
                    return self.json_response(401, {"error": "Sign in by email from your Profile before placing an order."})
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 65536:
                    raise ValueError("Invalid order details.")
                return self.create_order(json.loads(self.rfile.read(length)), email)
            match = re.fullmatch(r"/api/orders/([a-f0-9]{32})/files/(\d+)", path)
            if match:
                return self.upload(*match.groups())
            match = re.fullmatch(r"/api/orders/([a-f0-9]{32})/test-payment", path)
            if match:
                return self.start_payment(match[1], test_only=True)
            match = re.fullmatch(r"/api/orders/([a-f0-9]{32})/payment", path)
            if match:
                return self.start_payment(match[1])
            match = re.fullmatch(r"/api/staff/orders/([a-f0-9]{32})/advance", path)
            if match:
                return self.advance(match[1])
            self.json_response(404, {"error": "Unknown request."})
        except ops.Conflict as error:
            self.json_response(409, {"error": str(error)})
        except sqlite3.IntegrityError as error:
            if "Illegal order status change" not in str(error):
                raise
            self.json_response(409, {"error": "This order cannot move to that status."})
        except (admin_records.InputError, DeliveryQuoteError) as error:
            self.json_response(400, {"error": str(error)})
        except (ValueError, KeyError, TypeError, AttributeError):
            self.json_response(400, {"error": "Check the order details and try again."})

    def customer_auth(self, path):
        origin = self.headers.get("Origin")
        expected = auth.public_origin() or f"http://{self.headers.get('Host')}"
        if origin != expected or self.headers.get_content_type() != "application/json":
            return self.json_response(403, {"error": "Open PrintBee directly and try again."})
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 4096:
            return self.json_response(400, {"error": "Invalid sign-in request."})
        data = json.loads(self.rfile.read(length))
        with closing(connect()) as db:
            if path == "/api/auth/request":
                if isinstance(data, dict) and self.staff_role(str(data.get("email", "")).strip().lower()):
                    return self.json_response(403, {"error": "This email is a staff account. Use its portal to sign in."})
                return self.json_response(*auth.request_link(db, data["email"]))
            if path == "/api/auth/verify":
                result = auth.redeem(db, data["token"], auth.session_token(self.headers))
                if result:
                    email, cookie = result
                    return self.json_response(200, {"email": email}, cookie)
                return self.json_response(400, {"error": "This link has expired or was already used. Request a new one."})
            if path == "/api/auth/logout":
                with db:
                    cookies = self.clear_all_sessions(db)
                return self.json_response(200, {"email": None}, cookies)
            if path == "/api/auth/logout-all":
                email = auth.session_email(db, self.headers)
                if email:
                    auth.end_all_sessions(db, email)
                with db:
                    cookies = self.clear_all_sessions(db)
                return self.json_response(200, {"email": None}, cookies)
        return self.json_response(404, {"error": "Unknown sign-in request."})

    def create_order(self, data, email):
        order_id = data["id"]
        token = self.headers.get("X-Order-Key", "")
        if not re.fullmatch(r"[a-f0-9]{32}", order_id) or not re.fullmatch(r"[a-f0-9]{64}", token):
            raise ValueError()
        details = {key: data[key].strip() for key in ("customer", "phone", "address")}
        if (not details["customer"] or len(details["customer"]) > 100 or
                not re.fullmatch(r"[+0-9 ()-]{7,20}", details["phone"]) or
                len(re.sub(r"\D", "", details["phone"])) < 7 or
                not details["address"] or len(details["address"]) > 500):
            raise ValueError()
        if data.get("deliveryType") == "campus":
            campus_id = data.get("campusId")
            if not isinstance(campus_id, str) or not re.fullmatch(r"[a-z0-9-]{1,40}", campus_id):
                raise ValueError("Choose a valid campus.")
            details.update(deliveryType="campus", campusId=campus_id)
        elif data.get("deliveryType", "standard") != "standard":
            raise ValueError("Choose a valid delivery type.")
        coupon = data.get("coupon", "").strip().upper()
        notes = data.get("notes", "").strip()
        slot = data.get("slot", "")
        if len(notes) > 500 or not isinstance(slot, str) or len(coupon) > 30:
            raise ValueError()
        if notes:
            details["notes"] = notes
        if slot:
            details["slot"] = slot
        if coupon:
            details["coupon"] = coupon
        with closing(connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute(
                "SELECT token, details, email FROM orders LEFT JOIN order_owners "
                "ON orders.id=order_owners.order_id WHERE orders.id=?", (order_id,)
            ).fetchone()
            if existing and (
                not hmac.compare_digest(token, existing["token"])
                or existing["email"] not in (None, email)
            ):
                return self.json_response(409, {"error": "Order details changed. Reopen checkout to try again."})
            if existing:
                stored = json.loads(existing["details"])
                bill = stored.pop("bill", None)
                total = stored.pop("subtotal")
                previous = stored.pop("items")
                # Verify the same print choices even if settings have changed since this attempt.
                selection, _ = quote_items(data["items"],
                    {item.get("paper", "A4"): (0, 0, 0, 0) for item in previous},
                    {item.get("binding", "none"): 0 for item in previous})
                def options(items):
                    return [{key: value for key, value in item.items() if key != "subtotal"} for item in items]
                stored.pop("partnerPayout", None)
                stored.pop("pickupWarehouse", None)
                if stored != details or options(previous) != options(selection):
                    return self.json_response(409, {"error": "Order details changed. Reopen checkout to try again."})
            else:
                if not admin_records.warehouse_availability(db)["open"]:
                    return self.json_response(409, {"error": "Printing is currently closed. Please try again when the warehouse reopens.", "serviceClosed": True})
                terms = delivery_terms(self.checkout_terms(db), data, details["address"])
                documents, total = quote_items(data["items"], terms["paperRates"], terms["bindingRates"])
                details.update(items=documents, subtotal=total)
                if (terms["slots"] or slot) and slot not in terms["slots"]:
                    return self.json_response(409, {"error": "Choose an available delivery slot."})
                if coupon and coupon not in terms["coupons"]:
                    return self.json_response(409, {"error": "This coupon is unavailable."})
                binding_total = sum(terms["bindingRates"][item["binding"]] * item["copies"] for item in documents)
                pickup = admin_records.default_pickup(db)
                bill = bill_for(total, binding_total, coupon, terms, pickup=pickup, address=details["address"])
                if type(data.get("expectedTotal")) is not int or data["expectedTotal"] != bill["total"]:
                    return self.json_response(409, {"error": "Prices changed. Review your updated total.", "pricingChanged": True})
                encoded = json.dumps({
                    **details, "bill": bill, "partnerPayout": terms.get("partnerPayout", 0),
                    "pickupWarehouse": pickup,
                }, sort_keys=True)
                db.execute("INSERT INTO orders VALUES (?, ?, 'pending', ?)", (order_id, token, encoded))
                db.execute("INSERT INTO order_owners (order_id, email, order_number) VALUES (?, ?, ?)",
                           (order_id, email, order_number(db)))
                ops.audit(db, "customer", "order_created", order_id)
        self.json_response(200, {"subtotal": total, "total": bill["total"] if bill else total})

    def checkout_quote(self):
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 65536:
            raise ValueError("Invalid quote length.")
        data = json.loads(self.rfile.read(length))
        coupon = data.get("coupon", "").strip().upper()
        address = data.get("address", "")
        if not isinstance(address, str) or len(address) > 500:
            raise ValueError("Invalid delivery address.")
        with closing(connect()) as db, db:
            db.execute("BEGIN")
            if not admin_records.warehouse_availability(db)["open"]:
                return self.json_response(409, {"error": "Printing is currently closed. Please try again when the warehouse reopens.", "serviceClosed": True})
            terms = delivery_terms(self.checkout_terms(db), data, address)
            pickup = admin_records.default_pickup(db) if terms.get("deliveryPerKm") else None
        documents, total = quote_items(data["items"], terms["paperRates"], terms["bindingRates"])
        if coupon and coupon not in terms["coupons"]:
            return self.json_response(400, {"error": "This coupon is unavailable."})
        binding_total = sum(terms["bindingRates"][item["binding"]] * item["copies"] for item in documents)
        bill = bill_for(total, binding_total, coupon, terms, pickup=pickup, address=address)
        self.json_response(200, bill)

    def inspect_document(self):
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= LIMIT:
            raise ValueError("Invalid file size.")
        if not DOCUMENT_READERS.acquire(blocking=False):
            self.close_connection = True
            return self.json_response(503, {"error": "Page counting is busy. Try again."})
        try:
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError("Incomplete upload.")
            kind = parse_qs(urlsplit(self.path).query).get("format", ["pdf"])[0]
            if kind not in ("pdf", "docx"):
                raise ValueError("Unsupported document format.")
            pages = count_pages("document." + kind, body)
        finally:
            DOCUMENT_READERS.release()
        self.json_response(200, {"pages": pages})

    def upload(self, order_id, position):
        position = int(position)
        length = int(self.headers.get("Content-Length", "0"))
        with closing(connect()) as db:
            order = self.customer_order(db, order_id)
            if not order or order["status"] != "pending":
                return self.json_response(409, {"error": "Order is unavailable for file uploads."})
            items = json.loads(order["details"])["items"]
            if position >= len(items) or length != items[position]["size"] or not 0 < length <= LIMIT:
                raise ValueError()
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError()
            item = items[position]
            if not DOCUMENT_READERS.acquire(blocking=False):
                return self.json_response(503, {"error": "Page counting is busy. Try again."})
            try:
                pages = count_pages(item["name"], body)
            finally:
                DOCUMENT_READERS.release()
            requested = item.get("pageRange", [item["pages"]])[-1]
            if pages is not None and requested > pages:
                return self.json_response(422, {"error": "The selected print pages exceed the file's page count."})
            with db:
                db.execute("BEGIN IMMEDIATE")
                if self.customer_order(db, order_id)["status"] != "pending" or db.execute(
                    "SELECT 1 FROM razorpay_orders WHERE order_id=?", (order_id,)
                ).fetchone():
                    return self.json_response(409, {"error": "Payment has already started."})
                storage = self.server.files
                if storage:
                    try:
                        object_key = storage.put(order_id, position, body)
                    except storage.errors:
                        return self.json_response(502, {"error": "Could not store the file. Please retry."})
                else:
                    object_key = None
                db.execute("INSERT OR REPLACE INTO files (order_id, position, content, object_key) VALUES (?, ?, ?, ?)",
                           (order_id, position, None if object_key else body, object_key))
        self.json_response(200, {"saved": True})

    def customer_order(self, db, order_id):
        row = db.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
        if row and hmac.compare_digest(row["token"], self.headers.get("X-Order-Key", "")):
            return row
        return None

    def start_payment(self, order_id, test_only=False):
        mode = self.server.payment_mode
        if mode == "disabled" or (test_only and mode != "test"):
            return self.json_response(503, {"error": "Checkout payments are unavailable."})
        with closing(connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = self.customer_order(db, order_id)
            if not row:
                return self.json_response(404, {"error": "Order unavailable."})
            if row["status"] != "pending":
                return self.json_response(200, {"status": row["status"]})
            details = json.loads(row["details"])
            count = db.execute("SELECT count(*) FROM files WHERE order_id=?", (order_id,)).fetchone()[0]
            if count != len(details["items"]):
                return self.json_response(409, {"error": "Upload all files before payment."})
            existing = db.execute("SELECT * FROM razorpay_orders WHERE order_id=?", (order_id,)).fetchone()
            if mode == "test":
                if existing:
                    return self.json_response(409, {"error": "Resume this order in Razorpay."})
                db.execute("UPDATE orders SET status='paid' WHERE id=?", (order_id,))
                ops.audit(db, "checkout", "paid", order_id)
                result = {"status": "paid"}
            else:
                gateway = self.server.razorpay
                amount = details.get("bill", {}).get("total", details["subtotal"])
                try:
                    provider_id = existing["provider_id"] if existing else gateway.order(order_id, amount)
                except (OSError, ValueError, KeyError, TypeError):
                    return self.json_response(502, {"error": "Could not start Razorpay. Please retry."})
                if not existing:
                    db.execute("INSERT INTO razorpay_orders(order_id, provider_id, amount) VALUES (?,?,?)",
                               (order_id, provider_id, amount))
                result = {"status": "pending", "key": gateway.key, "order_id": provider_id,
                          "amount": amount, "currency": "INR"}
        self.json_response(200, result)

    def razorpay_webhook(self):
        gateway = self.server.razorpay
        if not gateway:
            return self.json_response(404, {"error": "Payment webhook unavailable."})
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 65536:
            raise ValueError("Invalid webhook length.")
        body = self.rfile.read(length)
        if not gateway.valid_signature(body, self.headers.get("X-Razorpay-Signature", "")):
            return self.json_response(403, {"error": "Invalid webhook signature."})
        event = json.loads(body)
        event_type = event["event"]
        if event_type not in ("payment.captured", "refund.processed", "refund.failed"):
            return self.json_response(200, {"received": True})
        with closing(connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            if event_type == "payment.captured":
                payment = event["payload"]["payment"]["entity"]
                pending = db.execute("SELECT order_id FROM razorpay_orders WHERE provider_id=? AND payment_id IS NULL",
                                     (payment["order_id"],)).fetchone()
                recorded = razorpay_checkout.record_capture(db, payment)
                if recorded and pending:
                    ops.audit(db, "razorpay", "paid", pending["order_id"])
            else:
                refund = event["payload"]["refund"]["entity"]
                if razorpay_checkout.record_refund(db, refund):
                    ops.audit(db, "razorpay", event_type, refund["receipt"][5:])
                recorded = None
        if recorded is False:
            return self.json_response(409, {"error": "Payment does not match the order."})
        self.json_response(200, {"received": True})

    def client_ip(self):
        """The caller's address. Behind the HTTPS proxy (Render) the last X-Forwarded-For entry is the one the proxy
        itself added; the earlier ones can be forged by the caller."""
        forwarded = self.headers.get("X-Forwarded-For", "")
        if forwarded and (auth.public_origin() or "").startswith("https"):
            return forwarded.split(",")[-1].strip()[:64]
        return self.client_address[0]

    def read_support_attachment(self, row):
        """(body, type, disposition) for a download. Always an attachment (never rendered in the page), with the type
        that was verified from the file's content when it was uploaded."""
        if row["object_key"]:
            storage = self.server.files
            if not storage:
                raise support.SupportError("File storage is unavailable. Please try again later.")
            try:
                body = storage.read(row["object_key"])
            except storage.errors:
                raise support.SupportError("Could not retrieve the file. Please retry.")
        else:
            body = row["content"]
        return (body, row["content_type"], f'attachment; filename="{row["filename"]}"')

    def support_upload(self, db, ticket_id, message_id, uploader):
        length = int(self.headers.get("Content-Length", "0") or 0)
        if not 0 < length <= support.MAX_FILE_BYTES:
            self.close_connection = True
            return self.json_response(400, {"error": "Each file must be between 1 byte and 10 MB."})
        body = self.rfile.read(length)
        if len(body) != length:
            raise support.SupportError("The upload was interrupted. Please try again.")
        name = unquote(self.headers.get("X-Filename", ""))[:200]
        ip = self.client_ip()
        support.check_rate(db, "upload", uploader, ip)
        saved = support.add_attachment(db, ticket_id, message_id, uploader, name, body, self.server.files)
        support.record_rate(db, "upload", uploader, ip)
        return {"attachment": saved}

    def support_api(self, path):
        """Support tickets. Customers use /api/support/..., admins /api/admin/support/... All updates are POST."""
        area = "admin" if path.startswith("/api/admin/") else "staff" if path.startswith("/api/staff/") else "customer"
        with closing(connect()) as db:
            if area == "admin":
                if self.get_role() != "admin":
                    return self.json_response(403, {"error": "Admin access is required."})
                actor = "admin" if self.headers.get("X-Staff-Key") else auth.portal_google_email(db, self.headers, "admin") or "admin"
                email = None
            elif area == "staff":
                role = self.get_role()
                if role not in ("warehouse", "admin"):
                    return self.json_response(403, {"error": "Warehouse access is required."})
                actor = role if self.headers.get("X-Staff-Key") else auth.portal_google_email(db, self.headers, "warehouse") or role
                email = None
            else:
                email = auth.session_email(db, self.headers)
                if not email:
                    return self.json_response(401, {"error": "Sign in to use support."})
                if self.command == "POST" and not self.same_origin():
                    return self.json_response(403, {"error": "Open PrintBee directly and try again."})
                actor = email
        upload = re.fullmatch(r"/api/support/tickets/(\d+)/messages/(\d+)/attachments", path)
        if upload and self.command == "POST" and area == "customer":
            try:
                with closing(connect()) as db, db:
                    db.execute("BEGIN IMMEDIATE")
                    result = self.support_upload(db, int(upload[1]), int(upload[2]), actor)
            except support.NotFound as error:
                return self.json_response(404, {"error": str(error)})
            except support.RateLimited as error:
                return self.json_response(429, {"error": str(error)})
            except support.SupportError as error:
                return self.json_response(400, {"error": str(error)})
            except (self.server.files.errors if self.server.files else ()):
                return self.json_response(502, {"error": "Could not store the file. Please retry."})
            return self.json_response(200, result) if isinstance(result, dict) else result
        data = {}
        if self.command == "POST":
            length = int(self.headers.get("Content-Length", "0") or 0)
            if not 0 <= length <= 16384:
                return self.json_response(400, {"error": "That message is too long."})
            data = json.loads(self.rfile.read(length)) if length else {}
            if not isinstance(data, dict):
                return self.json_response(400, {"error": "Invalid request."})
        parts = urlsplit(self.path)
        query = {key: values[0] for key, values in parse_qs(parts.query, max_num_fields=20).items()}
        try:
            with closing(connect()) as db, db:
                if self.command == "POST":
                    db.execute("BEGIN IMMEDIATE")
                run = lambda: self.support_route(db, path, query, data, area, actor, email)
                if self.command == "POST":
                    # A double click or retry carries the same Idempotency-Key and gets the first answer back.
                    result = support.idempotent(db, f"{actor}|{path}", self.headers.get("Idempotency-Key"), run)
                else:
                    result = run()
        except support.NotFound as error:
            return self.json_response(404, {"error": str(error)})
        except support.RateLimited as error:
            return self.json_response(429, {"error": str(error)})
        except support.SupportError as error:
            return self.json_response(400, {"error": str(error)})
        if self.command == "POST":
            self.kick_escalations()
        if isinstance(result, tuple):       # a download: (body, type, disposition)
            return self.send_download(*result)
        return self.json_response(200, result)

    def buzz_eta(self, db, order_id, status):
        """Minutes until delivery for an order on its way, when the Bee Runner is sharing a live location."""
        if status != "out_for_delivery":
            return None
        return (self.customer_delivery(db, order_id, status) or {}).get("etaMinutes")

    def buzz_codes(self, db, email):
        """The customer's live delivery codes. Used only to scrub chat text; the code is never given to Buzz."""
        codes = []
        for row in db.execute("SELECT orders.id FROM orders JOIN order_owners ON orders.id=order_owners.order_id "
                              "WHERE order_owners.email=? AND orders.status='out_for_delivery'", (email,)):
            code = (self.customer_delivery(db, row["id"], "out_for_delivery") or {}).get("code")
            if code:
                codes.append(code)
        return codes

    def chat_api(self, path):
        """Buzz, the support chatbot. Guests may ask general questions; orders and tickets need the customer's own session."""
        if not self.same_origin():
            return self.json_response(403, {"error": "Open PrintBee directly and try again."})
        length = int(self.headers.get("Content-Length", "0") or 0)
        if not 0 < length <= 4096:
            self.close_connection = True
            return self.json_response(400, {"error": "That message is too long."})
        try:
            data = json.loads(self.rfile.read(length))
        except ValueError:
            return self.json_response(400, {"error": "Invalid request."})
        if not isinstance(data, dict):
            return self.json_response(400, {"error": "Invalid request."})
        ip = self.client_ip()
        try:
            with closing(connect()) as db, db:
                email = auth.session_email(db, self.headers)
                caller = buzz.Caller(db, email, ip, lambda: self.checkout_terms(db), eta=self.buzz_eta, codes=self.buzz_codes)
                if path.endswith("/feedback"):
                    result = buzz.feedback(db, buzz.owner_key(email, ip), data.get("sessionId"), data.get("messageId"), data.get("rating"))
                elif data.get("action") == "confirm":
                    db.execute("BEGIN IMMEDIATE")
                    result = support.idempotent(db, f"{email}|buzz-confirm|{data.get('draftId')}", self.headers.get("Idempotency-Key"),
                                                lambda: buzz.confirm_ticket(caller, data.get("sessionId"), data.get("draftId")))
                elif data.get("action") == "human":
                    result = buzz.human_draft(caller, data.get("sessionId"), data.get("orderNumber") if isinstance(data.get("orderNumber"), str) else None)
                else:
                    result = buzz.chat(caller, data)
        except support.NotFound as error:
            return self.json_response(404, {"error": str(error)})
        except support.RateLimited as error:
            return self.json_response(429, {"error": str(error)})
        except support.SupportError as error:
            return self.json_response(400, {"error": str(error)})
        if data.get("action") == "confirm":
            self.kick_escalations()
        return self.json_response(200, result)

    def kick_escalations(self):
        """Email the owner right away when a ticket just became urgent or a Buzz escalation (the worker also sweeps)."""
        if not os.environ.get("PRINTBEE_OWNER_EMAIL") or not os.environ.get("PRINTBEE_SMTP_HOST"):
            return
        try:
            with closing(connect()) as db:
                waiting = db.execute("SELECT count(*) FROM support_escalations WHERE sent IS NULL AND reason!='overdue'").fetchone()[0]
        except sqlite3.Error:
            return
        if waiting:
            import support_notify
            threading.Thread(target=support_notify.send_pending_now, daemon=True).start()

    def support_route(self, db, path, query, data, area, actor, email):
        post = self.command == "POST"
        ip = self.client_ip()
        admin_area = area == "admin"
        file = re.fullmatch(r"/api/(admin/|staff/)?support/attachments/(\d+)", path)
        if file and not post:
            if area == "admin":
                row = support.attachment_for_staff(db, int(file[2]))
            elif area == "staff":
                row = support.warehouse_attachment(db, int(file[2]), actor)
            else:
                row = support.attachment_for_customer(db, int(file[2]), email)
            return self.read_support_attachment(row)
        if area == "staff":
            if path == "/api/staff/support/tickets" and not post:
                return support.warehouse_tickets(db, actor, status=query.get("status"), limit=query.get("limit", 25), offset=query.get("offset", 0))
            match = re.fullmatch(r"/api/staff/support/tickets/(\d+)(?:/(reply))?", path)
            if match and not post and not match[2]:
                return {"ticket": support.warehouse_ticket(db, int(match[1]), actor)}
            if match and post and match[2] == "reply":
                support.check_rate(db, "message", actor, ip)
                support.warehouse_reply(db, int(match[1]), actor, data.get("message"))
                support.record_rate(db, "message", actor, ip)
                return {"ticket": support.warehouse_ticket(db, int(match[1]), actor)}
            raise support.NotFound("Unknown support request.")
        if not admin_area:
            if path == "/api/support/categories" and not post:
                return {"categories": support.categories()}
            if path == "/api/support/notifications" and not post:
                return support.notifications(db, email, email)
            if path == "/api/support/notifications/read" and post:
                support.mark_notifications_read(db, email, email, None if data.get("all") else [data.get("id")])
                return support.notifications(db, email, email)
            if path == "/api/support/tickets":
                if not post:
                    return {"tickets": support.customer_tickets(db, email)}
                support.check_rate(db, "ticket", email, ip)
                ident = support.create_ticket(db, email=email, category=data.get("category"), subject=data.get("subject"),
                                              message=data.get("message"), order_id=data.get("orderId") or None)
                support.record_rate(db, "ticket", email, ip)
                return {"ticket": support.customer_ticket(db, ident, email)}
            match = re.fullmatch(r"/api/support/tickets/(\d+)(?:/(reply|resolve))?", path)
            if match:
                ident, action = int(match[1]), match[2]
                if not post and not action:
                    return {"ticket": support.customer_ticket(db, ident, email)}
                if post and action == "reply":
                    support.check_rate(db, "message", email, ip)
                    support.customer_reply(db, ident, email, data.get("message"))
                    support.record_rate(db, "message", email, ip)
                elif post and action == "resolve":
                    support.customer_resolve(db, ident, email)
                else:
                    raise support.NotFound("Unknown support request.")
                return {"ticket": support.customer_ticket(db, ident, email)}
            raise support.NotFound("Unknown support request.")
        # ---- admin / support agents
        invoice = re.fullmatch(r"/api/admin/orders/([a-f0-9]{32})/invoice", path)
        if invoice and not post:
            row = db.execute("SELECT details, order_number, provider_id FROM orders LEFT JOIN order_owners "
                             "ON orders.id=order_owners.order_id LEFT JOIN razorpay_orders ON orders.id=razorpay_orders.order_id "
                             "WHERE orders.id=? AND status!='pending'", (invoice[1],)).fetchone()
            if not row:
                raise support.NotFound("That order was not found.")
            number = row["order_number"] or "PB-" + invoice[1][:8].upper()
            body = invoice_pdf(number, json.loads(row["details"]), "razorpay" if row["provider_id"] else "test")
            return (body, "application/pdf", f'attachment; filename="{number}.pdf"')
        if path == "/api/admin/support/agents" and not post:
            agents = sorted(set(self.server.google_access["admin"]) | set(self.server.google_access["warehouse"]))
            return {"me": actor, "agents": agents, "categories": support.categories(),
                    "statuses": list(support.STATUSES), "priorities": list(support.PRIORITIES),
                    "firstResponseHours": support.first_response_hours(db), "canned": support.list_canned(db)}
        if path == "/api/admin/support/notifications" and not post:
            return support.notifications(db, actor, "staff")
        if path == "/api/admin/support/notifications/read" and post:
            support.mark_notifications_read(db, actor, "staff", None if data.get("all") else [data.get("id")])
            return support.notifications(db, actor, "staff")
        if path == "/api/admin/support/settings" and post:
            support.set_first_response_hours(db, data.get("firstResponseHours"))
            return {"firstResponseHours": support.first_response_hours(db)}
        if path == "/api/admin/support/canned" and post:
            support.save_canned(db, data)
            return {"canned": support.list_canned(db)}
        if path == "/api/admin/support/canned/delete" and post:
            support.delete_canned(db, data.get("id"))
            return {"canned": support.list_canned(db)}
        if path == "/api/admin/support/tickets":
            if not post:
                return support.staff_tickets(db, status=query.get("status"), priority=query.get("priority"),
                                             assignee=query.get("assignee"), category=query.get("category"),
                                             query=query.get("q"), sort=query.get("sort") or "updated",
                                             limit=query.get("limit", 25), offset=query.get("offset", 0))
            # an admin opens a ticket for a customer (also the shape Buzz will use with source="buzz")
            ident = support.create_ticket(db, email=data.get("email"), category=data.get("category"),
                                          subject=data.get("subject"), message=data.get("message"),
                                          order_id=data.get("orderId") or None, source="admin",
                                          priority=data.get("priority") or "normal", actor=actor)
            return {"ticket": support.staff_ticket(db, ident)}
        match = re.fullmatch(r"/api/admin/support/tickets/(\d+)(?:/(reply|note|status|priority|assign))?", path)
        if not match:
            raise support.NotFound("Unknown support request.")
        ident, action = int(match[1]), match[2]
        if not post:
            if action:
                raise support.NotFound("Unknown support request.")
            return {"ticket": support.staff_ticket(db, ident)}
        if action in ("reply", "note"):
            support.check_rate(db, "message", actor, ip)
            support.staff_reply(db, ident, actor, data.get("message"), internal=action == "note")
            support.record_rate(db, "message", actor, ip)
        elif action == "status":
            support.set_status(db, ident, actor, data.get("status"))
        elif action == "priority":
            support.set_priority(db, ident, actor, data.get("priority"))
        elif action == "assign":
            allowed = set(self.server.google_access["admin"]) | set(self.server.google_access["warehouse"])
            support.assign(db, ident, actor, data.get("assignee"), allowed)
        else:
            raise support.NotFound("Unknown support request.")
        return {"ticket": support.staff_ticket(db, ident)}

    def confirm_manual_print(self, order_id, position):
        role = self.get_role()
        if role not in ("warehouse", "admin"):
            return self.json_response(403, {"error": "Warehouse access is required."})
        with closing(connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            changed = db.execute(
                "INSERT INTO print_jobs(order_id, position, state) SELECT files.order_id, files.position, 'done' "
                "FROM files JOIN orders ON orders.id=files.order_id WHERE files.order_id=? AND position=? "
                "AND orders.status IN ('paid','printing') ON CONFLICT(order_id, position) "
                "DO UPDATE SET state='done', error=NULL WHERE print_jobs.state='failed'",
                (order_id, int(position)),
            ).rowcount
            if not changed:
                raise ops.Conflict("This file is unavailable for manual confirmation.")
            db.execute("UPDATE orders SET status='printing' WHERE id=? AND status='paid'", (order_id,))
            ops.audit(db, role, "printed_manually", order_id)
            self.ready_printed_order(db, role, order_id)
        self.json_response(200, {"saved": True})

    def partner_orders(self, db):
        partner = self.get_partner()
        if not partner:
            return self.json_response(403, {"error": "Delivery access is required."})
        rows = db.execute(
            "SELECT orders.id, orders.status, orders.details, order_number, partner FROM orders "
            "LEFT JOIN order_owners ON orders.id=order_owners.order_id LEFT JOIN deliveries "
            "ON orders.id=deliveries.order_id WHERE (orders.status='packed' AND partner IS NULL) "
            "OR (partner=? AND orders.status IN ('packed','out_for_delivery','delivered')) "
            "ORDER BY orders.rowid DESC LIMIT 100", (partner,)
        )
        orders = []
        for row in rows:
            record = {key: row[key] for key in ("id", "status", "order_number", "partner")}
            details = json.loads(row["details"])
            record["payout"] = details.get("partnerPayout", 0)
            if row["status"] == "packed" and details.get("pickupWarehouse"):
                record["pickupWarehouse"] = details["pickupWarehouse"]
            if row["partner"] and row["status"] == "out_for_delivery":
                record.update({key: details.get(key) for key in ("customer", "address", "phone", "slot", "notes")})
            orders.append(record)
        availability = db.execute("SELECT available, updated FROM partner_availability WHERE partner=?",
                                  (partner,)).fetchone()
        earnings = dict(db.execute(
            "SELECT COALESCE(sum(amount),0) AS lifetime, "
            "COALESCE(sum(CASE WHEN settled IS NULL THEN amount END),0) AS outstanding "
            "FROM partner_earnings WHERE partner=?", (partner,)
        ).fetchone())
        return self.json_response(200, {"profile": admin_records.partner_profile(db, partner), "orders": orders, "earnings": earnings, "available": bool(
            availability and availability["available"] and availability["updated"] > time.time() - 900
        )})

    def verify_partner_phone(self, action):
        origin = auth.public_origin() or f"http://{self.headers.get('Host')}"
        if self.headers.get("Origin") != origin or self.headers.get_content_type() != "application/json":
            return self.json_response(403, {"error": "Open PrintBee directly and try again."})
        if action == "logout":
            with closing(connect()) as db, db:
                db.execute("DELETE FROM partner_sessions WHERE digest=?",
                           (auth.digest(auth.session_token(self.headers, "printbee_partner")),))
            return self.json_response(200, {"saved": True}, auth.session_cookie("", 0, "printbee_partner"))
        provider = self.server.partner_verify
        if not provider:
            return self.json_response(503, {"error": "Phone sign-in is unavailable."})
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 1024:
            raise ValueError()
        data = json.loads(self.rfile.read(length))
        phone = data["phone"].strip()
        if not re.fullmatch(r"\+[1-9][0-9]{7,14}", phone):
            return self.json_response(400, {"error": "Enter a phone number with its country code."})
        now = int(time.time())
        scope = action + ":" + auth.digest(phone)
        with closing(connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM partner_auth_limits WHERE created<=?", (now - 600,))
            count, last = db.execute("SELECT count(*), max(created) FROM partner_auth_limits WHERE scope=?",
                                     (scope,)).fetchone()
            total = db.execute("SELECT count(*) FROM partner_auth_limits").fetchone()[0]
            if total >= 150 or count >= 5 or (action == "send" and last and last > now - 60):
                return self.json_response(429, {"error": "Try again in a few minutes."})
            db.execute("INSERT INTO partner_auth_limits VALUES (?,?)", (scope, now))
        partner = self.server.partner_phones.get(phone)
        try:
            if action == "send":
                if partner and not provider.send(phone):
                    raise OSError()
                return self.json_response(200, {"sent": True})
            code = data["code"].strip()
            approved = partner and re.fullmatch(r"[0-9]{4,10}", code) and provider.approved(phone, code)
        except (OSError, KeyError):
            return self.json_response(503, {"error": "Phone verification is temporarily unavailable."})
        if not approved:
            return self.json_response(400, {"error": "The verification code is invalid or expired."})
        token = secrets.token_urlsafe(32)
        age = 43200
        with closing(connect()) as db, db:
            db.execute("DELETE FROM partner_sessions WHERE expires<=? OR digest=?",
                       (now, auth.digest(auth.session_token(self.headers, "printbee_partner"))))
            db.execute("INSERT INTO partner_sessions VALUES (?,?,?)", (auth.digest(token), partner, now + age))
        return self.json_response(200, {"signedIn": True}, auth.session_cookie(token, age, "printbee_partner"))

    def customer_delivery(self, db, order_id, status):
        """What the customer may see about the delivery. The code is shown to the owner only."""
        if status not in ("packed", "out_for_delivery"):
            return None
        row = db.execute("SELECT * FROM deliveries WHERE order_id=?", (order_id,)).fetchone()
        if not row:
            return None
        delivery = {"partner": re.sub(r"[-_.]+", " ", row["partner"].split("@")[0]).strip().title()}
        if status != "out_for_delivery":
            return delivery
        if row["nonce"] and row["expires"] > time.time() and row["attempts"] < 3:
            delivery["code"] = ops.delivery_code(self.server.keys["delivery-code"].encode(), row["nonce"])
        if row["located_at"] and row["located_at"] > time.time() - 300:
            delivery["location"] = [row["lat"], row["lng"]]
            address = json.loads(db.execute("SELECT details FROM orders WHERE id=?", (order_id,)).fetchone()["details"]).get("address")
            destination = coordinates(address, delivery=True)
            if destination:
                delivery["etaMinutes"] = eta_minutes((row["lat"], row["lng"]), destination)
        return delivery

    def admin_ledger(self, db):
        if self.get_role() != "admin":
            return self.json_response(403, {"error": "Admin access is required."})
        query = parse_qs(urlsplit(self.path).query)
        page = query.get("page", ["1"])[0]
        kind = query.get("kind", [""])[0]
        if not re.fullmatch(r"[1-9][0-9]{0,8}", page) or kind not in ("", *admin_ledger.KINDS):
            return self.json_response(400, {"error": "Invalid ledger page or transaction type."})
        db.execute("BEGIN")
        return self.json_response(200, admin_ledger.ledger(db, int(page), kind))

    def admin_snapshot(self, db):
        if self.get_role() != "admin":
            return self.json_response(403, {"error": "Admin access is required."})
        db.execute("BEGIN")
        orders = [dict(row) for row in db.execute(
            "SELECT orders.id, status, order_number, json_extract(details,'$.customer') AS customer, "
            "CAST(COALESCE(json_extract(details,'$.bill.total'), "
            "json_extract(details,'$.subtotal')) AS INTEGER) AS total, payment_id IS NOT NULL AS captured, "
            "(SELECT max(created) FROM audit WHERE order_id=orders.id AND action='paid') AS created, "
            "(SELECT min(created) FROM order_events WHERE order_id=orders.id) AS placed, "
            "deliveries.partner AS partner, order_owners.email AS email, "
            "json_extract(details,'$.items[0].name') AS first_file, json_array_length(details,'$.items') AS files, "
            "json_extract(details,'$.items[0].colour') AS colour, json_extract(details,'$.items[0].binding') AS binding, "
            "json_extract(details,'$.address') AS address, "
            "CAST(COALESCE(json_extract(details,'$.bill.tax'),0) AS INTEGER) AS tax, "
            "CAST(COALESCE(json_extract(details,'$.partnerPayout'),0) AS INTEGER) AS payout "
            "FROM orders LEFT JOIN order_owners ON orders.id=order_owners.order_id "
            "LEFT JOIN razorpay_orders ON orders.id=razorpay_orders.order_id "
            "LEFT JOIN deliveries ON orders.id=deliveries.order_id ORDER BY orders.rowid DESC LIMIT 500"
        )]
        orders = [self.describe_order(row) for row in orders]
        offline = [dict(row) for row in db.execute(
            "SELECT id, 'offline' AS status, 'PB-OFF-' || upper(substr(id,1,8)) AS order_number, "
            "customer, product, total, created FROM offline_sales ORDER BY created DESC, rowid DESC LIMIT 500"
        )]
        orders = sorted(orders + offline, key=lambda row: row["created"] or 0, reverse=True)[:500]
        counts = {row["status"]: row["count"] for row in db.execute(
            "SELECT status, count(*) AS count FROM orders GROUP BY status"
        )}
        counts["offline"] = db.execute("SELECT count(*) FROM offline_sales").fetchone()[0]
        captured = db.execute("SELECT COALESCE(sum(amount),0) FROM razorpay_orders WHERE payment_id IS NOT NULL").fetchone()[0]
        history = [dict(row) for row in db.execute(
            "SELECT actor, action, order_id, created FROM audit ORDER BY id DESC LIMIT 50"
        )]
        earned = {row["partner"]: dict(row) for row in db.execute(
            "SELECT partner, count(*) AS deliveries, COALESCE(sum(amount),0) AS accrued, "
            "COALESCE(sum(CASE WHEN settled IS NULL THEN amount END),0) AS outstanding "
            "FROM partner_earnings GROUP BY partner")}
        directory = {}
        for email, partner in self.server.google_access["partner"].items():
            directory[partner] = {"id": partner, "email": email}
        for partner in [*self.server.partners, *self.server.partner_phones.values(), *earned]:
            if partner != "delivery":
                directory.setdefault(partner, {"id": partner, "email": None})
        saved = admin_records.partner_accounts(db)
        for entry in directory.values():
            entry.update(admin_records.partner_profile(db, entry["id"]))
        partners = [{**entry, "removable": entry["email"] in saved, "deliveries": 0, "accrued": 0, "outstanding": 0, **earned.get(entry["id"], {"partner": 0})}
                    for entry in directory.values()]
        for entry in partners:
            entry.pop("partner", None)
        payouts = [dict(row) for row in db.execute(
            "SELECT order_id, partner, amount, earned FROM partner_earnings WHERE settled IS NULL AND amount>0 "
            "ORDER BY earned LIMIT 100"
        )]
        return self.json_response(200, {"orders": orders, "counts": counts, "captured": captured,
                                        "terms": self.checkout_terms(db), "audit": history, "payouts": payouts,
                                        "today": admin_records.today_totals(db),
                                        "finance": finance.summary(db), "paymentMode": self.server.payment_mode,
                                        "partners": partners,
                                        "warehouses": admin_records.warehouse_directory(db),
                                        "pricingVersion": db.execute("SELECT COALESCE(max(id),0) FROM pricing_versions").fetchone()[0]})

    @staticmethod
    def describe_order(row):
        """Admin dashboard fields for one order: a readable product line, category and delivery area."""
        order = dict(row)
        files = order.pop("files") or 0
        first = order.pop("first_file") or "Document"
        order["product"] = first if files <= 1 else f"{first} +{files - 1} more"
        colour, binding = order.pop("colour"), order.pop("binding") or "none"
        order["category"] = ("Colour printing" if colour else "Black & white printing") + (
            "" if binding == "none" else " + binding")
        area = (order.pop("address") or "").split("\n")[0].split(",")[0].strip()
        order["region"] = area[:40] or "Delivery"
        return order

    def operations_post(self, path):
        area = path.split("/")[2]
        role = {"admin": "admin", "partner": "delivery"}[area]
        partner = self.get_partner() if area == "partner" else None
        if area == "partner" and not self.headers.get("X-Staff-Key"):
            origin = auth.public_origin() or f"http://{self.headers.get('Host')}"
            if self.headers.get("Origin") != origin or self.headers.get_content_type() != "application/json":
                return self.json_response(403, {"error": "Open PrintBee directly and try again."})
        if not (partner if area == "partner" else self.get_role() == role):
            return self.json_response(403, {"error": "This account cannot perform this action."})
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > 65536:
            raise ValueError()
        data = json.loads(self.rfile.read(length)) if length else {}
        refund = re.fullmatch(r"/api/admin/orders/([a-f0-9]{32})/refund", path)
        if refund:
            return self.refund_order(refund[1])
        with closing(connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            if path in ("/api/admin/offline-orders", "/api/admin/warehouses"):
                if not isinstance(data, dict):
                    raise ValueError("Invalid admin request.")
                actor = "admin" if self.headers.get("X-Staff-Key") else auth.portal_google_email(
                    db, self.headers, "admin"
                ) or "admin"
                if path == "/api/admin/offline-orders":
                    result = admin_records.record_offline_sales(db, data.get("orders"), actor)
                else:
                    taken = self.staff_role(str(data.get("email", "")).strip().lower())
                    if taken and taken != "warehouse":
                        raise admin_records.InputError("That email already has " + taken + " access. Use a different email.")
                    result = admin_records.save_warehouse(db, data, actor)
                    require_pickup_coordinates(self.checkout_terms(db), admin_records.default_pickup(db))
                    self.server.google_access["warehouse"][data["email"].strip().lower()] = "warehouse"   # the admin's entry grants access
            elif path == "/api/admin/warehouses/remove":
                if not isinstance(data, dict):
                    raise admin_records.InputError("Invalid warehouse request.")
                actor = auth.portal_google_email(db, self.headers, "admin") or role
                email = admin_records.remove_warehouse(db, data, actor)
                if email not in admin_records.warehouse_staff(db):
                    self.server.google_access["warehouse"].pop(email, None)   # no saved warehouse left for this email
                result = {"saved": True}
            elif path in ("/api/admin/partners", "/api/admin/partners/remove"):
                if not isinstance(data, dict):
                    raise admin_records.InputError("Invalid partner request.")
                actor = auth.portal_google_email(db, self.headers, "admin") or role
                if path.endswith("/remove"):
                    email = admin_records.remove_partner(db, data, actor)
                    self.server.google_access["partner"].pop(email, None)
                else:
                    taken = self.staff_role(str(data.get("email", "")).strip().lower())
                    if taken and taken != "partner":
                        raise admin_records.InputError("That email already has " + taken + " access. Use a different email.")
                    email, partner = admin_records.add_partner(db, data, actor)
                    self.server.google_access["partner"][email] = partner
                result = {"saved": True}
            elif path == "/api/admin/pricing":
                version = db.execute("SELECT COALESCE(max(id),0) FROM pricing_versions").fetchone()[0]
                if not isinstance(data, dict):
                    raise admin_records.InputError("Enter valid pricing settings.")
                if "changes" in data:
                    if not isinstance(data["changes"], dict) or type(data.get("version")) is not int:
                        raise admin_records.InputError("Enter valid pricing changes.")
                    if data["version"] != version:
                        raise ops.Conflict("Pricing was updated elsewhere. Reload this page and try again.")
                    data = {**self.checkout_terms(db), **data["changes"]}
                binding = data.get("bindingRates", {})
                if isinstance(binding, dict):
                    data["bindingRates"] = {key: rate for key, rate in binding.items() if key != "none"}
                try:
                    terms = validate_terms(data)
                except ValueError as error:
                    raise admin_records.InputError(str(error)) from error
                require_pickup_coordinates(terms, admin_records.default_pickup(db))
                cursor = db.execute("INSERT INTO pricing_versions(terms, created) VALUES (?,?)",
                                    (json.dumps(terms), int(time.time())))
                actor = auth.portal_google_email(db, self.headers, "admin") or role
                ops.audit(db, actor, "pricing_updated", str(cursor.lastrowid))
                result = {"version": cursor.lastrowid}
            elif role == "admin" and (reset := re.fullmatch(r"/api/admin/orders/([a-f0-9]{32})/renew-code", path)):
                ops.renew_delivery_code(db, reset[1])
                result = {"saved": True}
            elif role == "admin" and (reroute := re.fullmatch(r"/api/admin/orders/([a-f0-9]{32})/(reassign|undeliverable)", path)):
                if reroute[2] == "reassign":
                    ops.reassign(db, reroute[1])
                else:
                    ops.mark_undeliverable(db, reroute[1], "admin")
                result = {"saved": True}
            elif role == "admin" and (cancel := re.fullmatch(r"/api/admin/orders/([a-f0-9]{32})/cancel", path)):
                ops.cancel_order(db, cancel[1])
                result = {"saved": True}
            elif role == "admin" and (settlement := re.fullmatch(r"/api/admin/payouts/([a-f0-9]{32})/record", path)):
                reference = data["reference"].strip()
                if not reference or len(reference) > 100:
                    raise ValueError()
                ops.settle_earning(db, settlement[1], reference)
                result = {"saved": True}
            elif path == "/api/partner/availability":
                if type(data.get("available")) is not bool:
                    raise ValueError()
                db.execute("INSERT INTO partner_availability VALUES (?,?,?) ON CONFLICT(partner) DO UPDATE "
                           "SET available=excluded.available, updated=excluded.updated",
                           (partner, data["available"], int(time.time())))
                result = {"saved": True}
            else:
                match = re.fullmatch(r"/api/partner/orders/([a-f0-9]{32})/(accept|pickup|deliver|location|undeliverable|problem)", path)
                if not match:
                    return self.json_response(404, {"error": "Unknown operation."})
                order_id, action = match.groups()
                result = {"saved": True}
                if action == "problem":
                    # A Bee Runner reports a problem on their own delivery. It becomes an admin ticket with a Runner source.
                    try:
                        support.check_rate(db, "ticket", "runner:" + partner, self.client_ip())
                        ticket = support.idempotent(db, f"runner:{partner}|{path}", self.headers.get("Idempotency-Key"), lambda: {
                            "ticketId": support.create_runner_ticket(db, partner, order_id, data.get("kind"), data.get("note") or "")})
                        support.record_rate(db, "ticket", "runner:" + partner, self.client_ip())
                    except support.RateLimited as error:
                        return self.json_response(429, {"error": str(error)})
                    except support.NotFound as error:
                        return self.json_response(404, {"error": str(error)})
                    except support.SupportError as error:
                        return self.json_response(400, {"error": str(error)})
                    number = f"SP-{ticket['ticketId']:05d}"
                    return self.json_response(200, {"saved": True, "ticket": number})
                if action == "accept":
                    if not db.execute(
                        "SELECT 1 FROM partner_availability WHERE partner=? AND available=1 AND updated>?",
                        (partner, int(time.time()) - 900),
                    ).fetchone():
                        raise ops.Conflict("Go online before accepting a delivery.")
                    if db.execute(
                        "SELECT 1 FROM deliveries JOIN orders ON orders.id=deliveries.order_id "
                        "WHERE partner=? AND status IN ('packed','out_for_delivery')", (partner,),
                    ).fetchone():
                        raise ops.Conflict("Finish your current delivery first.")
                    ops.assign_delivery(db, order_id, partner)
                elif action == "pickup":
                    ops.pickup(db, order_id, partner)
                elif action == "undeliverable":
                    ops.mark_undeliverable(db, order_id, partner, partner=partner)
                elif action == "deliver":
                    code = data["code"]
                    if not re.fullmatch(r"[0-9]{4}", code):
                        raise ValueError()
                    error = ops.deliver(db, order_id, partner, self.server.keys["delivery-code"].encode(), code)
                    if error:
                        result = {"error": error}
                else:
                    lat, lng = data["lat"], data["lng"]
                    if type(lat) not in (int, float) or type(lng) not in (int, float) or not (
                        -90 <= lat <= 90 and -180 <= lng <= 180
                    ):
                        raise ValueError()
                    db.execute("UPDATE deliveries SET lat=?, lng=?, located_at=? WHERE order_id=? AND partner=? "
                               "AND (located_at IS NULL OR located_at<=?) "
                               "AND EXISTS(SELECT 1 FROM orders WHERE id=? AND status='out_for_delivery')",
                               (lat, lng, int(time.time()), order_id, partner, int(time.time()) - 5, order_id))
        self.json_response(409 if "error" in result else 200, result)

    def refund_order(self, order_id):
        if self.server.payment_mode == "test":
            # Local test payments have no Razorpay record, so the refund completes immediately.
            with closing(connect()) as db, db:
                db.execute("BEGIN IMMEDIATE")
                row = db.execute("SELECT status FROM orders WHERE id=?", (order_id,)).fetchone()
                if not row or row["status"] not in ("paid", "undeliverable"):
                    raise ops.Conflict("Only a paid order that has not been delivered can be refunded.")
                db.execute("UPDATE orders SET status='refund_pending' WHERE id=?", (order_id,))
                ops.audit(db, "admin", "refund_requested", order_id)
                db.execute("UPDATE orders SET status='refunded' WHERE id=?", (order_id,))
                ops.audit(db, "checkout", "refund.processed", order_id)
            return self.json_response(200, {"state": "processed"})
        gateway = self.server.razorpay
        if not gateway:
            return self.json_response(503, {"error": "Razorpay is unavailable."})
        with closing(connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT status, amount, payment_id FROM orders JOIN razorpay_orders "
                "ON orders.id=razorpay_orders.order_id WHERE orders.id=?", (order_id,)
            ).fetchone()
            if not row or not row["payment_id"] or row["status"] not in ("paid", "undeliverable", "refund_pending"):
                raise ops.Conflict("Only a paid order that has not been delivered can be refunded.")
            if row["status"] in ("paid", "undeliverable"):
                db.execute("UPDATE orders SET status='refund_pending' WHERE id=?", (order_id,))
                db.execute("INSERT INTO razorpay_refunds(order_id,state) VALUES (?, 'requested')", (order_id,))
                ops.audit(db, "admin", "refund_requested", order_id)
        try:
            result = gateway.refund(row["payment_id"], "PB-R-" + order_id, row["amount"])
        except (OSError, ValueError, KeyError):
            return self.json_response(502, {"error": "Refund awaiting reconciliation. Retry from the dashboard."})
        with closing(connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            recorded = razorpay_checkout.record_refund(db, result)
            if recorded is False:
                raise ops.Conflict("Razorpay refund response needs reconciliation.")
            if recorded and result["status"] == "processed":
                ops.audit(db, "razorpay", "refund.processed", order_id)
            state = db.execute("SELECT state FROM razorpay_refunds WHERE order_id=?", (order_id,)).fetchone()["state"]
        self.json_response(200, {"state": state})

    def advance(self, order_id):
        role = self.get_role()
        if not role:
            return self.json_response(403, {"error": "Enter your staff key."})
        expected = self.headers.get("X-Order-Status", "")
        if role not in ("warehouse", "admin") or expected not in TRANSITIONS["warehouse"]:
            return self.json_response(409, {"error": "This action is unavailable."})
        with closing(connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            if expected == "printing":
                if not self.ready_printed_order(db, role, order_id):
                    row = db.execute("SELECT status FROM orders WHERE id=?", (order_id,)).fetchone()
                    if not row or row["status"] != "packed":
                        raise ops.Conflict("Complete every file before the order is ready for pickup.")
                next_status = "packed"
            else:
                next_status = advance_order(db, order_id, "warehouse", expected)
                if next_status:
                    ops.audit(db, role, next_status, order_id)
        if not next_status:
            return self.json_response(409, {"error": "The order changed. Refresh your list."})
        self.json_response(200, {"status": next_status})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4188)
    parser.add_argument("--show-staff-keys", action="store_true")
    args = parser.parse_args()
    payment_mode = os.environ.get("PRINTBEE_PAYMENT_MODE", "disabled")
    if payment_mode not in ("disabled", "test", "razorpay"):
        raise SystemExit("Set PRINTBEE_PAYMENT_MODE to disabled, test or razorpay.")
    if payment_mode == "test" and urlsplit(auth.public_origin()).hostname not in (None, "localhost", "127.0.0.1"):
        raise SystemExit("Test payments require a local origin.")
    gateway = razorpay_checkout.Razorpay.from_environment() if payment_mode == "razorpay" else None
    checkout_terms = configured_terms()
    bucket = os.environ.get("PRINTBEE_S3_BUCKET")
    keys = staff_keys()
    partners = json.loads(os.environ.get("PRINTBEE_PARTNER_KEYS", "{}"))
    phones = json.loads(os.environ.get("PRINTBEE_PARTNER_PHONES", "{}"))
    verify = partner_auth.Verify.from_environment()
    google_access = {
        role: {email.strip().lower(): role for email in
               os.environ.get("PRINTBEE_GOOGLE_" + role.upper() + "_EMAILS", "").split(",") if email.strip()}
        for role in ("warehouse", "admin")
    }
    google_partners = json.loads(os.environ.get("PRINTBEE_GOOGLE_PARTNERS", "{}"))
    if not isinstance(google_partners, dict) or any(
        "@" not in email or not isinstance(partner, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", partner)
        for email, partner in google_partners.items()
    ):
        raise SystemExit("Set PRINTBEE_GOOGLE_PARTNERS to a JSON object mapping emails to partner IDs.")
    google_access["partner"] = {email.strip().lower(): partner for email, partner in google_partners.items()}
    demo = os.environ.get("PRINTBEE_DEMO") == "1"
    if demo:
        if payment_mode != "test" or urlsplit(auth.public_origin()).hostname not in ("localhost", "127.0.0.1"):
            raise SystemExit("Demo mode is local-only: use PRINTBEE_PAYMENT_MODE=test and a local PRINTBEE_ORIGIN.")
        for user in DEMO_USERS.values():
            if user.get("portal") in ("admin", "warehouse"):
                google_access[user["portal"]][user["email"]] = user["portal"]
        for role in ("admin", "warehouse"):
            google_access[role]["all@demo.printbee.test"] = role
        google_access["partner"].update(DEMO_PARTNERS)
    if not isinstance(phones, dict) or any(
        not re.fullmatch(r"\+[1-9][0-9]{7,14}", phone) or not isinstance(name, str)
        or not re.fullmatch(r"[a-zA-Z0-9_-]{1,40}", name) or name == "delivery"
        for phone, name in phones.items()
    ) or len(set(phones.values())) != len(phones):
        raise SystemExit("Provide a unique partner ID for each enrolled E.164 phone number.")
    if not isinstance(partners, dict) or any(
        not re.fullmatch(r"[a-zA-Z0-9_-]{1,40}", name) or name == "delivery" or
        not isinstance(key, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{24,100}", key)
        for name, key in partners.items()
    ) or len(set(partners.values()) | set(keys.values())) != len(partners) + len(keys):
        raise SystemExit("Provide distinct, random partner tokens in PRINTBEE_PARTNER_KEYS.")
    if args.show_staff_keys:
        for role, key in keys.items():
            if role != "delivery-code":
                print(role.title(), key)
        raise SystemExit()
    with closing(connect()) as db, db:
        db.executescript(auth.SCHEMA)
        if "last_active" not in {column["name"] for column in db.execute("PRAGMA table_info(customer_sessions)")}:
            db.execute("ALTER TABLE customer_sessions ADD COLUMN last_active INTEGER")
        if "portal" not in {column["name"] for column in db.execute("PRAGMA table_info(google_portal_sessions)")}:
            db.execute("ALTER TABLE google_portal_sessions ADD COLUMN portal TEXT")
        db.executescript(razorpay_checkout.SCHEMA)
        db.executescript(ops.SCHEMA)
        db.executescript(admin_records.SCHEMA)
        support.install(db)
        buzz.install(db)
        google_access["partner"].update(admin_records.partner_accounts(db))
        google_access["warehouse"].update({email: "warehouse" for email in admin_records.warehouse_staff(db)})
        db.executescript(partner_auth.SCHEMA)
        db.executescript("""
            CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, token TEXT, status TEXT, details TEXT);
            CREATE TABLE IF NOT EXISTS files (
                order_id TEXT, position INTEGER, content BLOB, PRIMARY KEY (order_id, position)
            );
            CREATE TABLE IF NOT EXISTS order_owners (order_id TEXT PRIMARY KEY, email TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS order_owners_email ON order_owners(email);
        """)
        if "order_number" not in {column["name"] for column in db.execute("PRAGMA table_info(order_owners)")}:
            db.execute("ALTER TABLE order_owners ADD COLUMN order_number TEXT")
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS order_owners_number ON order_owners(order_number)")
        if "object_key" not in {column["name"] for column in db.execute("PRAGMA table_info(files)")}:
            db.execute("ALTER TABLE files ADD COLUMN object_key TEXT")
        order_status.install_guards(db)
        sample_email = os.environ.get("PRINTBEE_SAMPLE_ORDER_EMAIL", "").strip().lower()
        if sample_email and "@" in sample_email:   # opt-in: one finished sample order for a tester's Orders page
            order_id = hashlib.sha256(("sample-order:" + sample_email).encode()).hexdigest()[:32]
            if not db.execute("SELECT 1 FROM orders WHERE id=?", (order_id,)).fetchone():
                item = {"name": "Sample notes.pdf", "pages": 24, "copies": 1, "colour": False, "duplex": True,
                        "orientation": "Portrait", "binding": "spiral", "paper": "A4", "size": 0, "subtotal": 4800}
                details = {"customer": "Sample order", "phone": "", "address": "SRM University, Kattankulathur",
                           "items": [item], "subtotal": 4800, "bill": {"subtotal": 4800, "total": 9800}}
                db.execute("INSERT INTO orders VALUES (?, ?, 'pending', ?)", (order_id, "0" * 64, json.dumps(details)))
                for status in ("paid", "printing", "packed", "out_for_delivery", "delivered"):
                    db.execute("UPDATE orders SET status=? WHERE id=?", (status, order_id))
                db.execute("INSERT INTO order_owners (order_id, email, order_number) VALUES (?, ?, ?)",
                           (order_id, sample_email, "PB-SAMPLE-" + order_id[:6].upper()))
        active_email = os.environ.get("PRINTBEE_SAMPLE_ACTIVE_ORDER_EMAIL", "").strip().lower()
        if active_email and "@" in active_email:   # opt-in: one in-progress (printing) order for a tester's Orders page
            order_id = hashlib.sha256(("sample-active-order:" + active_email).encode()).hexdigest()[:32]
            if not db.execute("SELECT 1 FROM orders WHERE id=?", (order_id,)).fetchone():
                item = {"name": "Sample assignment.pdf", "pages": 12, "copies": 1, "colour": True, "duplex": False,
                        "orientation": "Portrait", "binding": "none", "paper": "A4", "size": 0, "subtotal": 9600}
                details = {"customer": "Sample order", "phone": "", "address": "SRM University, Kattankulathur",
                           "items": [item], "subtotal": 9600, "bill": {"subtotal": 9600, "total": 12600}}
                db.execute("INSERT INTO orders VALUES (?, ?, 'pending', ?)", (order_id, "0" * 64, json.dumps(details)))
                for status in ("paid", "printing"):
                    db.execute("UPDATE orders SET status=? WHERE id=?", (status, order_id))
                db.execute("INSERT INTO order_owners (order_id, email, order_number) VALUES (?, ?, ?)",
                           (order_id, active_email, "PB-ACTIVE-" + order_id[:6].upper()))
        eligible = ()
        if active_checkout_terms(db, checkout_terms).get("autoDispatch"):
            eligible = {"delivery", *partners, *phones.values(), *google_access["partner"].values()}
        ops.ready_printed_orders(db, "warehouse", eligible_partners=eligible)
    with ThreadingHTTPServer((args.host, args.port), PrintBee) as server:
        server.keys = keys
        server.google_access = google_access
        server.partners = {"delivery": keys["delivery"], **partners}
        server.partner_phones = phones
        server.partner_verify = verify
        server.payment_mode = payment_mode
        server.demo = demo
        server.razorpay = gateway
        server.checkout_terms = checkout_terms
        maps_key = os.environ.get("PRINTBEE_MAPS_BROWSER_KEY")
        maps_id = os.environ.get("PRINTBEE_MAPS_MAP_ID")
        server.maps = {"key": maps_key, "id": maps_id} if maps_key and maps_id else None
        server.files = PrivateFiles(bucket) if bucket else None
        print(f"PrintBee at http://{args.host}:{args.port}/ (payments: {payment_mode})", flush=True)
        server.serve_forever()

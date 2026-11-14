import argparse
import gzip
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
from urllib.parse import parse_qs, urlsplit
from http.cookies import CookieError, SimpleCookie
from threading import BoundedSemaphore

import customer_auth as auth
import fulfillment as ops
import partner_auth
import razorpay_checkout
from checkout_terms import bill_for, configured_terms, validate_terms
from document_pages import count_pages
from order_documents import PrivateFiles, invoice_pdf, packing_label_pdf
from order_rules import LIMIT, TRANSITIONS, advance_order, quote_items

ROOT = Path(__file__).resolve().parent
PRELOADER_BUNDLE = ROOT / "preloader-3d.bundle.js"
DATA = Path(os.environ.get("LOCALAPPDATA", ROOT.parent)) / "PrintBeeLocal"
DATA.mkdir(exist_ok=True)
DOCUMENT_READERS = BoundedSemaphore(2)


def connect():
    db = sqlite3.connect(DATA / "orders.sqlite", timeout=30)
    db.row_factory = sqlite3.Row
    return db


def staff_keys():
    path = DATA / "staff-keys.json"
    keys = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    updated = {**keys, **{role: secrets.token_urlsafe(24) for role in
                          ("warehouse", "delivery", "admin", "print-agent", "delivery-code")
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


class PrintBee(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def json_response(self, status, value, cookie=None):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def get_role(self):
        key = self.headers.get("X-Staff-Key", "").encode()
        return next((role for role, secret in self.server.keys.items()
                     if role != "delivery-code" and hmac.compare_digest(key, secret.encode())), None)

    def get_partner(self):
        key = self.headers.get("X-Staff-Key", "").encode()
        partner = next((name for name, secret in self.server.partners.items()
                        if hmac.compare_digest(key, secret.encode())), None)
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
        row = db.execute("SELECT terms FROM pricing_versions ORDER BY id DESC LIMIT 1").fetchone()
        return json.loads(row["terms"]) if row else self.server.checkout_terms

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
        if not config:
            return self.auth_redirect("/profile.html#google-unavailable")
        if path != auth.GOOGLE_CALLBACK:
            verifier = secrets.token_urlsafe(32)
            return self.auth_redirect(auth.google_authorization(config, verifier),
                                      auth.session_cookie(verifier, 600, auth.GOOGLE_COOKIE))
        clear = auth.session_cookie("", 0, auth.GOOGLE_COOKIE)
        try:
            cookie = SimpleCookie(self.headers.get("Cookie", "")).get(auth.GOOGLE_COOKIE)
            query = parse_qs(urlsplit(self.path).query, max_num_fields=20)
            verifier = cookie.value if cookie else ""
            if (not re.fullmatch(r"[A-Za-z0-9_-]{43}", verifier)
                    or not hmac.compare_digest(query.get("state", [""])[0].encode(),
                                               auth.digest("state:" + verifier).encode())):
                raise ValueError("Invalid Google sign-in state")
            email = auth.google_email(config, query["code"][0], verifier)
            with closing(connect()) as db, db:
                session = auth.create_session(db, email, auth.session_token(self.headers))
        except (CookieError, OSError, ValueError, KeyError, TypeError):
            return self.auth_redirect("/profile.html#google-failed", clear)
        return self.auth_redirect("/", clear, session)

    def end_headers(self):
        # Revalidate page markup so all pages use the current navigation.
        path = urlsplit(self.path).path
        if path == "/" or path.endswith(".html"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        path = urlsplit(self.path).path
        pages = {"/warehouse": "/staff.html", "/partner": "/partner.html", "/admin": "/admin.html"}
        if path in pages:
            return self.auth_redirect(pages[path])
        if path in ("/api/auth/google", auth.GOOGLE_CALLBACK):
            return self.google_sign_in(path)
        if path == "/api/auth/session":
            with closing(connect()) as db:
                return self.json_response(200, {"email": auth.session_email(db, self.headers)})
        if path == "/api/checkout":
            terms = {key: value for key, value in self.checkout_terms().items() if key != "coupons"}
            return self.json_response(200, {"mode": self.server.payment_mode, "terms": terms,
                                           "maps": self.server.maps})
        if not path.startswith("/api/"):
            allowed = {"/", "/index.html", "/studio.js", "/studio.css", "/clay.css", "/staff.html", "/staff.js", "/delivery-map.js",
                       "/partner.html", "/admin.html", "/operations.js", "/partner.webmanifest",
                       "/pricing.html", "/queue.html", "/orders.html", "/profile.html", "/profile.js", "/address.html", "/customer-login.js",
                       "/preloader.js", "/preloader.css", "/preloader-art.js", "/gsap-3.13.0.min.js"}
            if path == "/preloader-3d.bundle.js" and self.server.preloader_gzip:
                encodings = self.headers.get("Accept-Encoding", "").lower().split(",")
                if any(encoding.strip() == "gzip" for encoding in encodings):
                    self.send_response(200)
                    self.send_header("Content-Type", "text/javascript")
                    self.send_header("Content-Encoding", "gzip")
                    self.send_header("Vary", "Accept-Encoding")
                    self.send_header("Content-Length", str(len(self.server.preloader_gzip)))
                    self.end_headers()
                    self.wfile.write(self.server.preloader_gzip)
                    return
            if (path in allowed or path == "/preloader-3d.bundle.js"
                    or re.fullmatch(r"/public/models/(bee_main|paper_sheet|bee_mini)\.glb", path)
                    or re.fullmatch(r"/public/draco/(draco_decoder\.(js|wasm)|draco_wasm_wrapper\.js)", path)):
                return super().do_GET()
            if re.fullmatch(r"/[a-z0-9.-]+\.(png|webp|woff2)", path):
                return super().do_GET()
            return self.send_error(404)
        match = re.fullmatch(r"/api/orders/([a-f0-9]{32})/events", path)
        if match:
            return self.order_events(match[1])
        with closing(connect()) as db:
            if path == "/api/admin":
                return self.admin_snapshot(db)
            if path == "/api/partner/orders":
                return self.partner_orders(db)
            if path == "/api/partner/auth":
                return self.json_response(200, {"sms": bool(self.server.partner_verify),
                                                "signedIn": bool(self.get_partner())})
            label = re.fullmatch(r"/api/staff/orders/([a-f0-9]{32})/label", path)
            if label and self.get_role() == "warehouse":
                row = db.execute(
                    "SELECT details, order_number FROM orders LEFT JOIN order_owners "
                    "ON orders.id=order_owners.order_id WHERE orders.id=? AND status='packed'", label.groups()
                ).fetchone()
                if row:
                    number = row["order_number"] or "PB-" + label[1][:8].upper()
                    body = packing_label_pdf(number, json.loads(row["details"]))
                    return self.send_download(body, "application/pdf", f'attachment; filename="{number}-packing.pdf"')
            match = re.fullmatch(r"/api/print-agent/jobs/(\d+)/file", path)
            if match and self.get_role() == "print-agent":
                row = db.execute(
                    "SELECT content, object_key FROM print_jobs JOIN files ON files.order_id=print_jobs.order_id "
                    "AND files.position=print_jobs.position WHERE print_jobs.id=? AND state='printing' AND worker=?",
                    (match[1], self.headers.get("X-Print-Claim", ""))
                ).fetchone()
                if row:
                    return self.send_file(row)
            if path == "/api/orders":
                email = auth.session_email(db, self.headers)
                if not email:
                    return self.json_response(401, {"error": "Sign in to see your orders."})
                rows = db.execute(
                    "SELECT orders.id, status, details, order_number FROM order_owners JOIN orders "
                    "ON orders.id=order_owners.order_id WHERE email=? AND status!='pending' "
                    "ORDER BY orders.rowid DESC", (email,)
                )
                return self.json_response(200, {"orders": [
                    {"id": row["id"], "number": row["order_number"], "status": row["status"],
                     "items": [{key: item[key] for key in (
                         "name", "pages", "copies", "colour", "duplex", "orientation",
                         "binding", "colourPages", "pageRange", "paper"
                     ) if key in item} for item in json.loads(row["details"])["items"]]}
                    for row in rows
                ]})
            if path == "/api/staff/orders":
                role = self.get_role()
                if role != "warehouse":
                    return self.json_response(403, {"error": "Enter your staff key."})
                states = ("paid", "printing", "packed")
                rows = db.execute(
                    "SELECT orders.id, status, details, order_number FROM orders LEFT JOIN order_owners "
                    "ON orders.id=order_owners.order_id WHERE status IN (?, ?, ?) ORDER BY orders.rowid DESC", states
                )
                jobs = {}
                for job in db.execute("SELECT id, order_id, position, state, error FROM print_jobs"):
                    jobs.setdefault(job["order_id"], []).append(dict(job))
                agent = db.execute("SELECT seen FROM workstations WHERE role='print-agent'").fetchone()
                return self.json_response(200, {"role": role, "agentOnline": bool(agent and agent["seen"] > time.time() - 180),
                                               "orders": [
                    {"id": row["id"], "number": row["order_number"], "status": row["status"],
                     "jobs": jobs.get(row["id"], []),
                     **json.loads(row["details"])} for row in rows
                ]})
            match = re.fullmatch(r"/api/orders/([a-f0-9]{32})", path)
            if match:
                row = db.execute(
                    "SELECT status, token, email, provider_id, order_number FROM orders LEFT JOIN order_owners "
                    "ON orders.id=order_owners.order_id LEFT JOIN razorpay_orders "
                    "ON orders.id=razorpay_orders.order_id WHERE orders.id=?", match.groups()
                ).fetchone()
                token = self.headers.get("X-Order-Key", "")
                share = self.headers.get("X-Tracking-Key", "")
                owner = row and row["email"] and row["email"] == auth.session_email(db, self.headers)
                if row and (
                    hmac.compare_digest(row["token"].encode(), token.encode())
                    or (row["status"] != "pending" and (
                        owner or hmac.compare_digest(self.tracking_key(match[1]).encode(), share.encode())
                    ))
                ):
                    result = {"status": row["status"], "number": row["order_number"],
                              "paymentStarted": bool(row["provider_id"])}
                    if owner:
                        result["delivery"] = self.customer_delivery(db, match[1], row["status"])
                        if row["status"] != "pending":
                            result["trackingKey"] = self.tracking_key(match[1])
                    return self.json_response(200, result)
            match = re.fullmatch(r"/api/staff/files/([a-f0-9]{32})/(\d+)", path)
            if match and self.get_role() == "warehouse":
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
            if path in ("/api/partner/auth/send", "/api/partner/auth/check", "/api/partner/auth/logout"):
                return self.verify_partner_phone(path.rsplit("/", 1)[1])
            if path.startswith(("/api/print-agent/", "/api/partner/", "/api/admin/")):
                return self.operations_post(path)
            match = re.fullmatch(r"/api/staff/orders/([a-f0-9]{32})/print/(all|\d+)", path)
            if match:
                return self.queue_print(*match.groups())
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
                return self.json_response(*auth.request_link(db, data["email"]))
            if path == "/api/auth/verify":
                result = auth.redeem(db, data["token"], auth.session_token(self.headers))
                if result:
                    email, cookie = result
                    return self.json_response(200, {"email": email}, cookie)
                return self.json_response(400, {"error": "This link has expired or was already used. Request a new one."})
            if path == "/api/auth/logout":
                with db:
                    db.execute("DELETE FROM customer_sessions WHERE digest=?",
                               (auth.digest(auth.session_token(self.headers)),))
                return self.json_response(200, {"email": None}, auth.session_cookie("", 0))
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
        terms = self.checkout_terms()
        documents, total = quote_items(data["items"], terms["paperRates"], terms["bindingRates"])
        coupon = data.get("coupon", "").strip().upper()
        notes = data.get("notes", "").strip()
        slot = data.get("slot", "")
        if len(notes) > 500 or not isinstance(slot, str) or len(coupon) > 30:
            raise ValueError()
        details.update(items=documents, subtotal=total)
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
                if stored != details:
                    return self.json_response(409, {"error": "Order details changed. Reopen checkout to try again."})
            else:
                if (terms["slots"] or slot) and slot not in terms["slots"]:
                    return self.json_response(409, {"error": "Choose an available delivery slot."})
                if coupon and coupon not in terms["coupons"]:
                    return self.json_response(409, {"error": "This coupon is unavailable."})
                binding_total = sum(terms["bindingRates"][item["binding"]] * item["copies"] for item in documents)
                bill = bill_for(total, binding_total, coupon, terms)
                if type(data.get("expectedTotal")) is not int or data["expectedTotal"] != bill["total"]:
                    return self.json_response(409, {"error": "Prices changed. Refresh and review your order."})
                encoded = json.dumps({**details, "bill": bill}, sort_keys=True)
                db.execute("INSERT INTO orders VALUES (?, ?, 'pending', ?)", (order_id, token, encoded))
                db.execute("INSERT INTO order_owners (order_id, email, order_number) VALUES (?, ?, ?)",
                           (order_id, email, order_number(db)))
        self.json_response(200, {"subtotal": total, "total": bill["total"] if bill else total})

    def checkout_quote(self):
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 65536:
            raise ValueError("Invalid quote length.")
        data = json.loads(self.rfile.read(length))
        coupon = data.get("coupon", "").strip().upper()
        terms = self.checkout_terms()
        documents, total = quote_items(data["items"], terms["paperRates"], terms["bindingRates"])
        if coupon and coupon not in terms["coupons"]:
            return self.json_response(400, {"error": "This coupon is unavailable."})
        binding_total = sum(terms["bindingRates"][item["binding"]] * item["copies"] for item in documents)
        bill = bill_for(total, binding_total, coupon, terms)
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
                recorded = razorpay_checkout.record_capture(db, event["payload"]["payment"]["entity"])
            else:
                refund = event["payload"]["refund"]["entity"]
                if razorpay_checkout.record_refund(db, refund):
                    ops.audit(db, "razorpay", event_type, refund["receipt"][5:])
                recorded = None
        if recorded is False:
            return self.json_response(409, {"error": "Payment does not match the order."})
        self.json_response(200, {"received": True})

    def queue_print(self, order_id, selection):
        if self.get_role() != "warehouse":
            return self.json_response(403, {"error": "Warehouse access is required."})
        with closing(connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            positions = ([row["position"] for row in db.execute(
                "SELECT position FROM files WHERE order_id=?", (order_id,)
            )] if selection == "all" else [int(selection)])
            queued = sum(ops.queue_job(db, order_id, position) for position in positions)
        return self.json_response(200, {"queued": queued})

    def confirm_manual_print(self, order_id, position):
        if self.get_role() != "warehouse":
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
            ops.audit(db, "warehouse", "printed_manually", order_id)
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
            if row["partner"] and row["status"] != "delivered":
                details = json.loads(row["details"])
                record.update({key: details.get(key) for key in ("customer", "address", "phone", "slot", "notes")})
            orders.append(record)
        availability = db.execute("SELECT available, updated FROM partner_availability WHERE partner=?",
                                  (partner,)).fetchone()
        return self.json_response(200, {"orders": orders, "available": bool(
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
        if status != "out_for_delivery":
            return None
        row = db.execute("SELECT * FROM deliveries WHERE order_id=?", (order_id,)).fetchone()
        if not row:
            return None
        delivery = {}
        if row["nonce"] and row["expires"] > time.time() and row["attempts"] < 3:
            delivery["code"] = ops.delivery_code(self.server.keys["delivery-code"].encode(), row["nonce"])
        if row["located_at"] and row["located_at"] > time.time() - 300:
            delivery["location"] = [row["lat"], row["lng"]]
        return delivery

    def admin_snapshot(self, db):
        if self.get_role() != "admin":
            return self.json_response(403, {"error": "Admin access is required."})
        orders = [dict(row) for row in db.execute(
            "SELECT orders.id, status, order_number, CAST(COALESCE(json_extract(details,'$.bill.total'), "
            "json_extract(details,'$.subtotal')) AS INTEGER) AS total, payment_id IS NOT NULL AS captured "
            "FROM orders LEFT JOIN order_owners ON orders.id=order_owners.order_id "
            "LEFT JOIN razorpay_orders ON orders.id=razorpay_orders.order_id ORDER BY orders.rowid DESC LIMIT 500"
        )]
        counts = {row["status"]: row["count"] for row in db.execute(
            "SELECT status, count(*) AS count FROM orders GROUP BY status"
        )}
        captured = db.execute("SELECT COALESCE(sum(amount),0) FROM razorpay_orders WHERE payment_id IS NOT NULL").fetchone()[0]
        history = [dict(row) for row in db.execute(
            "SELECT actor, action, order_id, created FROM audit ORDER BY id DESC LIMIT 50"
        )]
        return self.json_response(200, {"orders": orders, "counts": counts, "captured": captured,
                                        "terms": self.checkout_terms(db), "audit": history})

    def operations_post(self, path):
        area = path.split("/")[2]
        role = {"admin": "admin", "partner": "delivery", "print-agent": "print-agent"}[area]
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
            if path == "/api/admin/pricing":
                terms = validate_terms({**data, "bindingRates": {
                    key: rate for key, rate in data.get("bindingRates", {}).items() if key != "none"
                }})
                cursor = db.execute("INSERT INTO pricing_versions(terms, created) VALUES (?,?)",
                                    (json.dumps(terms), int(time.time())))
                ops.audit(db, role, "pricing_updated")
                result = {"version": cursor.lastrowid}
            elif role == "admin" and (reset := re.fullmatch(r"/api/admin/orders/([a-f0-9]{32})/renew-code", path)):
                ops.renew_delivery_code(db, reset[1])
                result = {"saved": True}
            elif role == "admin" and (cancel := re.fullmatch(r"/api/admin/orders/([a-f0-9]{32})/cancel", path)):
                ops.cancel_order(db, cancel[1])
                result = {"saved": True}
            elif role == "admin" and (recover := re.fullmatch(r"/api/admin/print-jobs/(\d+)/recover", path)):
                row = db.execute("UPDATE print_jobs SET state='failed', error='Recovered by admin' "
                                 "WHERE id=? AND state='printing' RETURNING order_id", (int(recover[1]),)).fetchone()
                if not row:
                    raise ops.Conflict("This job is no longer active.")
                ops.audit(db, role, "print_job_recovered", row["order_id"])
                result = {"saved": True}
            elif path == "/api/print-agent/claim":
                db.execute("INSERT INTO workstations VALUES (?,?) ON CONFLICT(role) DO UPDATE SET seen=excluded.seen",
                           (role, int(time.time())))
                claim = secrets.token_urlsafe(24)
                row = ops.claim_job(db, claim)
                result = {"job": None}
                if row:
                    details = db.execute("SELECT details FROM orders WHERE id=?", (row["order_id"],)).fetchone()
                    result["job"] = {"id": row["id"], "claim": claim,
                                     "item": json.loads(details["details"])["items"][row["position"]]}
            elif re.fullmatch(r"/api/print-agent/jobs/\d+/result", path):
                state = data["state"]
                if state not in ("done", "failed"):
                    raise ValueError()
                if not ops.finish_job(db, int(path.split("/")[4]), self.headers.get("X-Print-Claim", ""),
                                      state, str(data.get("error", ""))[:300]):
                    raise ops.Conflict("This print job is no longer active.")
                result = {"saved": True}
            elif path == "/api/partner/availability":
                if type(data.get("available")) is not bool:
                    raise ValueError()
                db.execute("INSERT INTO partner_availability VALUES (?,?,?) ON CONFLICT(partner) DO UPDATE "
                           "SET available=excluded.available, updated=excluded.updated",
                           (partner, data["available"], int(time.time())))
                result = {"saved": True}
            else:
                match = re.fullmatch(r"/api/partner/orders/([a-f0-9]{32})/(accept|pickup|deliver|location)", path)
                if not match:
                    return self.json_response(404, {"error": "Unknown operation."})
                order_id, action = match.groups()
                result = {"saved": True}
                if action == "accept":
                    ops.assign_delivery(db, order_id, partner)
                elif action == "pickup":
                    ops.pickup(db, order_id, partner)
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
                               "AND EXISTS(SELECT 1 FROM orders WHERE id=? AND status='out_for_delivery')",
                               (lat, lng, int(time.time()), order_id, partner, order_id))
        self.json_response(409 if "error" in result else 200, result)

    def refund_order(self, order_id):
        gateway = self.server.razorpay
        if not gateway:
            return self.json_response(503, {"error": "Razorpay is unavailable."})
        with closing(connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT status, amount, payment_id FROM orders JOIN razorpay_orders "
                "ON orders.id=razorpay_orders.order_id WHERE orders.id=?", (order_id,)
            ).fetchone()
            if not row or not row["payment_id"] or row["status"] not in ("paid", "refund_pending"):
                raise ops.Conflict("Only a paid, unprinted order can be refunded.")
            if row["status"] == "paid":
                db.execute("UPDATE orders SET status='refund_pending' WHERE id=?", (order_id,))
                db.execute("INSERT INTO razorpay_refunds(order_id,state) VALUES (?, 'requested')", (order_id,))
                ops.audit(db, "admin", "refund_requested", order_id)
        try:
            result = gateway.refund(row["payment_id"], "PB-R-" + order_id, row["amount"])
        except (OSError, ValueError, KeyError):
            return self.json_response(502, {"error": "Refund awaiting reconciliation. Retry from the dashboard."})
        with closing(connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            if razorpay_checkout.record_refund(db, result) is False:
                raise ops.Conflict("Razorpay refund response needs reconciliation.")
            state = db.execute("SELECT state FROM razorpay_refunds WHERE order_id=?", (order_id,)).fetchone()["state"]
        self.json_response(200, {"state": state})

    def advance(self, order_id):
        role = self.get_role()
        if not role:
            return self.json_response(403, {"error": "Enter your staff key."})
        expected = self.headers.get("X-Order-Status", "")
        if role != "warehouse" or expected not in TRANSITIONS["warehouse"]:
            return self.json_response(409, {"error": "This action is unavailable."})
        with closing(connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            if expected == "printing" and db.execute(
                "SELECT 1 FROM files LEFT JOIN print_jobs ON print_jobs.order_id=files.order_id "
                "AND print_jobs.position=files.position WHERE files.order_id=? "
                "AND (print_jobs.state IS NULL OR print_jobs.state!='done')", (order_id,)
            ).fetchone():
                raise ops.Conflict("Finish or confirm every file before packing.")
            next_status = advance_order(db, order_id, role, expected)
            if next_status:
                ops.audit(db, role, next_status, order_id)
                if next_status == "packed" and self.checkout_terms(db).get("autoDispatch"):
                    ops.dispatch_available(db, order_id, set(self.server.partners) | set(self.server.partner_phones.values()))
        if not next_status:
            return self.json_response(409, {"error": "The order changed. Refresh your list."})
        self.json_response(200, {"status": next_status})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
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
        db.executescript(razorpay_checkout.SCHEMA)
        db.executescript(ops.SCHEMA)
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
    with ThreadingHTTPServer(("127.0.0.1", args.port), PrintBee) as server:
        server.keys = keys
        server.partners = {"delivery": keys["delivery"], **partners}
        server.partner_phones = phones
        server.partner_verify = verify
        server.payment_mode = payment_mode
        server.razorpay = gateway
        server.checkout_terms = checkout_terms
        maps_key = os.environ.get("PRINTBEE_MAPS_BROWSER_KEY")
        maps_id = os.environ.get("PRINTBEE_MAPS_MAP_ID")
        server.maps = {"key": maps_key, "id": maps_id} if maps_key and maps_id else None
        server.files = PrivateFiles(bucket) if bucket else None
        server.preloader_gzip = gzip.compress(PRELOADER_BUNDLE.read_bytes()) if PRELOADER_BUNDLE.is_file() else None
        print(f"PrintBee at http://127.0.0.1:{args.port}/ (payments: {payment_mode})", flush=True)
        server.serve_forever()

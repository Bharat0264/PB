import argparse
import gzip
import hmac
import json
import os
import re
import secrets
import sqlite3
from contextlib import closing
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from http.cookies import CookieError, SimpleCookie
from threading import BoundedSemaphore

import customer_auth as auth
import razorpay_checkout
from checkout_terms import bill_for, configured_terms
from document_pages import count_pages
from order_documents import PrivateFiles, invoice_pdf
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
    if not path.exists():
        path.write_text(json.dumps({role: secrets.token_urlsafe(24) for role in TRANSITIONS}), encoding="utf-8")
    return json.loads(path.read_text(encoding="utf-8"))


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
        key = self.headers.get("X-Staff-Key", "")
        return next((role for role, secret in self.server.keys.items() if hmac.compare_digest(key, secret)), None)

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
        if path in ("/api/auth/google", auth.GOOGLE_CALLBACK):
            return self.google_sign_in(path)
        if path == "/api/auth/session":
            with closing(connect()) as db:
                return self.json_response(200, {"email": auth.session_email(db, self.headers)})
        if path == "/api/checkout":
            terms = {key: value for key, value in self.server.checkout_terms.items() if key != "coupons"}
            return self.json_response(200, {"mode": self.server.payment_mode, "terms": terms,
                                           "maps": self.server.maps})
        if not path.startswith("/api/"):
            allowed = {"/", "/index.html", "/studio.js", "/studio.css", "/clay.css", "/staff.html", "/staff.js", "/delivery-map.js",
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
        with closing(connect()) as db:
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
                if not role:
                    return self.json_response(403, {"error": "Enter your staff key."})
                states = ("paid", "printing", "packed") if role == "warehouse" else ("packed", "out_for_delivery", "delivered")
                rows = db.execute(
                    "SELECT orders.id, status, details, order_number FROM orders LEFT JOIN order_owners "
                    "ON orders.id=order_owners.order_id WHERE status IN (?, ?, ?) ORDER BY orders.rowid DESC", states
                )
                return self.json_response(200, {"role": role, "orders": [
                    {"id": row["id"], "number": row["order_number"], "status": row["status"],
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
                if row and (
                    hmac.compare_digest(row["token"], token)
                    or (row["email"] and row["email"] == auth.session_email(db, self.headers)
                        and row["status"] != "pending")
                ):
                    return self.json_response(200, {"status": row["status"], "number": row["order_number"],
                                                    "paymentStarted": bool(row["provider_id"])})
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
        terms = self.server.checkout_terms
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
        terms = self.server.checkout_terms
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
        if event["event"] != "payment.captured":
            return self.json_response(200, {"received": True})
        with closing(connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            recorded = razorpay_checkout.record_capture(db, event["payload"]["payment"]["entity"])
        if recorded is False:
            return self.json_response(409, {"error": "Payment does not match the order."})
        self.json_response(200, {"received": True})

    def advance(self, order_id):
        role = self.get_role()
        if not role:
            return self.json_response(403, {"error": "Enter your staff key."})
        expected = self.headers.get("X-Order-Status", "")
        if expected not in TRANSITIONS[role]:
            return self.json_response(409, {"error": "This action is unavailable."})
        with closing(connect()) as db, db:
            next_status = advance_order(db, order_id, role, expected)
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
    if args.show_staff_keys:
        for role, key in keys.items():
            print(role.title(), key)
        raise SystemExit()
    with closing(connect()) as db, db:
        db.executescript(auth.SCHEMA)
        db.executescript(razorpay_checkout.SCHEMA)
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

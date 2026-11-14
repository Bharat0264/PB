import argparse
import gzip
import hmac
import json
import os
import re
import secrets
import sqlite3
from contextlib import closing
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from http.cookies import CookieError, SimpleCookie

import customer_auth as auth

ROOT = Path(__file__).resolve().parent
PRELOADER_BUNDLE = ROOT / "preloader-3d.bundle.js"
DATA = Path(os.environ.get("LOCALAPPDATA", ROOT.parent)) / "PrintBeeLocal"
DATA.mkdir(exist_ok=True)
RATES = (175, 300, 850, 1400)
BINDING_RATES = {"none": 0, "glossy": 5000, "blue": 4000}
LIMIT = 50 * 1024 * 1024
TRANSITIONS = {
    "warehouse": {"paid": "printing", "printing": "packed"},
    "delivery": {"packed": "out_for_delivery", "out_for_delivery": "delivered"},
}


def connect():
    db = sqlite3.connect(DATA / "orders.sqlite", timeout=30)
    db.row_factory = sqlite3.Row
    return db


def staff_keys():
    path = DATA / "staff-keys.json"
    if not path.exists():
        path.write_text(json.dumps({role: secrets.token_urlsafe(24) for role in TRANSITIONS}), encoding="utf-8")
    return json.loads(path.read_text(encoding="utf-8"))


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

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ("/api/auth/google", auth.GOOGLE_CALLBACK):
            return self.google_sign_in(path)
        if path == "/api/auth/session":
            with closing(connect()) as db:
                return self.json_response(200, {"email": auth.session_email(db, self.headers)})
        if not path.startswith("/api/"):
            allowed = {"/", "/index.html", "/studio.js", "/studio.css", "/staff.html", "/staff.js",
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
            if path == "/api/staff/orders":
                role = self.get_role()
                if not role:
                    return self.json_response(403, {"error": "Enter your staff key."})
                states = ("paid", "printing", "packed") if role == "warehouse" else ("packed", "out_for_delivery", "delivered")
                rows = db.execute(
                    "SELECT id, status, details FROM orders WHERE status IN (?, ?, ?) ORDER BY rowid DESC", states
                )
                return self.json_response(200, {"role": role, "orders": [
                    {"id": row["id"], "status": row["status"], **json.loads(row["details"])} for row in rows
                ]})
            match = re.fullmatch(r"/api/orders/([a-f0-9]{32})", path)
            if match:
                row = db.execute("SELECT id, status, token FROM orders WHERE id=?", match.groups()).fetchone()
                token = self.headers.get("X-Order-Key", "")
                if row and hmac.compare_digest(row["token"], token):
                    return self.json_response(200, {"status": row["status"]})
            match = re.fullmatch(r"/api/staff/files/([a-f0-9]{32})/(\d+)", path)
            if match and self.get_role() == "warehouse":
                row = db.execute("SELECT content FROM files JOIN orders ON orders.id=files.order_id "
                                 "WHERE order_id=? AND position=? AND status IN ('paid','printing','packed')",
                                 match.groups()).fetchone()
                if row:
                    body = row["content"]
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Disposition", "attachment")
                    self.send_header("X-Content-Type-Options", "nosniff")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
        self.json_response(404, {"error": "Order or file unavailable."})

    def do_POST(self):
        path = urlsplit(self.path).path
        try:
            if path.startswith("/api/auth/"):
                return self.customer_auth(path)
            if path == "/api/orders":
                with closing(connect()) as db:
                    email = auth.session_email(db, self.headers)
                if not email:
                    self.close_connection = True
                    return self.json_response(401, {"error": "Sign in by email from your Profile before placing an order."})
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 65536:
                    raise ValueError("Invalid order details.")
                return self.create_order(json.loads(self.rfile.read(length)))
            match = re.fullmatch(r"/api/orders/([a-f0-9]{32})/files/(\d+)", path)
            if match:
                return self.upload(*match.groups())
            match = re.fullmatch(r"/api/orders/([a-f0-9]{32})/test-payment", path)
            if match:
                return self.pay(match[1])
            match = re.fullmatch(r"/api/staff/orders/([a-f0-9]{32})/advance", path)
            if match:
                return self.advance(match[1])
            self.json_response(404, {"error": "Unknown request."})
        except (ValueError, KeyError, TypeError):
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

    def create_order(self, data):
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
        items = data["items"]
        if not 1 <= len(items) <= 100:
            raise ValueError()
        total = 0
        documents = []
        for item in items:
            pages, copies, size = (item[key] for key in ("pages", "copies", "size"))
            colour, duplex = item["colour"], item["duplex"]
            if not (type(pages) is type(copies) is type(size) is int and 1 <= pages <= 10000
                    and 1 <= copies <= 100 and 1 <= size <= LIMIT and type(colour) is type(duplex) is bool
                    and item["orientation"] in ("Portrait", "Landscape") and 1 <= len(item["name"]) <= 255):
                raise ValueError()
            binding = item.get("binding", "none")
            selected = item.get("colourPages")
            if binding not in BINDING_RATES:
                raise ValueError()
            if selected is not None and (
                colour or not isinstance(selected, list) or not selected or
                any(type(page) is not int or not 1 <= page <= pages for page in selected) or
                len(set(selected)) != len(selected)
            ):
                raise ValueError()
            colour_count = len(selected) if selected is not None else pages if colour else 0
            subtotal = copies * ((pages - colour_count) * RATES[duplex]
                                 + colour_count * RATES[2 + duplex] + BINDING_RATES[binding])
            total += subtotal
            documents.append({key: item[key] for key in (
                "name", "size", "pages", "copies", "colour", "duplex", "orientation"
            )} | {"subtotal": subtotal, "binding": binding, "colourPages": selected})
        details.update(items=documents, subtotal=total)
        encoded = json.dumps(details, sort_keys=True)
        with closing(connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT token, details FROM orders WHERE id=?", (order_id,)).fetchone()
            if existing and (not hmac.compare_digest(token, existing["token"]) or existing["details"] != encoded):
                return self.json_response(409, {"error": "Order details changed. Reopen checkout to try again."})
            if not existing:
                db.execute("INSERT INTO orders VALUES (?, ?, 'pending', ?)", (order_id, token, encoded))
        self.json_response(200, {"subtotal": total})

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
            with db:
                db.execute("BEGIN IMMEDIATE")
                if self.customer_order(db, order_id)["status"] != "pending":
                    return self.json_response(409, {"error": "Payment was already recorded."})
                db.execute("INSERT OR REPLACE INTO files VALUES (?, ?, ?)", (order_id, position, body))
        self.json_response(200, {"saved": True})

    def customer_order(self, db, order_id):
        row = db.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
        if row and hmac.compare_digest(row["token"], self.headers.get("X-Order-Key", "")):
            return row
        return None

    def pay(self, order_id):
        with closing(connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = self.customer_order(db, order_id)
            if not row:
                return self.json_response(404, {"error": "Order unavailable."})
            status = row["status"]
            if status == "pending":
                count = db.execute("SELECT count(*) FROM files WHERE order_id=?", (order_id,)).fetchone()[0]
                if count != len(json.loads(row["details"])["items"]):
                    return self.json_response(409, {"error": "Upload all files before payment."})
                db.execute("UPDATE orders SET status='paid' WHERE id=?", (order_id,))
                status = "paid"
        self.json_response(200, {"status": status})

    def advance(self, order_id):
        role = self.get_role()
        if not role:
            return self.json_response(403, {"error": "Enter your staff key."})
        expected = self.headers.get("X-Order-Status", "")
        next_status = TRANSITIONS[role].get(expected)
        if not next_status:
            return self.json_response(409, {"error": "This action is unavailable."})
        with closing(connect()) as db, db:
            changed = db.execute("UPDATE orders SET status=? WHERE id=? AND status=?",
                                 (next_status, order_id, expected)).rowcount
        if not changed:
            return self.json_response(409, {"error": "The order changed. Refresh your list."})
        self.json_response(200, {"status": next_status})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=4188)
    parser.add_argument("--show-staff-keys", action="store_true")
    args = parser.parse_args()
    keys = staff_keys()
    if args.show_staff_keys:
        for role, key in keys.items():
            print(role.title(), key)
        raise SystemExit()
    with closing(connect()) as db, db:
        db.executescript(auth.SCHEMA)
        db.executescript("""
            CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, token TEXT, status TEXT, details TEXT);
            CREATE TABLE IF NOT EXISTS files (
                order_id TEXT, position INTEGER, content BLOB, PRIMARY KEY (order_id, position)
            );
        """)
    with ThreadingHTTPServer(("127.0.0.1", args.port), PrintBee) as server:
        server.keys = keys
        server.preloader_gzip = gzip.compress(PRELOADER_BUNDLE.read_bytes()) if PRELOADER_BUNDLE.is_file() else None
        print(f"PrintBee test checkout at http://127.0.0.1:{args.port}/", flush=True)
        server.serve_forever()

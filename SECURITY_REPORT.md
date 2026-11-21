# PrintBee security report

Audit date: 2026-11-21. Type: read-only code audit plus a few safe checks against a throwaway **local** server (port 4195, temporary data folder, deleted afterwards). **No code was changed.** The live site and all third-party services (Razorpay, Google, Twilio, S3, Gemini) were not attacked or tested.

No real secrets were found, so nothing had to be masked in this report.

## 1. Executive summary

**Overall risk: 3 out of 10** (10 = worst). In plain words: the app is built more carefully than most small projects. The common big problems (SQL injection, cross-site scripting, leaked keys, open admin pages, trusting the browser for prices) are **not** present. What is left is mostly about **availability** (someone can block sign-ins or fill the disk), **missing hardening** (no enforced Content-Security-Policy, no connection timeouts) and a few **small information leaks**.

| Severity | Count |
| --- | --- |
| Critical | 0 |
| High | 1 |
| Medium | 5 |
| Low | 8 |
| Info | 3 |

The single most important fix: **one person can stop every new customer from signing in** with about 50 requests (F-01). It was reproduced locally.

### What the audit covered
Stack: plain Python 3 standard-library web server (`server.py`, about 2,000 lines) with SQLite, vanilla HTML/CSS/JS pages, Docker image deployed on Render. Integrations: Razorpay (payments), Google sign-in (staff portals and customers), email sign-in links (SMTP), Twilio Verify (delivery partner SMS), S3-compatible file storage (optional), Google Maps (browser key), Gemini (optional chatbot, off by default), LibreOffice (optional, to count DOCX pages).

Routes: 3 public pages families (welcome, customer app, pricing/terms), 3 staff portals (`/warehouse`, `/partner`, `/admin`), and about 60 API endpoints under `/api/` (auth, checkout, orders, uploads, support tickets, Buzz chat, partner operations, admin, Razorpay webhook, live events). Forms: sign-in, address book, checkout, upload, support tickets and chat, staff panels. File uploads: order documents (PDF, DOCX, JPG, PNG, up to 50 MB each), support attachments (up to 10 MB).

### What I could **not** check
- Real payment, SMS, Google sign-in and S3 flows (needs real keys; not touched).
- Whether the live environment variables are set correctly (for example that `PRINTBEE_ORIGIN` is `https://…`). I did not read environment variables. F-08 explains why it matters.
- Whether the Google Maps browser key is restricted to your domain (that setting lives in Google Cloud).
- npm packages: there is no `package.json`; the only JavaScript dependency is a vendored copy of three.js r187 (not audited for advisories).

## 2. Findings table

| ID | Title | Severity | File:Line |
| --- | --- | --- | --- |
| F-01 | One person can block all customer sign-ins (and email-bomb a victim) | **High** | `customer_auth.py:135-138`, `server.py:935-938` |
| F-02 | Sign-in form reveals which emails are staff accounts | Medium | `server.py:936-937` |
| F-03 | Unpaid orders keep their uploaded files forever, with no total size cap | Medium | `server.py:1083-1126`, `order_rules.py:13,22`, `file_retention.py:15-31` |
| F-04 | Vulnerable Pillow image library (42 known advisories), version not pinned | Medium | `requirements.txt:1-3` |
| F-05 | Content-Security-Policy is report-only, so it protects nothing yet | Medium | `server.py:108-121,389` |
| F-06 | No connection timeouts and no cap on live-update streams (easy to exhaust) | Medium | `server.py:134,691-739` |
| F-07 | Permanent staff API keys that skip the Google login and the CSRF check | Low | `server.py:50-60,215-224,852-854` |
| F-08 | Safety checks quietly weaken if `PRINTBEE_ORIGIN` is missing | Low | `customer_auth.py:97-103`, `server.py:241-243,1949` |
| F-09 | Public page counter parses untrusted files (and can be kept busy) | Low | `server.py:889-890,1060-1081`, `document_pages.py:14-35` |
| F-10 | Delivery-partner SMS limit is global, so one caller can lock everyone out | Low | `server.py:1576-1578` |
| F-11 | Server banner and error pages disclose software and version | Low | `server.py:630-631` |
| F-12 | Missing Permissions-Policy and a weak HSTS setting | Low | `server.py:383-398` |
| F-13 | Order tracking link can never be revoked | Low | `server.py:633-635,596-601` |
| F-14 | Docker image and dependencies are not pinned to exact versions | Low | `Dockerfile:1`, `requirements.txt` |
| F-15 | Chart legend inserts text into the page without escaping | Info | `admin-dashboard.js:154` |
| F-16 | Google Maps key is public by design; check it is restricted | Info | `server.py:2065-2067` |
| F-17 | `.claude/` folder is not in `.gitignore` | Info | `.gitignore` |

## 3. Findings in detail

### F-01: One person can block all customer sign-ins (High)
**The problem.** Customers sign in with an emailed link. The code allows at most 50 "pending links" for the *whole site* (not per person). Once 50 exist, **every** sign-in request is refused for up to 15 minutes. There is no limit per visitor address (IP), so one script can fill the 50 slots with made-up emails. A signed-out customer cannot place an order (orders need a login), so this is a cheap way to stop sales.

**How an attacker abuses it.** Run a loop: ask for a link for `fake1@x.com` … `fake50@x.com`. From then on, real customers get "Too many sign-in requests". Repeat every 15 minutes. The same weakness lets someone send up to 5 sign-in emails (one per minute) to any victim's address, which is email-bombing from your domain.

**Proof (reproduced on a local test server):** 52 requests with different fake emails, then a real new customer:
```
2) 52 fake emails -> {429: 3, 503: 49}
   a real new customer now: (429, 'Too many sign-in requests. Please try again later.')
```
```python
# customer_auth.py:135-138
recent = db.execute("SELECT MAX(created), COUNT(*) FROM login_links WHERE email=?", (email,)).fetchone()
count = db.execute("SELECT COUNT(*) FROM login_links").fetchone()[0]
if recent[1] >= 5 or (recent[0] and recent[0] > now - 60) or count >= 50:
    return 429, {"error": "Too many sign-in requests. Please try again later."}
```

**Exact fix.** Limit per visitor IP instead of globally; keep a much larger global number only as an emergency brake.
```python
# customer_auth.py: add an "ip" column once (in SCHEMA or an ALTER TABLE), then:
def request_link(db, email, ip, deliver=send_link):
    ...
    per_ip = db.execute("SELECT COUNT(*) FROM login_links WHERE ip=? AND created>?", (ip, now - LINK_AGE)).fetchone()[0]
    total = db.execute("SELECT COUNT(*) FROM login_links").fetchone()[0]
    if recent[1] >= 5 or (recent[0] and recent[0] > now - 60) or per_ip >= 10 or total >= 1000:
        return 429, {"error": "Too many sign-in requests. Please try again later."}
    db.execute("INSERT INTO login_links(digest,email,created,ip) VALUES (?,?,?,?)", (digest(token), email, now, ip))
```
```python
# server.py:938
return self.json_response(*auth.request_link(db, data["email"], self.client_ip()))
```
Also consider a bot check (for example Cloudflare Turnstile) on the sign-in form.

### F-02: Sign-in form reveals which emails are staff accounts (Medium)
**The problem.** If you type a staff email into the customer sign-in box, the server answers "This email is a staff account". Anyone can test email addresses and learn who your admin and warehouse people are.

**Attack.** An attacker tries likely emails (`owner@…`, `admin@…`), sees which return the staff message, and then targets those people with phishing or Google-account attacks.

**Proof (local test):**
```
1) staff email  : (403, '{"error": "This email is a staff account. Use its portal to sign in."}')
   normal email : (503, ...)   # a normal email gets a different answer
```
```python
# server.py:936-937
if isinstance(data, dict) and self.staff_role(str(data.get("email", "")).strip().lower()):
    return self.json_response(403, {"error": "This email is a staff account. Use its portal to sign in."})
```
**Fix.** Give the same answer for everyone and do not send anything for staff emails.
```python
if isinstance(data, dict) and self.staff_role(str(data.get("email", "")).strip().lower()):
    return self.json_response(200, {"sent": True})   # looks identical; staff use their portal login
```
(Put a hint on the staff portal pages, not on the public sign-in form.)

### F-03: Unpaid orders keep their uploaded files forever, with no total size cap (Medium)
**The problem.** A signed-in customer can create an order with up to 100 files of 50 MB each (about 5 GB) and never pay. Only files of *delivered* orders are ever deleted, and there is no limit on how many unpaid orders one account can create. Files are stored in the database on the 1 GB Render disk unless S3 is configured.

**Attack.** Sign up with a free email address, create a few big unpaid orders. The disk fills, the database can no longer write, and the whole site stops.

**Proof:**
```python
# order_rules.py:13 and :22: up to 100 items, each up to LIMIT (50 MB), no total
if not isinstance(items, list) or not 1 <= len(items) <= 100: ...
... and 1 <= size <= LIMIT ...
# file_retention.py:15-31: the only deletion is for delivered orders
def delete_delivered_files(db, order_id, remote_storage=False): ... db.execute("DELETE FROM files WHERE order_id=?", ...)
```
**Fix.** (1) cap the total size of one order; (2) cap pending orders per customer; (3) delete unpaid orders and their files after 24 hours.
```python
# order_rules.py, inside quote_items after the loop
if sum(item["size"] for item in items) > 200 * 1024 * 1024:
    raise ValueError("An order can hold up to 200 MB of files.")
```
```python
# server.py create_order, before inserting a new order
pending = db.execute("SELECT count(*) FROM orders JOIN order_owners o ON o.order_id=orders.id "
                     "WHERE o.email=? AND status='pending'", (email,)).fetchone()[0]
if pending >= 5:
    return self.json_response(409, {"error": "Finish or wait for your open orders first."})
```
```sql
-- run from the existing cleanup worker every few minutes
DELETE FROM files WHERE order_id IN (SELECT id FROM orders WHERE status='pending'
  AND id IN (SELECT order_id FROM audit WHERE action='order_created' AND created < strftime('%s','now') - 86400));
```
(Adjust to your `audit.created` format and also remove the S3 objects for those orders.)

### F-04: Vulnerable Pillow library, version not pinned (Medium)
**The problem.** `reportlab` (used to make invoice PDFs) pulls in the image library Pillow. Your `requirements.txt` does not pin it, so Docker installs 12.3.0, and `pip-audit` reports **42 known vulnerabilities, all fixed in 13.0.0**. In this app Pillow only loads the PrintBee logo from disk (`order_documents.py:77-80`), not customer files, so real exposure looks low, but a one-line change closes it.

**Proof (pip-audit output, shortened):**
```
Found 42 known vulnerabilities in 1 package
pillow 12.3.0  PYSEC-2026-4327  13.0.0   ... (42 rows, all pillow)
```
`pypdf==6.21.4`, `reportlab==4.5.1`, `boto3==1.44.3`: no known issues.

**Fix.**
```
# requirements.txt
pillow>=13.0.0
```
Then rebuild, run `python -m unittest discover`, and re-run `pip-audit -r requirements.txt`.

### F-05: Content-Security-Policy is report-only (Medium)
**The problem.** A CSP is the main safety net if an XSS bug ever appears. Today it is sent only as `Content-Security-Policy-Report-Only`, which blocks nothing (I added it that way on purpose so the site would not break). Nothing collects its reports either.

**Attack.** If a future change forgets to escape some text, an attacker's script would run with no browser-side brake.

**Proof:**
```python
# server.py:389
"Content-Security-Policy-Report-Only": CSP_REPORT_ONLY,
```
My earlier scan showed the only things a strict policy would block are inline `<style>` blocks and `style=""` attributes on most pages, and one inline script in `admin.html`.

**Fix, in two safe steps.**
Step 1, enforce right now the parts that need no page changes:
```python
# server.py security_headers(): add to `wanted`
"Content-Security-Policy": "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
```
Step 2, later: move the one inline script in `admin.html` into a `.js` file, then enforce `script-src 'self' https://checkout.razorpay.com https://maps.googleapis.com` (scripts are the dangerous part; allowing `style-src 'unsafe-inline'` is an acceptable compromise until the inline styles are moved).

### F-06: No connection timeouts, and no cap on live-update streams (Medium)
**The problem.** The server makes one thread per connection and never times out a slow or idle connection. Each signed-in user can also open unlimited "live update" streams (each loops for up to 5 minutes and checks the database every second).

**Attack.** Open many connections and send one byte per minute ("slowloris"), or open hundreds of `/api/events` streams from a free customer account. The thread pool and database get saturated and real users time out. Render's proxy softens this but does not remove it.

**Proof:**
```python
# server.py:134: the handler class has no `timeout`
class PrintBee(SimpleHTTPRequestHandler):
# server.py:723-735: each stream loops up to 300 s, polling the database every second
deadline = time.time() + 300
while time.time() < deadline:
    events = event_feed.fetch(db, kind, identity, last) ... time.sleep(1)
```
**Fix.**
```python
class PrintBee(SimpleHTTPRequestHandler):
    timeout = 30          # drop connections that stop sending data
```
```python
# server.py: cap streams per person
STREAMS, STREAM_LOCK = {}, threading.Lock()
def event_stream(self):
    ...
    with STREAM_LOCK:
        if STREAMS.get(identity, 0) >= 3:
            return self.json_response(429, {"error": "Too many open live connections."})
        STREAMS[identity] = STREAMS.get(identity, 0) + 1
    try:
        ... existing loop ...
    finally:
        with STREAM_LOCK:
            STREAMS[identity] -= 1
```
(Keep the read timeout from breaking the long-lived writes: streams only write, so it is safe.)

### F-07: Permanent staff API keys skip the Google login and the CSRF check (Low)
**The problem.** Besides Google sign-in, the server accepts a long random key in the `X-Staff-Key` header for the warehouse, admin and delivery roles. These keys are created once, never expire, are stored as plain text in `staff-keys.json` on the data volume, and `Show Staff Keys.cmd` prints them. Anyone who gets one key has full admin power until you delete the file. Actions made with a key are logged only as "admin", not as a person.

**Attack.** A leaked backup, log, or a copied key from a laptop gives permanent admin access that no one can notice or revoke without editing the server.

**Proof:**
```python
# server.py:50-60  keys written as plain JSON
temporary.write_text(json.dumps(updated), encoding="utf-8")
# server.py:215-219  key accepted for any role, forever
key = self.headers.get("X-Staff-Key", "").encode()
return next((role for role, secret in self.server.keys.items() ... hmac.compare_digest(key, secret.encode())), None)
# server.py:852  a key also skips the same-origin (CSRF) check
if path.startswith(("/api/staff/", "/api/admin/")) and not self.headers.get("X-Staff-Key"):
```
No browser page in the repo sends `X-Staff-Key`, so these keys look like a leftover. **Fix.** Turn them off unless explicitly enabled:
```python
# server.py get_role(): only honour the header when the owner opts in
if key and os.environ.get("PRINTBEE_ALLOW_STAFF_KEYS") == "1":
    ...existing key check...
```
and delete `staff-keys.json` on the live disk (the file is recreated, but the header is then ignored). If you keep the keys, rotate them regularly.

### F-08: Safety checks quietly weaken if `PRINTBEE_ORIGIN` is missing (Low)
**The problem.** Three protections depend on one environment variable, `PRINTBEE_ORIGIN`: (a) the `Secure` flag on cookies, (b) the CSRF origin check, (c) the block on fake "test" payments. If it is empty, cookies are sent without `Secure`, the CSRF check compares the browser's `Origin` with the request's own `Host` header (which an attacker controls), and test payments (which mark orders paid without money) are still allowed because a missing hostname is accepted.

**Proof:**
```python
# customer_auth.py:101-103
secure = "; Secure" if urlsplit(public_origin()).scheme == "https" else ""
# server.py:241-243
origin = auth.public_origin() or f"http://{self.headers.get('Host')}"
# server.py:1949  hostname None (not set) is allowed
if payment_mode == "test" and urlsplit(auth.public_origin()).hostname not in (None, "localhost", "127.0.0.1"):
```
Live HSTS is being sent, which suggests the variable is set, but I could not confirm it. **Fix.** Refuse to start on a public host without an https origin:
```python
# server.py main, after reading args
if args.host not in ("127.0.0.1", "localhost") and not auth.public_origin().startswith("https://"):
    raise SystemExit("Set PRINTBEE_ORIGIN to your https:// site address.")
if payment_mode == "test" and urlsplit(auth.public_origin()).hostname not in ("localhost", "127.0.0.1"):
    raise SystemExit("Test payments require a local origin.")
```

### F-09: Public page counter parses untrusted files (Low)
**The problem.** `POST /api/checkout/pages` needs no login and accepts files up to 50 MB. Only 2 can be processed at once (the others get "busy"), so one visitor can keep both slots busy and break page counting for everybody. PDFs are parsed by `pypdf`; DOCX files are converted by LibreOffice **if it is installed** (the Docker image does not install it, so on live DOCX page counting is skipped). If you ever add LibreOffice, you will be opening untrusted Word files on a public endpoint (external links, macros, parser bugs).

**Proof:**
```python
# server.py:889-890 and :1064
if path == "/api/checkout/pages": return self.inspect_document()
if not DOCUMENT_READERS.acquire(blocking=False): ... 503 "Page counting is busy."
# document_pages.py:24-30
subprocess.run([executable, ... "--headless", "--convert-to", "pdf", ...], timeout=30, check=True)
```
**Fix.** Add a per-IP limit (reuse `support.check_rate`-style counters, for example 20 per 10 minutes). If you add LibreOffice, run it in a locked-down container with no network, and keep the 30-second timeout.

### F-10: Delivery-partner SMS limit is global (Low)
**The problem.** The phone sign-in limiter refuses everyone once 150 attempts exist in 10 minutes. One caller can hit that and stop all partners from signing in by phone. (Same pattern as F-01.)

**Proof:**
```python
# server.py:1576-1578
total = db.execute("SELECT count(*) FROM partner_auth_limits").fetchone()[0]
if total >= 150 or count >= 5 or (action == "send" and last and last > now - 60):
```
**Fix.** Add an IP-based scope (`scope = action + ":ip:" + self.client_ip()`) with its own small limit, and keep the global number only as a high emergency brake.

### F-11: Server banner and error pages disclose software and version (Low)
**The problem.** Responses include `Server: SimpleHTTP/0.6 Python/3.10.0` (the live server answers HEAD with `405`), and Python's built-in HTML error pages are used for unknown URLs. This tells attackers exactly which software and version to target.

**Proof:**
```python
# server.py:630-631
def do_HEAD(self):
    self.send_error(405, "Use GET.")
```
**Fix.**
```python
class PrintBee(SimpleHTTPRequestHandler):
    server_version = "PrintBee"
    sys_version = ""
```
(This was also reported earlier as BUG-012 and BUG-013.)

### F-12: Missing Permissions-Policy and weak HSTS setting (Low)
**The problem.** The new security headers do not include `Permissions-Policy` (to switch off camera, microphone and so on), and HSTS has no `includeSubDomains`. Low impact because the site does not use those features.

**Proof:**
```python
# server.py:383-398
"X-Content-Type-Options": "nosniff", "Referrer-Policy": ..., "X-Frame-Options": "SAMEORIGIN", ...
wanted["Strict-Transport-Security"] = "max-age=31536000"
```
**Fix.**
```python
wanted["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(self), payment=(self)"
wanted["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
```
(Add `includeSubDomains` only if every subdomain of your domain is https. `geolocation=(self)` is kept because delivery partners share their location.)

### F-13: Order tracking link can never be revoked (Low)
**The problem.** The shareable tracking key is computed from the order id and a server secret. It is permanent, and there is no way to cancel one that was shared by mistake. It only shows status, order number and whether payment started, so the damage is small.

**Proof:**
```python
# server.py:633-635
def tracking_key(self, order_id):
    secret = self.server.keys["delivery-code"].encode()
    return hmac.digest(secret, ("tracking:" + order_id).encode(), "sha256").hex()
```
**Fix.** Store a random per-order tracking key (with an "expires" date) in the database instead, or stop answering the key once the order is delivered.

### F-14: Docker image and dependencies are not pinned (Low)
**The problem.** `python:3.12-slim` moves over time and the app's transitive dependencies (such as Pillow, F-04) are whatever is newest on build day. A bad upstream release or a vulnerable one is installed automatically on the next deploy.

**Proof:**
```dockerfile
# Dockerfile:1
FROM python:3.12-slim
```
**Fix.** Pin the base image by digest, keep a full lock file (`pip-compile --generate-hashes`), and run `pip-audit` before each deploy.

### F-15: Chart legend inserts text without escaping (Info)
**The problem.** `entry.name` is placed into HTML unescaped. Today it is fixed text from the code, so there is no attack, but if a name ever comes from user data it would become cross-site scripting.

**Proof:**
```js
// admin-dashboard.js:154
`<li><span class="swatch" style="background:${entry.color}"></span>${entry.name}</li>`
```
**Fix.** `${escape(entry.name)}` (the file already defines `escape` at line 34).

### F-16: Google Maps key is public by design (Info)
The Maps key must be in the browser, so anyone can read it from `/api/checkout` (`server.py:2065-2067`). That is normal, but **check in Google Cloud that the key is restricted to your website address and only to the Maps JavaScript API**, otherwise others can run up your bill.

### F-17: `.claude/` is not ignored by git (Info)
`git status` shows `.claude/` as untracked. It holds local tool settings and can contain private paths or approvals. **Fix:** add `.claude/` to `.gitignore`.

## 4. Fix first (top 5)

1. **F-01** Per-IP sign-in limits, remove the global 50 cap (stops one person blocking all customers).
2. **F-03** Cap order size, cap pending orders, delete unpaid orders after 24 hours (stops disk-filling).
3. **F-04** Add `pillow>=13.0.0` to `requirements.txt` (one line).
4. **F-06** Add `timeout = 30` and limit live streams per person.
5. **F-05** Enforce the safe CSP directives now (`object-src`, `base-uri`, `form-action`, `frame-ancestors`), then plan the full script policy.

Quick wins after that: F-02 (same answer for staff emails), F-07 (disable permanent staff keys), F-08 (refuse to start without an https origin), F-11 (hide the server banner).

## 5. What is already done well

- **SQL injection:** every query uses placeholders (`?`). The few places that build SQL text use fixed table names or fixed fragments, never user input (`server.py:186,342`, `support.py:558,790,902`). Checked all of them.
- **No dangerous code:** no `eval`, `exec`, `pickle`, `shell=True` or `os.system` anywhere in the app.
- **Cross-site scripting:** user text is shown with `textContent` or escaped; `innerHTML` is used only for fixed icons and escaped templates. Invoice and label PDFs escape names and addresses. CSV exports guard against spreadsheet-formula injection (`warehouse.js:706`, `admin-dashboard.js:790`).
- **Secrets:** all keys come from environment variables; `.env` and key files are in `.gitignore`. I searched all **368 commits** for AWS, Google, GitHub, Razorpay, Twilio, Slack and `sk-` style keys and private-key blocks: **0 hits**.
- **Sessions and sign-in:** tokens are random (32 bytes), stored only as SHA-256 hashes, cookies are `HttpOnly` and `SameSite=Lax` (plus `Secure` on https), sessions slide for 7 days and end on logout and "log out of all devices". Email links are single-use, expire in 15 minutes and travel in the URL `#fragment` (not logged by servers). Google sign-in uses PKCE, a `state` value and requires a verified email.
- **No passwords exist**, so weak-password and credential-stuffing problems do not apply.
- **Authorization:** every admin, warehouse and partner API checks the caller's role; customer data is always filtered by the signed-in email; order, ticket and attachment lookups return the same "not found" for other people's ids (IDOR checked: orders, files, invoices, tickets, attachments, events). Partners can act only on their own deliveries. The checked staff routes returned `403` when anonymous.
- **CSRF and CORS:** state-changing requests require a matching `Origin` (or a custom header a cross-site page cannot send); the server sends no CORS headers at all, so other sites cannot read responses. A forged or missing `Origin` was refused in my test.
- **Payments and business logic:** prices are always recomputed on the server and compared with the customer's expected total; the Razorpay webhook is verified with an HMAC (constant-time compare) and amounts are matched to the order; the fake "test payment" route is refused unless the server runs locally in test mode; state changes use database transactions; delivery codes lock after 3 wrong tries.
- **Uploads:** only PDF, DOCX, JPG and PNG, checked by extension, MIME type and file contents (fixed earlier as BUG-001); size limits; files are served only as downloads with `nosniff`; support attachments use safe file names and a content-sniffed type.
- **Static files:** only a fixed allowlist of files is served; `server.py`, `.git`, `staff-keys.json` and path-traversal tries all returned `404`.
- **Information exposure:** errors are generic (no stack traces to the browser), API responses are `no-store`, partner payout is hidden from customers and warehouse (fixed earlier as BUG-004), Google callback codes are kept out of logs.
- **Debug and demo:** the demo login exists only with `PRINTBEE_DEMO=1` and the server refuses it with a real origin or real payments; `/api/dev/login` returned `404` on a normal server.
- **Deployment:** Docker runs the app as a non-root user; security headers (nosniff, framing rule, referrer policy, HSTS on https) are on every response.
- **Rate limits** already exist on support tickets, messages and uploads, and on the Buzz chatbot; the chatbot defaults to a built-in mock and strips personal data before any model call.

## 6. How the checks were run (so you can repeat them)

- Read the main files in full: `server.py`, `customer_auth.py`, `partner_auth.py`, `document_pages.py`, `order_documents.py`, parts of `support.py`, `razorpay_checkout.py`, `file_retention.py`, `order_rules.py`.
- Searched all code for SQL built from text, dangerous functions, `innerHTML`, and risky links.
- `pip-audit -r requirements.txt` in a temporary virtual environment (outside the project).
- Git history scan for common secret patterns across all commits.
- Local-only test server on port 4195 with a temporary data folder: sign-in limits, staff-email answer, forged/missing Origin, anonymous admin API, and requests for `/.git/config`, `/staff-keys.json`, `/server.py`, a path-traversal URL and `/api/dev/login`.

# PrintBee QA report

Tested on 2026-11-20. **No code was changed.** Live site: https://printbee.onrender.com. Local copy: this repo at its current `main`, run twice (a plain server and the demo server with sample logins on temporary data).

Tools: Playwright 1.49 driving installed Google Chrome 157, Lighthouse 12.2 (mobile, slow 4G), Python request probes, and a code/repo scan.

## Summary

| Severity | Bugs |
| --- | --- |
| Critical | 0 |
| High | 1 |
| Medium | 7 |
| Low | 10 |
| **Total** | **18** |

What was run: about 230 API probes on the local server and 143 on the live site, 120 page loads per site (12 pages × 5 widths), more than 120 scripted browser and flow checks (guest flows on local and live, an order lifecycle, sessions and roles, support tickets, the three staff portals), 5 Lighthouse runs, a dark-mode pass and a code and repo scan. A few scripted checks that "failed" were mistakes in my test script rather than site bugs; those are not listed as bugs.

Not tested: 12 areas, listed under "Could not test".

Overall: the site is in good shape. Pages render at all five widths with no sideways scroll. Sign-in sessions, role boundaries (customer, warehouse, delivery, admin), cross-customer access, sign-out and cookie tampering all behaved correctly. The whole customer order, warehouse, delivery and admin lifecycle ran end to end. The main concerns are: any file type can be uploaded and ordered (BUG-001), the customer pages are slow on phones because of the 3D bee (BUG-002), and a handful of production-hardening gaps.

Live and local behaved identically in every comparison, except that live runs real Razorpay payments (which I did not exercise).

**Cold start:** the live site did not sleep. My first request answered in 0.48 s, then 0.18 s and 0.21 s, with no wake-up delay. `render.yaml` sets the `starter` plan, which does not sleep. No 60-second wait was needed, so there is no cold-start figure to report.

## Bugs

### BUG-001: Any file type can be uploaded and ordered (.exe, .txt, corrupt PDFs)
- Severity: High
- **Status: FIXED** (commit `fix(BUG-001)`). New module `upload_types.py`: only PDF, DOCX, JPG/JPEG and PNG pass, and each file must pass three checks: extension, the MIME type the browser declared (generic or empty is allowed only if the content check passes), and the real content (magic bytes; a DOCX must be a ZIP holding `word/document.xml`, with a 300 MB unpacked limit). 50 MB maximum. Enforced on the server in three places: order creation (`order_rules.quote_items` refuses other extensions), the file upload route (`415` with a clear message) and the page-count route. The upload page now has an `accept` list and gives a friendly message before anything is sent.
- **Verified:** in a real browser against the demo and plain servers, `virus.exe`, `notes.txt` and an `.exe` renamed to `.pdf` were all refused with a clear message; a real PDF, PNG and DOCX were accepted together; a mixed pick kept the good file and explained the refused one. Straight to the API (bypassing the page), an exe sent as PDF, a text file sent as PDF and an exe sent as DOCX all got `415`. Order creation with `virus.exe` or `notes.txt` returned `400`. The full order, warehouse, delivery and admin lifecycle still ran. 10 new tests in `test_upload_types.py`.
- Area: Upload page, cart, order creation, warehouse download
- Steps to reproduce:
  1. Open `/upload`.
  2. Choose a file named `virus.exe` (or `notes.txt`).
  3. It appears in "Review your files" with an "Add to cart" button. Add it, check out, and place the order.
- Expected result: only the types the page promises ("PDF, Word or images") are accepted, on the page and again on the server.
- Actual result: the `.exe` and `.txt` are listed and added. On the demo server the order was placed (`POST /api/orders/<id>/files/0` returned 200) with the `.exe` as the print file. A corrupt "PDF" (random text) is also listed with no message. The file input has no `accept` attribute. Live behaves the same in the browser (live checkout itself was not exercised).
- Evidence: `qa-screenshots/BUG-upload-exe-txt-accepted.png`; request log from the demo run: `200 POST /api/orders/…/files/0`, then `200 POST /api/orders/…/payment`.
- Likely cause: `studio.js` (the upload handler) checks only size and empty files; `server.py` order file upload does not check type.
- Fix prompt: "In PrintBee, uploads accept any file type. Add an allowlist (PDF, DOC/DOCX, PNG, JPG/JPEG) in two places: set an `accept` attribute on `#document-file` and reject other types in `studio.js` with a clear message in `#queue-status`; and reject other types (check the extension AND the file's first bytes) in the server's order file upload in `server.py`. Also reject a PDF that cannot be parsed, with a message. Add tests. Change nothing else."

### BUG-002: Customer pages are heavy and slow on phones (the 3D bee)
- Severity: Medium
- Area: Every customer page (home, upload, orders, cart, profile, help, address, pricing)
- Steps to reproduce: run Lighthouse (mobile, slow 4G) on `https://printbee.onrender.com/index.html`, `/queue.html`, `/pricing.html`.
- Expected result: performance in the 90s, as the welcome page gets.
- Actual result: performance 63 (home), 63 (upload), 69 (pricing). Total blocking time 2.3 to 2.8 s, time to interactive 6.0 to 7.6 s, page weight about 2.0 MB. The welcome page scores 100.
- Evidence: Lighthouse JSON for the five pages; the biggest script cost is `buzz-bee3d.js` (about 10 s of scripting on the throttled run, from the three.js engine and the 938 KB `bee_hq.glb`).
- Likely cause: `buzz-chat.js` loads three.js, the GLB and builds the bee on every customer page at startup.
- Fix prompt: "The Buzz bee 3D launcher blocks the main thread for 2+ seconds on mobile and loads 1.3 MB of 3D code on every page. Keep the look but load the 3D scene lazily: show the existing still bee pictures first, and only import `buzz-bee3d.js` and `bee_hq.glb` after the page is idle (or when the user first hovers or taps the bee), and skip the 3D entirely on low-power devices. Re-run Lighthouse mobile; goal TBT under 300 ms and performance 90+. Change nothing else."

### BUG-003: Signed-out visitors get red console errors on every page
- Severity: Medium
- Area: All customer pages and the welcome page
- Steps to reproduce: open any page signed out with the browser console open.
- Expected result: no errors for a normal visitor.
- Actual result: every page logs 401s for `/api/support/notifications` (and `/api/orders`, `/api/support/tickets` on some), and the welcome page logs a 404 for `/api/dev/roles`. Lighthouse flags "Browser errors were logged to the console" on all customer pages. The site also keeps asking for these while signed out.
- Evidence: sweep logs (60 loads each on live and local); Lighthouse `errors-in-console`.
- Likely cause: `support-bell.js`, the orders widget and `demo-login.js` call authenticated or demo-only endpoints without first checking the session.
- Fix prompt: "Signed-out visitors trigger 401s from `support-bell.js` and the orders/notification widgets, and the welcome page requests `/api/dev/roles` (404) on every load. Check `/api/auth/session` first (it is already cheap) and only call authenticated endpoints when signed in; only request `/api/dev/roles` when the page is served from localhost. Goal: zero console errors for a signed-out visitor on every customer page."

### BUG-004: The public checkout config exposes the delivery partner payout
- Severity: Medium
- Area: `GET /api/checkout`
- Steps to reproduce: `curl https://printbee.onrender.com/api/checkout` and read `terms`.
- Expected result: only customer-facing prices.
- Actual result: the response includes `partnerPayout` (what a delivery partner earns per order) and `autoDispatch`. Coupons are correctly hidden.
- Evidence: live response keys: `surge, deliveryPerKm, packing, platform, delivery, taxBasisPoints, partnerPayout, slots, paperRates, bindingRates, autoDispatch, campuses`.
- Likely cause: `server.py` `/api/checkout` removes only `coupons` from the terms.
- Fix prompt: "`GET /api/checkout` returns internal settings. Build the public response from an allowlist of customer-facing fields (surge, deliveryPerKm, packing, platform, delivery, taxBasisPoints, slots, paperRates, bindingRates, campuses) and drop `partnerPayout` and `autoDispatch`. Make sure the admin and checkout screens still work and add a test."

### BUG-005: No security headers
- Severity: Medium
- Area: All responses
- Steps to reproduce: `curl -I https://printbee.onrender.com/`.
- Expected result: at least `X-Content-Type-Options`, a framing rule (`X-Frame-Options` or CSP `frame-ancestors`), `Referrer-Policy`, `Strict-Transport-Security`, and ideally a Content-Security-Policy.
- Actual result: none are present (only Cloudflare and Render headers). The site can be embedded in another site's frame (clickjacking), and browsers may sniff file types.
- Evidence: live headers: `cache-control, content-type, last-modified, rndr-id, server: cloudflare, vary, x-render-origin-server, cf-cache-status, cf-ray, alt-svc`.
- Likely cause: `server.py` `end_headers` adds only caching headers.
- Fix prompt: "Add security headers to every response in `server.py`: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY` (the app does not need framing; check `navigation.html` which frames its own pages and use SAMEORIGIN if needed), `Strict-Transport-Security` when the origin is https, and a conservative Content-Security-Policy that still allows the site's own scripts, the Google Maps/Razorpay hosts it uses, and inline styles. Test every page for console CSP violations."

### BUG-006: Sign-in emails have no per-IP throttle
- Severity: Medium
- Area: `POST /api/auth/request`
- Steps to reproduce: send 40 sign-in requests, each with a different email, from one machine.
- Expected result: throttling (HTTP 429) after a handful from one address.
- Actual result: the same email is limited correctly (first 503/200 then 429), but 40 different emails in a few seconds were never limited (all got the same non-429 answer). On a live server with SMTP configured this could let someone send many emails from your domain.
- Evidence: local run (the local server has no SMTP, so each answered 503); live was deliberately not tested to avoid sending real emails. Treat as "needs confirming on a server with SMTP".
- Likely cause: the limit is keyed by email only (`customer_auth.py`).
- Fix prompt: "Add a per-IP rate limit (for example 10 sign-in email requests per 10 minutes per client IP, taking the real IP from the proxy header Render sets) in addition to the existing per-email limit in `customer_auth.py`, returning 429 with a friendly message. Add a test that 11 different emails from one IP get a 429."

### BUG-007: The home, upload and other pages poll the server every 5 seconds forever
- Severity: Medium (scales with visitors)
- Area: Customer pages
- Steps to reproduce: open `/index.html`, watch the network tab: `GET /api/checkout` repeats every 5 s.
- Expected result: fetch once, and refresh only when the tab is visible and after a longer interval or on an event.
- Actual result: continuous polling from every open tab; the page never reaches "network idle".
- Evidence: request log: `/api/checkout` at about 5 s and 10 s after load on live and local.
- Likely cause: `pricing`/checkout config subscription (`customer-pricing.js`).
- Fix prompt: "`customer-pricing.js` polls `/api/checkout` every 5 seconds on every customer page. Poll only while the tab is visible, back off to 60 s, stop when hidden, and refresh immediately when the tab becomes visible. Keep price changes appearing within a minute."

### BUG-008: Public pricing page does not show Bond paper prices
- Severity: Medium (needs your decision)
- Area: `/pricing.html`
- Steps to reproduce: open `/pricing.html`; compare with `GET /api/checkout`.
- Expected result: the price table lists every paper a customer can buy.
- Actual result: only the A4 table shows. The paper selector was removed in commit `97d1b1a`, so "Bond paper sheet" is purchasable at checkout (`A4 Bond`: ₹3 / ₹5.50 / ₹12 / ₹20) but its prices are not on the pricing page.
- Evidence: pricing page DOM has no `[data-paper-picker]`; live `paperRates` has `A4` and `A4 Bond`.
- Likely cause: intentional removal in `97d1b1a`, but nothing replaced it.
- Fix prompt: "The pricing page shows only A4 rates, but Bond paper is also sold. Show a second price table (or a second row group) for 'Bond paper sheet (recommended for major project reports)' fed by the same `paperRates`, without bringing back the dropdown. Keep the layout and styling."

### BUG-009: Dark-mode heading accent words are hard to read
- Severity: Low
- Area: `/pricing.html` and "How it works" heading in dark mode
- Steps to reproduce: switch to Moon mode, open `/pricing.html`.
- Expected result: large text at 3:1 or better.
- Actual result: "prices" (and "works") measure 2.68:1 (`rgb(142,69,31)` on near-black).
- Evidence: `qa-screenshots/BUG-dark-mode-heading-contrast-pricing.jpg`.
- Likely cause: the accent colour in `studio.css` is not remapped for dark mode.
- Fix prompt: "In dark mode the accent words in section headings (`#pricing-title span`, `.how h2 span`) are `#8e451f` on near-black (2.68:1). Use a lighter honey/amber in `customer-theme.css` for `[data-theme=dark]` so they reach at least 4.5:1."

### BUG-010: Small grey text fails contrast in light mode
- Severity: Low
- Area: `/pricing.html` (footer and small links)
- Actual result: Lighthouse accessibility 97 on pricing: `#686c61` on `#ede5d3` at 11px is 4.28:1 (needs 4.5:1).
- Evidence: Lighthouse `color-contrast` audit on live.
- Fix prompt: "Darken the 11px muted text colour used in the footer and the pricing page (currently `#686c61` on `#ede5d3`) so contrast is at least 4.5:1 in light mode."

### BUG-011: Unknown URLs show a raw, unbranded server error page
- Severity: Low
- Area: any bad URL, for example `/this-page-does-not-exist`
- Expected result: a PrintBee-styled 404 with a link home.
- Actual result: the plain Python "Error response / Error code: 404" page, with no title, language, viewport or favicon. Wrong request types return similar plain HTML (501), and `GET /api/auth/portal?portal=bad` returns an HTML 400.
- Evidence: `qa-screenshots/BUG-raw-404-page.png`, `BUG-raw-404-1440.jpg`.
- Likely cause: `server.py` sends the default `send_error` page.
- Fix prompt: "Serve a branded 404 page (with the site header, a message and a link to Home) for any unknown non-API path, and JSON `{error}` for unknown or invalid `/api/` requests. Keep the HTTP status codes."

### BUG-012: Server software version is disclosed
- Severity: Low
- Area: response headers
- Actual result: live responses include `x-render-origin-server: SimpleHTTP/0.6 Python/3.12.16`; locally `Server: SimpleHTTP/0.6 Python/3.10.0`.
- Fix prompt: "Override `version_string()` in the `server.py` handler to return a neutral value so the Python version is not advertised."

### BUG-013: HEAD requests are refused
- Severity: Low
- Area: `/` and API routes
- Actual result: `HEAD /` returns 405. Uptime monitors that use HEAD will report the site down.
- Fix prompt: "Add `do_HEAD` to the `server.py` handler so HEAD returns the same status and headers as GET, with no body."

### BUG-014: Missing SEO basics
- Severity: Low
- Area: welcome page, pricing page, site root
- Actual result: the welcome page (`/`) has no meta description (Lighthouse SEO 91); `/pricing.html` has no `<h1>`; `/robots.txt`, `/sitemap.xml` and `/favicon.ico` return 404 (the pages do declare a favicon through `<link rel="icon">`).
- Fix prompt: "Add a meta description to `welcome.html`, make the pricing page title an `<h1>`, and add `robots.txt` and `sitemap.xml` (allow the public pages, disallow `/api/`, `/admin`, `/warehouse`, `/partner`), plus the static-file allowlist entries in `server.py`."

### BUG-015: Footer email wraps mid-word and the bee overlaps footer text on phones
- Severity: Low
- Area: footer on every customer page at 360 to 390 px
- Actual result: "printbee.co.in@gmail.co / m" breaks mid-address, and the "Need help? Buzz me!" bubble and the bee cover footer text.
- Evidence: `qa-screenshots/overview-360px-all-pages.jpg`, `note-buzz-tooltip-overlaps-content.png`.
- Fix prompt: "At 390 px and below, let the footer contact links wrap at the @ (use `overflow-wrap:anywhere` only as a fallback) or reduce the font size, and add bottom padding to the footer so the Buzz bee and its tooltip never cover contact text."

### BUG-016: Some tap targets are under 24 px
- Severity: Low
- Area: footer links (for example 110×18 and 67×18 px) on every page
- Actual result: fails the WCAG 2.2 "target size" minimum (24×24). Main buttons and nav are fine.
- Fix prompt: "Give footer and in-text links a minimum 24×24 px tap area (padding or `min-height`) without changing the look."

### BUG-017: Support messages have no length limit
- Severity: Low
- Area: new support ticket
- Actual result: a 20,000-character message was accepted and stored.
- Fix prompt: "Limit support ticket subjects (for example 120 characters) and messages (for example 4,000) on the form (`maxlength` with a counter) and on the server, with a clear error."

### BUG-018: Local server refuses connections under a burst
- Severity: Low (live is behind Render's proxy and handled 40 at once)
- Area: `python server.py` on its own
- Actual result: 6 of 150 simultaneous connections were refused (listen backlog is Python's default of 5). Chrome also logged one `ERR_CONNECTION_REFUSED` while loading a single page locally.
- Fix prompt: "Raise `request_queue_size` (for example to 128) on the server class in `server.py` so bursts of parallel connections are queued instead of refused."

## Things that passed (checklist)

**API, 190 probes (local) and 143 probes (live, read-only):**
- PASS every protected endpoint refuses signed-out callers (401/403); no stack traces or file paths in any error
- PASS cross-site POSTs are refused ("Open PrintBee directly"); no wildcard CORS
- PASS invalid input rejected with clear JSON: empty, wrong types, huge numbers, negative copies, unknown paper or binding, 300-character names, SQL and script strings, emoji; script strings are stored and shown as text
- PASS source files, `.env`, `.git`, database and key files are not served; path traversal attempts return 404 (live: 400 from the proxy)
- PASS the Razorpay webhook rejects an unsigned call (403 on live)
- PASS HTTP redirects to HTTPS (301)

**Sessions and roles (demo server):**
- PASS sign-in, sign-out, sign-out invalidates the old cookie everywhere, tampered cookie rejected
- PASS signed-out `/warehouse`, `/admin`, `/partner` show a sign-in gate and no data
- PASS 9 role-boundary checks (customer to staff/admin/partner, warehouse to admin, partner to staff/admin, writes and refunds): all refused
- PASS a different signed-in customer and an anonymous caller cannot read someone else's order (404)
- PASS cookie is HttpOnly and SameSite=Lax; Secure is added when the origin is https (code check; not seen on live because I could not sign in there)

**Customer flows (local and live in a real browser):**
- PASS welcome page (Google button, email form, continue as guest), empty and invalid email blocked, injection strings not echoed
- PASS every nav link, refresh on 8 routes (no 404), back/forward walk
- PASS Sun/Moon toggle works and survives reload
- PASS upload: valid PDF reviewed, empty file refused, over-50 MB refused, odd file names escaped (the file-type gap is BUG-001)
- PASS address book: save, default star, saved list
- PASS full order on the demo server: upload, cart, Bond paper and glossy binding priced correctly, empty and invalid checkout blocked, double-click places only one order, special characters in notes stored as text, order tracking page and orders list
- PASS support: empty and partial tickets blocked, script/emoji stored as text, double-click makes one ticket, my-tickets list
- PASS Buzz chat opens, answers and closes with Escape
- PASS keyboard: skip link first, 25 Tab presses move through 24 distinct controls, focus ring visible

**Warehouse, delivery and admin (demo):**
- PASS warehouse queue, Mark printed (moves the order to packed), open/close service
- PASS delivery partner goes online, sees the packed order, accepts and picks up
- PASS wrong delivery codes refused, repeated wrong codes lock the code
- PASS admin: all 10 sections load with no console errors; warehouse, partner and admin screens have no sideways scroll at 1440 and 390 px

**Layout, 120 page loads per site:**
- PASS no horizontal scroll at 360, 390, 768, 1024, 1440 on any customer page (live and local); no broken images, no unlabelled form fields, no missing image `alt` text, no unnamed buttons
- PASS dark mode renders cleanly on all customer pages

**Other:**
- PASS no secrets in the repo, its history, or the frontend (key-pattern scan, `.env.example` only)
- PASS health check `/api/status-model` works and is set in `render.yaml`
- PASS Lighthouse: accessibility 97 to 100 and best-practices 96 on all five pages; welcome page performance 100
- PASS the project's own automated tests (221) passed when I started

## Could not test (and why)

1. **Firefox and WebKit.** The Playwright browser downloads failed repeatedly with connection resets, so only Chrome 157 was exercised. Cross-browser behaviour is unverified.
2. **Live signed-in flows** (customer, warehouse, delivery, admin). Sign-in is Google or an emailed link; I did not use real accounts and did not trigger emails. These were tested on the demo server instead, which runs the same code.
3. **Real payments (Razorpay) and order confirmation on live.** Testing would charge real money. The live webhook rejects unsigned calls, which is correct.
4. **Whether the live server also accepts an `.exe` order upload.** The page accepts it on live; placing the order needs a real payment. The demo server accepted it end to end.
5. **Sign-in email delivery and the per-IP limit on live** (BUG-006), to avoid sending emails.
6. **Google sign-in, Google Maps and address search.** No OAuth account here, and the live site has no Maps key configured (`maps: null`), so that part is off.
7. **Word-document page counting and previews** (needs LibreOffice on the server) and **S3 storage**.
8. **Mobile menus in the warehouse and delivery portals** (my script did not open the menu, so those screens were checked only by screenshot on their home view).
9. **Completing a delivery with the correct code.** The code was not visible in the order JSON for the customer, and the lock-out stopped my retries; the lock-out itself works.
10. **Session expiry timing** (days) and **rate limiting on live**.
11. **Print-room hardware and slide/drag gestures** (the "slide to confirm" controls were clicked, not dragged).
12. **Load testing** beyond a 40-request burst on live.

## Top 5 fixes to do first

1. **BUG-001:** restrict uploads to PDF, Word and images on the page and the server.
2. **BUG-002:** load the 3D bee lazily; this is the main cause of the "lag" on phones (performance 63 to 69, 2+ s blocking).
3. **BUG-005:** add security headers (framing, nosniff, referrer, HSTS, CSP).
4. **BUG-004:** stop exposing `partnerPayout` in the public checkout config.
5. **BUG-003 and BUG-007:** remove the red console errors for signed-out visitors and stop the 5-second polling.

Next after those: BUG-006 (confirm the sign-in email throttle on a server with SMTP), BUG-008 (decide how Bond prices should appear on the pricing page), BUG-011 (branded 404).

Screenshots are in `qa-screenshots/`.

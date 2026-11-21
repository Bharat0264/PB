# Optimization and cleanup report

Branch `optimize/cleanup` (from `main` at `c6a2c3e`). Not merged, not pushed. Rule followed throughout: behavior, UI, API responses and the database schema stay exactly the same.

## Before and after

| Measure | Before | After |
| --- | --- | --- |
| Shipped to production (Docker whitelist) | 154 files, 7,228 KB | 156 files, 6,427 KB (**-801 KB, -11%**) |
| Partner "sleeping bee" picture | 834 KB PNG | 53 KB WebP (shown at 144x96 px) |
| CSS (all shipped files) | 28 files, 6,355 lines, 436 KB | 28 files, 6,189 lines, 418 KB (**-203 unused rules**) |
| `warehouse-hive.css` | 90.9 KB | 75.2 KB |
| Warehouse page CSS weight | 127 KB | 111 KB |
| `server.py` | 2,201 lines | 2,113 lines (limits and header policy moved into two small modules) |
| Python app code | 23 modules, 6,485 lines | 25 modules, 6,489 lines |
| Own JavaScript | 44 files, 10,616 lines | 44 files, 10,591 lines |
| Unused Python names | 7 | 0 |
| Same-origin check copies in `server.py` | 4 | 1 |
| Lint (pyflakes): app / tests | 1 / 7 warnings | 0 / 0 (1 left in an offline tool, see below) |
| Environment variables missing from `.env.example` | 15 | 0 |
| Tests | 300 (37 files, 4,846 lines) | 304 (38 files, 4,906 lines), all pass, about 88 s both before and after |
| Direct dependencies | 4 (all used) | 4 |
| Build time | none (no build step) | none |
| Repository | 430 files, 23 MB | 433 files, 22.4 MB |

## What was done (one commit each)

1. Removed 7 unused Python names (`BARE_CODE`, `REQUIRED_STORAGE`, `AUDIENCES`, `ROLES`, `ACTIVE`, `CUSTOMER_VISIBLE`, `runner_problem_kinds`) and a pointless f-string. Each had zero references in code, tests, JS, docs and dynamic lookups.
2. Removed unused JavaScript: `getStored`/`store`, `uploadIndex`, an unused `matchMedia`, and in `warehouse.js` `printerIllustration`, `updateMockJobs`, `floorFilter`, an unused local and a duplicate icon key the later one already overrode.
3. Merged four copies of the cross-site-request origin check into `same_origin()` / `same_origin_json()`, with new tests for every guarded POST (the same tests pass against the old code).
4. Documented every environment variable the server reads in `.env.example`.
5. Replaced the 834 KB partner image with a 53 KB lossless WebP at 3x display size (checked at 1x/2x/3x on light and dark backgrounds: about 1/255 average difference, edge anti-aliasing only).
6. Removed 203 unused CSS rules (classes that no page, script or server code mentions and that show no sign of being built at runtime).
7. Moved the live-stream and page-counter limiters into `request_limits.py` and the CSP/header policy into `security_headers.py`, verbatim.
8. Dropped unused test imports.

## How "nothing changed" was verified

* All 304 tests pass (and the new tests were also run against the original code).
* A style fingerprint harness hashes the computed style of **every element** (12,816) on 68 page states (guest, customer, warehouse, admin and partner, desktop and phone width, animations frozen). The final branch matches the original on all of them; only 5 time-dependent elements are masked, and those also differ between runs of the original.
* Full response headers for 8 URLs, with and without an https proxy, are byte-identical to the original.
* Browser runs of the full order flow (customer, warehouse, partner, admin), every portal tab, the signed-in customer pages and the signed-out public pages: no console errors, no failed requests, no CSP violations enforced.

## Left untouched on purpose (unsure or not safe to prove)

* **`docs/` and `qa-screenshots/`: 197 images (14.4 MB) that no document references.** They are not shipped to production, but they are 61% of the repository's size. Deleting history is your call.
* `tools/make_bee_hq.py:252`: an unused local `chosen` in an offline 3D asset generator I could not run here.
* Small JS helpers repeated across files (`money`, `when`, `clamp`, `$`, `h`): the copies differ slightly (currency options, locales), so merging risks behavior changes for almost no gain.
* CSS classes that look unused but may be built at runtime (for example `is-added`, `welcome-expired`), and selectors inside `:not()`, `:is()`, `:where()`, `:has()`.
* `buzz-bee.glb` (780 KB): the fallback 3D model, only loaded if the improved one fails.
* `printing-clay.webp` (285 KB hero picture): re-encoding a lossy picture would change how it looks.
* `PROVIDERS`, `can()` and `stage()` look unused in app code but are used by tests.
* ESLint "undefined variable" findings: they are scripts sharing globals across files, not bugs.
* Hardcoded WhatsApp number and contact email repeated across pages (needs a build step to centralise).

## Suggested next steps (manual)

1. **Database indexes** (suggest only, schema is off limits here): `audit(order_id, action)`, `audit(order_id)`, `partner_earnings(partner)`, `print_jobs(order_id)`. The order lists run a correlated lookup on `audit` per order, which slows down as the table grows.
2. Add a smaller hero picture for phones (`srcset` with an 800 px version of `printing-clay.webp`, about 150 KB less on mobile).
3. Long-cache headers for fonts and images (with version strings) to speed up repeat visits.
4. Live-update streams poll the database every second per open stream; an in-process notification would remove that load.
5. `server.py` is still about 2,100 lines; the next natural splits are the partner, admin and support route handlers.
6. Paginate `/api/orders` for customers with very many orders.
7. Move the unreferenced `docs` screenshots out of the repository (or into Git LFS).
8. Add an ESLint config and run `pyflakes` plus the tests in CI; pin the Docker image and generate a hashed lock file (see `SECURITY_REPORT.md`, F-14).

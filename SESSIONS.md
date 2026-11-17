# Customer sessions and the sign-in page

## How the session works

- A customer who signs in stays signed in for **7 days after their last activity** (a sliding window).
- Any API call counts as activity. While a page is open, clicks, typing and scrolling also send a quiet
  ping (at most once every 5 minutes) so a customer who is just reading is not signed out.
- The server renews the window at most once every 5 minutes per session, so busy pages do not write on every request.
- After 7 idle days the next request ends the session. The sign-in page then says
  "Your session expired after 7 days away. Please sign in again."
- The session token is a random 256-bit value in an **httpOnly, SameSite=Lax cookie** (plus `Secure` on https).
  Only its SHA-256 digest is stored on the server. Nothing is kept in localStorage.
- Signing out in one tab signs out every open tab (BroadcastChannel). **Log out of all devices** is on the Profile page.
- Someone who is already signed in is sent straight to the home page when they open the sign-in page.
  The page stays hidden behind a clay skeleton until the session check finishes, so it never flashes.
- All sign-in requests are same-origin JSON only (Origin and Content-Type are checked), and the email link
  endpoint is rate limited. Errors never say whether an email has an account.

PrintBee signs people in with Google or an emailed link, so there is no password, password meter or OTP screen.

## Settings

| Setting | Where | Default |
| --- | --- | --- |
| Days of inactivity before sign-out | `PRINTBEE_SESSION_DAYS` environment variable | `7` |
| Renewal throttle | `RENEW_AFTER` in `customer_auth.py` | 300 s |
| Activity ping throttle | `PING_EVERY` in `session-sync.js` | 5 min |

## Files

- `customer_auth.py`: `slide_session`, `end_all_sessions`, session cookies.
- `server.py`: slides the window on every `/api/` request, `POST /api/auth/logout-all`.
- `session-sync.js`: tab sync, activity pings, expiry redirect (loaded on every customer page).
- `customer-login.js`: sign-in logic, route guard, expired message.
- `welcome.html`, `welcome.css`, `welcome-form.js`, `welcome-mascot.js`: the clay sign-in page.
- `test_session_sliding.py`: unit tests for the 7-day rule.

## Test checklist

1. Sign in, close the browser, reopen `/`: you land on the home page, never the sign-in card.
2. Sign in, wait or edit `last_active` in the `customer_sessions` table to 6 days ago, click around: the session renews (Max-Age 7 days).
3. Set `last_active` and `expires` to 8 days ago, then reload: you are signed out and see the "session expired" message.
4. Open two tabs, sign out in one: the other goes to the sign-in page.
5. Profile, "Log out of all devices": every browser is signed out.
6. Sign-in page at 360, 390, 768, 1024 and 1440 px: no horizontal scroll, controls at least 48 px tall.
7. Try a wrong email: friendly hint and a gentle shake. Tab through the page: focus rings are visible.
8. Turn on "reduce motion" in your system: the mascot and card stop animating.

Run `python -m unittest discover` for the automated tests.

# PrintBee delivery partner portal

Run the existing Python application with python server.py and open /partner?preview=1 for the sample cockpit. No account, location permission, or provider credentials are needed. Go online, accept a sample order, confirm pickup, and deliver using demo code 4816. Reset the demo from Profile. Sample state persists on that browser. In Chrome or Edge the demo can be installed from the browser menu, and its shell and sample workflow work offline after the first load.

Use /partner for live operations. Google sign-in and phone sign-in use the shared backend and the enrolled partner lists in .env.example. Phone sign-in requires PRINTBEE_PARTNER_PHONES and the PRINTBEE_TWILIO_VERIFY_SERVICE, PRINTBEE_TWILIO_ACCOUNT, and PRINTBEE_TWILIO_TOKEN settings. The backend verifies the customer delivery code, and the panel polls for updates and sends the latest accurate GPS point approximately every five seconds during active deliveries. The preview cache contains static assets only. Google Maps navigation uses external directions links.

For the full live phone flow, deploy the existing backend behind an HTTPS origin and open /partner on the phone. Localhost on a phone points to the phone itself. For a local-network demo on a second device, use an HTTPS development endpoint reachable from that device. HTTPS (or browser-local loopback) is required for installation, GPS, and service workers.

## Remaining production work

The project still uses its existing Python and SQLite stack. The live maps embed, provider-specific directions/ETAs, push credentials, signature-protected photo proof, onboarding and approval UI, QR or warehouse pickup verification, OTP resend and fallback, detailed earnings/payouts, persistent location trails, and nearest-rider offers remain open. Live SMS and GPS were not tested with provider credentials or a physical phone.

## "The Hive" redesign

The PrintBee Partner button returns to the cockpit and keeps the selected live or sample mode.
The cockpit shows shift controls, available or active deliveries, and earnings. Assigned orders
show Google Maps directions for warehouse pickup and customer drop-off.

- **Slide to act.** Go online/offline, accept, arrive, confirm pickup and "with the customer" are
  clay slides with spring-back and a haptic tick. Enter/Space or arrow keys complete them.
- **Honey jar + weekly comb.** Earned today fills a glass jar (SVG wave) toward the daily goal and
  drips on a new payout; the weekly goal fills 14 comb cells.
- **Ticket receipts.** Deliveries are perforated boarding-pass tickets with Settled/Awaiting
  stamps, a pending shimmer, All/Awaiting/Settled filters and CSV export.
- **OTP clay keys.** Four keys with auto-advance, paste, a shake on a wrong code, the existing
  3-tries/60-second lockout, and a hexagon confetti burst on "Delivered!".
- **Partner ID badge.** A 3D-tilting card (pointer or gyro) with a holographic hex sheen, rating
  star-comb and a real, scannable QR code (`PRINTBEE:PARTNER:<id>`, ISO 18004 byte mode, EC M).
  It flips to vehicle and documents.
- **Sun Hive / Moon Hive.** Animated sun-to-moon toggle with a circular View Transition reveal.
- **Layout.** Desktop has a side dock and two cockpit columns. Tablet has a bottom dock and two
  columns. Phones have a single scrolling column and bottom navigation with safe-area insets.
- **Delivery navigation.** Active orders show directions in the cockpit, with a shortcut from
  Earnings and Profile (order, ETA, stepper Pickup → In transit → Arrived →
  OTP, Google Maps "Navigate"), Ctrl/Cmd+K command palette (pages, theme, online/offline, CSV,
  orders), illustrated empty/loading/error/offline states, honey skeletons, hex-ripple page
  changes, reduced-motion support, 44 px targets and polite/assertive live regions.

Review shortcuts in sample mode: `/partner?preview=1&scene=active` (mid-delivery),
`&scene=online`, `&tab=Earnings|Profile`, `&theme=moon|sun`. A scene is never saved.
Screenshots at 1920/1440/1024/768/390 in both themes are in `docs/partner-hive/`.

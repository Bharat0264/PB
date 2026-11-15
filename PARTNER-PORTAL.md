# PrintBee delivery partner portal

Run the existing Python application with python server.py and open /partner?preview=1 for the sample cockpit. No account, location permission, or provider credentials are needed. Go online, accept a sample order, confirm pickup, and deliver using demo code 4816. Reset the demo from Profile. Sample state persists on that browser. In Chrome or Edge the demo can be installed from the browser menu, and its shell and sample workflow work offline after the first load.

Use /partner for live operations. Google sign-in and phone sign-in use the shared backend and the enrolled partner lists in .env.example. Phone sign-in requires PRINTBEE_PARTNER_PHONES and the PRINTBEE_TWILIO_VERIFY_SERVICE, PRINTBEE_TWILIO_ACCOUNT, and PRINTBEE_TWILIO_TOKEN settings. The backend verifies the customer delivery code, and the panel polls for updates and sends the latest accurate GPS point approximately every five seconds during active deliveries. The preview cache contains static assets only. Google Maps navigation uses external directions links.

For the full live phone flow, deploy the existing backend behind an HTTPS origin and open /partner on the phone. Localhost on a phone points to the phone itself. For a local-network demo on a second device, use an HTTPS development endpoint reachable from that device. HTTPS (or browser-local loopback) is required for installation, GPS, and service workers.

## Remaining production work

The project still uses its existing Python and SQLite stack. The live maps embed, provider-specific directions/ETAs, push credentials, signature-protected photo proof, onboarding and approval UI, QR or warehouse pickup verification, OTP resend and fallback, detailed earnings/payouts, persistent location trails, and nearest-rider offers remain open. Live SMS and GPS were not tested with provider credentials or a physical phone.

## "The Hive" redesign

The partner portal UI was rebuilt around a hive metaphor. The data layer (API calls, polling,
GPS, sample mode, OTP rules, CSV export, sign-in) is unchanged; only `partner.html`,
`partner.css` and `partner.js` were rewritten, plus the preview service-worker asset list.

- **Map-first cockpit.** An illustrated vector map of the SRM campus fills the screen (pan, pinch,
  wheel zoom, arrow keys, +/-). Day and night map styles. Works offline, no tiles or keys.
- **Demand hexes.** An H3-style pointy hex grid (125 m) glows from pale honey to amber by demand;
  hot cells pulse. Tap a hex (or a "Hot zone" chip in the legend) for expected orders, earnings
  per hour and the +₹15 bonus. The grid is computed locally; h3-js was not added (about 1 MB).
- **Flying bee.** The partner marker is the PrintBee mascot with a CSS wing flutter, rotated to
  its heading, with a fading honey-dot trail. Offline, it sleeps on a flower with Zzz. In sample
  mode it flies the route; live, it follows the GPS fix the portal already collects.
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
- **Buzz, the co-pilot.** One contextual tip at a time (hot zone direction, rain, OTP, streak,
  settlement day). Dismissable; at most one every 30 seconds, quiet for a minute after dismissal.
- **Sun Hive / Moon Hive.** Animated sun-to-moon toggle with a circular View Transition reveal.
  Moon Hive has its own deep-brown and amber token set, a dark map and fireflies.
- **Layout.** Desktop ≥1280: floating 72 px dock with a gliding bee indicator, top-right cluster,
  400 px left rail and 380 px right rail on the same rails as the brand and cluster. Tablet:
  bottom pill dock, two-column panels over the map. Mobile: full-screen map, a draggable bottom
  sheet with peek/half/full snaps (handle works by keyboard), bottom nav, safe-area insets.
- **Everywhere.** Sticky active-delivery bar (order, ETA, stepper Pickup → In transit → Arrived →
  OTP, Google Maps "Navigate"), Ctrl/Cmd+K command palette (pages, theme, online/offline, CSV,
  orders), illustrated empty/loading/error/offline states, honey skeletons, hex-ripple page
  changes, reduced-motion support, 44 px targets and polite/assertive live regions.

Review shortcuts in sample mode: `/partner?preview=1&scene=active` (mid-delivery),
`&scene=online`, `&tab=Earnings|Profile`, `&theme=moon|sun`. A scene is never saved.
Screenshots at 1920/1440/1024/768/390 in both themes are in `docs/partner-hive/`.

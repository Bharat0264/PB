# PrintBee delivery partner portal

Run the existing Python application with python server.py and open /partner?preview=1 for the sample cockpit. No account, location permission, or provider credentials are needed. Go online, accept a sample order, confirm pickup, and deliver using demo code 4816. Reset the demo from Profile. Sample state persists on that browser. In Chrome or Edge the demo can be installed from the browser menu, and its shell and sample workflow work offline after the first load.

Use /partner for live operations. Google sign-in and phone sign-in use the shared backend and the enrolled partner lists in .env.example. Phone sign-in requires PRINTBEE_PARTNER_PHONES and the PRINTBEE_TWILIO_VERIFY_SERVICE, PRINTBEE_TWILIO_ACCOUNT, and PRINTBEE_TWILIO_TOKEN settings. The backend verifies the customer delivery code, and the panel polls for updates and sends the latest accurate GPS point approximately every five seconds during active deliveries. The preview cache contains static assets only. Google Maps navigation uses external directions links.

For the full live phone flow, deploy the existing backend behind an HTTPS origin and open /partner on the phone. Localhost on a phone points to the phone itself. For a local-network demo on a second device, use an HTTPS development endpoint reachable from that device. HTTPS (or browser-local loopback) is required for installation, GPS, and service workers.

## Remaining production work

The project still uses its existing Python and SQLite stack. The live maps embed, provider-specific directions/ETAs, push credentials, signature-protected photo proof, onboarding and approval UI, QR or warehouse pickup verification, OTP resend and fallback, detailed earnings/payouts, persistent location trails, and nearest-rider offers remain open. Live SMS and GPS were not tested with provider credentials or a physical phone.

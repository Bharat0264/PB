# Customer email sign-in

Customers open Profile, enter their email, and confirm sign-in from the link they receive. The link can be used once and expires after 15 minutes. New orders require a signed-in session. Existing order tracking links still work. Saved contact details and order history remain browser-local.

Set these environment variables before starting server.py:

| Variable | Value |
| --- | --- |
| PRINTBEE_ORIGIN | Exact public origin, such as https://www.printbee.co.in, or http://127.0.0.1:4188 for local testing |
| PRINTBEE_SMTP_HOST | Your mail provider's SMTP hostname |
| PRINTBEE_SMTP_PORT | STARTTLS port, defaults to 587 |
| PRINTBEE_SMTP_FROM | Verified sender address |
| PRINTBEE_SMTP_USER | SMTP username when authentication is required |
| PRINTBEE_SMTP_PASSWORD | SMTP password or app password when authentication is required |

Restart PrintBee after setting these variables. Keep SMTP credentials in the server environment. For a public installation, serve the Python app behind an HTTPS reverse proxy and configure PRINTBEE_ORIGIN to match the address customers use. Without SMTP configuration the site reports that email sign-in is unavailable.

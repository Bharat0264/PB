# PrintBee warehouse and print agent

The warehouse reuses the shared Python/SQLite backend and its existing paid-order rules. It doesn't need a second database. Open /warehouse?preview=1 for a login-free demo. Print, pack, and simulate pickup using the sample orders. Reload to reset the demo. The preview does not call warehouse APIs or the physical printer.

## Live setup

1. Install requirements with python -m pip install -r requirements.txt and run python server.py.
2. Set the existing Google sign-in settings in .env.example, including PRINTBEE_GOOGLE_WAREHOUSE_EMAILS. Open /warehouse to sign in. The data and print endpoints enforce warehouse authorization; the agent has its own credential.
3. Set PRINTBEE_PRINT_AGENT_KEY on the warehouse workstation. Obtain it from your server's staff keys. On Windows run python print_agent.py --origin https://your-printbee-host --printer "Printer name" --sumatra "C:\path\SumatraPDF.exe". On Linux or macOS, configure CUPS and omit --sumatra. For DOCX, make LibreOffice available or set PRINTBEE_SOFFICE.
4. For Windows sign-in startup, run print-agent/install-windows.ps1 with the same printer, Sumatra, and origin values. Store the agent key as a user-scoped environment variable. The scheduled task runs as that user, so use a dedicated Windows account with the printer installed.
5. To validate a local PDF without any connection or print, run python print_agent.py --dry-run sample.pdf.

## End-to-end checklist

- Demo: Open a New order, print all, wait for Printed, complete the packing checklist, mark packed, then simulate pickup. Check History and export a CSV.
- Staging: create an order in Razorpay test mode. Verify it stays out of the warehouse before a valid captured-payment webhook. Verify a repeated webhook doesn't create another order.
- Hardware: print a one-page sample on the intended device. Check paper size, colour/mono, duplex, and copies. The existing agent reports spooler submission, so confirm physical output at the printer before packing.
- If a submission times out, inspect the spooler before asking an admin to recover the job. Automatic respooling could print it twice.

## Current scope

The live panel uses polling and reconnects by refreshing the order snapshot. Printing uses the existing authenticated HTTP claim protocol and a configured workstation printer. Inventory, pause/test controls and staff-side handover simulation are demo features. The live flow uses the existing partner pickup and downloadable packing label.

Open items include the requested Prisma and TypeScript migration, WebSocket transport, OTP/PIN access, per-device enrollment, printer discovery and routing, hardware confirmation, partial reprints with reason audit, retention, inventory deduction, issue/reupload workflow and warehouse QR handover. No physical printer was used during development.

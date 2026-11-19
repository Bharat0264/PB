# PrintBee warehouse and print agent

The warehouse reuses the shared Python/SQLite backend and its existing paid-order rules. It doesn't need a second database. Open /warehouse?preview=1 for a login-free demo. Print, pack, and simulate pickup using the sample orders. Reload to reset the demo. The preview does not call warehouse APIs or a physical printer. Its Printers page uses four made-up printers, so you can try adding one, the Print to sheet and Send to another printer.

## Live setup

1. Install requirements with python -m pip install -r requirements.txt and run python server.py.
2. Set the existing Google sign-in settings in .env.example, including PRINTBEE_GOOGLE_WAREHOUSE_EMAILS. Open /warehouse to sign in. The data and print endpoints enforce warehouse authorization; the agent has its own credential.
3. On the print-room computer install the agent's one extra package: python -m pip install -r print-agent/requirements.txt (this is zeroconf, used to find printers on the Wi-Fi or network; the web server does not need it).
4. Set PRINTBEE_PRINT_AGENT_KEY on the warehouse workstation. Obtain it from your server's staff keys. On Windows run python print_agent.py --origin https://your-printbee-host --sumatra "C:\path\SumatraPDF.exe". On Linux or macOS, configure CUPS and omit --sumatra. For DOCX, make LibreOffice available or set PRINTBEE_SOFFICE. The --printer option is now only the fallback for printers you have not added in the panel.
5. For Windows sign-in startup, run print-agent/install-windows.ps1 with the same Sumatra and origin values. Store the agent key as a user-scoped environment variable. The scheduled task runs as that user, so use a dedicated Windows account with the printers installed.
6. To validate a local PDF without any connection or print, run python print_agent.py --dry-run sample.pdf.

## Adding printers (discovery)

Open Printers in the warehouse panel and press Add printer.

1. The server cannot reach your printers, so the panel asks the agent. The agent notices within about 3 seconds, scans, and sends the list back. Nothing here opens a port on your network: the agent only makes outbound HTTPS calls, signed in with the print-agent key.
2. Found printers are suggestions. Nothing prints on a printer until you pick it, name it and add it. The agent only prints to printers the server has approved.
3. After adding, the agent reports each printer's state (ready, busy, offline, paper out, toner low, error) every 20 seconds and straight away when it changes, and rescans every 10 minutes or when asked.

To check this computer can see your printers without the server, run:

    python print_agent.py --list-printers
    python print_agent.py --list-printers --add-ip 192.168.1.40

To try everything with no printer at all, start the agent with --mock-discovery (or PRINTBEE_MOCK_PRINTERS=1). It reports a black-and-white laser on USB, a colour inkjet on Wi-Fi, one that is switched off and one that is out of paper. Add --mock-printer too and jobs finish without calling a spooler.

### How a job picks a printer

- In the order station, Print opens Print to. The best match is chosen: a colour file goes to the default colour printer, a black-and-white file to the default black-and-white printer, otherwise the printer used most recently. Choose Remember my choice to keep your pick.
- Paused, offline, out-of-paper and unsuitable printers are greyed out with the reason (No colour, No A3, No double-sided, Out of paper). The server checks the same rules, so a bad choice is refused even if the page is out of date.
- If the chosen printer stops working after a file is queued, the file stays queued as Waiting for printer (other printers carry on) and Send to another printer moves it in one step. A file already being printed or finished never moves, and a file is never printed twice.
- A printer that accepts PDF over IPP gets the file directly with copies, sides, colour mode, paper size, page range and orientation. Any other printer uses the installed queue through SumatraPDF or lp, as before.
- Print a test page from a printer's card to check it. It is sent once even if pressed twice.

### Firewall and network notes

- The print-room computer must reach your PrintBee address over HTTPS (outbound). No inbound rule is needed.
- To find Wi-Fi/LAN printers the computer must be on the same network (same subnet or VLAN) as the printers. mDNS (Bonjour) does not cross routers. A printer on a different network will not be found automatically: add it with Can't find it? Enter IP address, which works if the computer can route to it (port 631 for IPP).
- Windows Firewall must allow Python or the agent to send and receive mDNS (UDP 5353) on private networks. If the scan finds nothing but the IP address works, mDNS is probably blocked.
- Manual addresses must be on a private network. The agent refuses public addresses.

### Supported printers and limits

- Found automatically: printers installed on this computer (Windows through PowerShell, Linux and macOS through CUPS), and network printers that announce _ipp._tcp, _ipps._tcp, _printer._tcp or _pdl-datastream._tcp (nearly all printers made since 2012).
- Direct IPP printing needs the printer to accept application/pdf. Many laser and business inkjet printers do; some budget printers do not and are used through their installed queue instead.
- A USB printer must be installed on the print-room computer to print. A printer found only by raw port 9100 cannot be driven without a queue.
- Colour, double-sided and paper sizes come from the printer's own report. If a printer reports nothing, it is treated as able to print A4 and nothing is blocked.
- Toner and ink levels appear only on printers that report them. Mixed-colour files still need manual printing.
- Up to 12 printers can be added. The panel shows A4, A5, Letter, Legal and A3.
- A printer that goes quiet for 2 minutes is shown offline. If the whole print computer goes quiet, the page says the agent is offline and files wait.

### Needs attention

Out of paper, toner low, offline or error on an added printer shows on the Printers page, in a chip at the top of the warehouse panel, and in the admin dashboard under Needs attention. A silent print agent is reported once, not once per printer.

## End-to-end checklist

- Demo: Open a New order, print all, wait for Printed, complete the packing checklist, mark packed, then simulate pickup. Check History and export a CSV.
- Staging: create an order in Razorpay test mode. Verify it stays out of the warehouse before a valid captured-payment webhook. Verify a repeated webhook doesn't create another order.
- If a submission times out, inspect the spooler before asking an admin to recover the job. Automatic respooling could print it twice.

## Real-hardware checklist (not done during development: no physical printer was used)

Tick each on the real print-room computer.

- [ ] Run python print_agent.py --list-printers. Your USB printer, your Wi-Fi printer and any installed queues all appear, once each (a printer that is both USB and on Wi-Fi may be shown once).
- [ ] USB printer: add it, name it, print a test page. Then print a one-page order file. Check paper size, colour or black and white, double-sided and copies.
- [ ] Wi-Fi printer: add it, print a test page. Note whether it says it accepts PDF directly, and print an A4 colour file, a double-sided file and a page-range file.
- [ ] Switch a printer off. Within about 2 minutes the card shows Offline, a chip appears at the top, and the admin dashboard lists it. Queue a file for it: it shows Waiting for printer, and Send to another printer moves it and prints.
- [ ] Take the paper out of a printer that reports it. The card shows Out of paper (some printers do not report this; note which).
- [ ] A printer on a different network or VLAN is not found by scanning. Add it with its IP address and check it works, or confirm the message explains what to do.
- [ ] Stop the agent. The Printers page shows Offline with the three start steps, and files stay queued. Start it again and the waiting files print once each.
- [ ] Add a printer, press Print twice on the test page quickly: only one page prints.
- [ ] Remove a printer that has a file waiting: the file moves to the default printer.
- [ ] Confirm physical output at the printer before packing. The agent reports that a job was handed to the printer, not that paper came out.

## Current scope

The live panel uses polling and reconnects by refreshing the order snapshot. Printing uses the authenticated HTTP claim protocol, now with approved printers, live printer state and per-file printer choice. Inventory, the mock queue pause and staff-side handover simulation are demo features. The live flow uses the existing partner pickup and downloadable packing label.

Open items include the requested Prisma and TypeScript migration, WebSocket transport, OTP/PIN access, per-device enrollment, hardware confirmation, partial reprints with reason audit, retention, inventory deduction, issue/reupload workflow and warehouse QR handover.

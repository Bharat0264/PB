"""Run on a warehouse workstation to submit queued PDF jobs to its spooler."""

import argparse
import json
import os
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from document_pages import render_docx
from print_discovery import IppError, IppTimeout, PrinterManager, ipp_print, scan_inventory, mock_printers


def print_command(item, file, printer, sumatra=None):
    if item.get("colourPages"):
        raise ValueError("Mixed-colour pages require manual printing.")
    pages = ",".join(map(str, item["pageRange"])) if item.get("pageRange") else f"1-{item['pages']}"
    paper = item.get("paper", "A4")
    landscape = item["orientation"] == "Landscape"
    if sumatra:
        duplex = ("duplexshort" if landscape else "duplexlong") if item["duplex"] else "simplex"
        settings = ",".join((pages, f"{item['copies']}x", "color" if item["colour"] else "monochrome",
                             duplex, "landscape" if landscape else "portrait", "paper=" + paper))
        return [sumatra, "-print-to", printer, "-print-settings", settings, "-silent", str(file)]
    sides = ("two-sided-short-edge" if landscape else "two-sided-long-edge") if item["duplex"] else "one-sided"
    return ["lp", "-d", printer, "-n", str(item["copies"]), "-P", pages, "-o", "media=" + paper,
            "-o", "sides=" + sides, "-o", "orientation-requested=" + ("4" if landscape else "3"),
            "-o", "print-color-mode=" + ("color" if item["colour"] else "monochrome"), "--", str(file)]


def print_job(target, item, file, sumatra=None, mock=False, manager=None, ipp_send=None, runner=subprocess.run):
    """Print one job on `target`: a printer id the server approved, or (older servers) a plain printer name.
    A printer that takes PDF over IPP gets the job directly with every setting as an IPP attribute; anything else goes through the
    installed queue (SumatraPDF on Windows, lp on Linux and macOS). Returns "ipp" or "queue" (which way it went)."""
    rec = manager.record_for(target) if manager else None
    approved = manager.approved_ids() if manager else None
    if approved is not None and str(target).startswith("p_") and target not in approved:
        raise ValueError("That printer has not been approved for printing. Add it on the Printers page.")
    if rec and rec["state"] == "offline":
        raise ValueError("That printer is offline.")
    if rec and rec["capabilities"]["pdf"] and rec.get("ipp"):
        if item.get("colourPages"):
            raise ValueError("Mixed-colour pages require manual printing.")
        if not mock:
            try:
                (ipp_send or ipp_print)(rec["ipp"], Path(file).read_bytes(), item)
            except IppTimeout:
                raise subprocess.TimeoutExpired("ipp", 60)          # it may have printed: same rule as a spooler timeout
            except IppError as error:
                raise ValueError(str(error))
        return "ipp"
    queue = rec.get("queue") if rec else target
    if not queue:
        raise ValueError("This printer has no print queue on this PC. Install it in Windows or CUPS, then scan again.")
    command = print_command(item, file, queue, sumatra)
    if not mock:                # mock printer: everything but the spooler call runs, so jobs complete end to end
        runner(command, check=True, timeout=120, capture_output=True)
    return "queue"


def run(origin, key, printer, sumatra, once, mock=False, manager=None):
    def request(path, body=None, claim=""):
        data = None if body is None else json.dumps(body).encode()
        headers = {"X-Staff-Key": key, "Content-Type": "application/json", "X-Print-Claim": claim}
        with urlopen(Request(origin + "/api/print-agent/" + path, data=data, headers=headers), timeout=60) as response:
            return response.read()

    backoff = 3
    while True:
        try:
            if manager:
                manager.tick(request)       # scan requests, inventory and printer status; slow work runs in the background
            job = json.loads(request("claim", manager.heartbeat() if manager else {}))["job"]
        except OSError:
            if once:
                raise
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)
            continue
        backoff = 3
        if not job:
            if once:
                return
            time.sleep(3)
            continue
        path = f"jobs/{job['id']}"
        try:
            body = request(path + "/file", claim=job["claim"])
            if not body.startswith(b"%PDF-"):
                suffix = Path(job["item"]["name"]).suffix.lower()
                if suffix == ".docx":
                    body = render_docx(body)
                elif suffix in (".jpg", ".jpeg", ".png"):
                    from io import BytesIO
                    from PIL import Image
                    with Image.open(BytesIO(body)) as image:
                        image = image.convert("RGB")
                        output = BytesIO()
                        image.save(output, format="PDF")
                        body = output.getvalue()
                if not body or not body.startswith(b"%PDF-"):
                    raise ValueError("Convert this file to PDF for automated printing or print it manually.")
            with tempfile.TemporaryDirectory(prefix="printbee-job-") as directory:
                file = Path(directory) / "document.pdf"
                file.write_bytes(body)
                target = job.get("printer") or printer
                if not target:
                    raise ValueError("No printer is set. Add a printer in the warehouse Printers page or start the agent with --printer.")
                print_job(target, job["item"], file, sumatra, mock, manager)
            result = {"state": "done"}
        except subprocess.TimeoutExpired:
            raise SystemExit(f"Print job {job['id']} may have reached the printer. Check the spooler before recovering it.")
        except (OSError, subprocess.SubprocessError, ValueError) as error:
            result = {"state": "failed", "error": str(error) if isinstance(error, ValueError) else "Printer or file request failed."}
        for attempt in range(3):
            try:
                request(path + "/result", result, job["claim"])
                break
            except OSError:
                if attempt == 2:
                    raise
                time.sleep(2)
        if once:
            return


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", default="http://127.0.0.1:4188")
    parser.add_argument("--printer")
    parser.add_argument("--dry-run", metavar="PDF", type=Path,
                        help="Validate a local sample PDF and exit without contacting the server or printer.")
    parser.add_argument("--mock-printer", action="store_true",
                        help="Run the real job loop against the server but do not call the printer (demo and tests).")
    parser.add_argument("--sumatra", help="Path to SumatraPDF.exe on Windows")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--list-printers", action="store_true",
                        help="Scan for printers, print what was found and exit. Needs no server or key: use it to check this PC can see your printers.")
    parser.add_argument("--add-ip", action="append", default=[], metavar="ADDRESS", help="With --list-printers: also ask this IP address or hostname.")
    parser.add_argument("--mock-discovery", action="store_true", default=os.environ.get("PRINTBEE_MOCK_PRINTERS") == "1",
                        help="Report four made-up printers instead of scanning (demo and tests). Also set by PRINTBEE_MOCK_PRINTERS=1.")
    parser.add_argument("--no-discovery", action="store_true", help="Do not scan for printers; print only to the --printer name, as before.")
    args = parser.parse_args()
    if args.list_printers:
        result = {"printers": mock_printers(), "errors": []} if args.mock_discovery else scan_inventory(manual=args.add_ip)
        for p in result["printers"]:
            c = p["capabilities"]
            print(f"{p['model']}  [{p['connection']}]  {p['state']}  {p['host'] or ''}  colour={c['colour']} duplex={c['duplex']} paper={','.join(c['paperSizes'])} pdf-over-ipp={c['pdf']}")
        for message in result["errors"]:
            print("Note:", message)
        print(f"{len(result['printers'])} printer(s) found.")
        raise SystemExit(0)
    if args.dry_run:
        from document_pages import count_pages
        try:
            pages = count_pages("sample.pdf", args.dry_run.read_bytes())
            print_command({"pages": pages, "copies": 1, "duplex": False, "colour": False,
                           "orientation": "Portrait"}, args.dry_run, "Mock printer", args.sumatra)
        except (OSError, ValueError) as error:
            parser.error(str(error))
        print(f"Mock printer validated {pages} page(s). No job was sent.")
        raise SystemExit(0)
    origin = urlsplit(args.origin)
    if origin.scheme != "https" and not (origin.scheme == "http" and origin.hostname in ("localhost", "127.0.0.1")):
        parser.error("Use HTTPS or a local server.")
    if os.name == "nt" and not args.sumatra and not args.mock_printer:
        parser.error("Provide --sumatra on Windows.")
    key = os.environ.get("PRINTBEE_PRINT_AGENT_KEY")
    if not key:
        parser.error("Set PRINTBEE_PRINT_AGENT_KEY.")
    manager = None if args.no_discovery or args.once else PrinterManager(mock=args.mock_discovery)
    run(args.origin.rstrip("/"), key, args.printer or ("Mock printer" if args.mock_printer else None), args.sumatra, args.once, args.mock_printer, manager)

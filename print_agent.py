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


def run(origin, key, printer, sumatra, once):
    def request(path, body=None, claim=""):
        data = None if body is None else json.dumps(body).encode()
        headers = {"X-Staff-Key": key, "Content-Type": "application/json", "X-Print-Claim": claim}
        with urlopen(Request(origin + "/api/print-agent/" + path, data=data, headers=headers), timeout=60) as response:
            return response.read()

    while True:
        job = json.loads(request("claim", {}))["job"]
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
                subprocess.run(print_command(job["item"], file, printer, sumatra),
                               check=True, timeout=120, capture_output=True)
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
    parser.add_argument("--printer", required=True)
    parser.add_argument("--sumatra", help="Path to SumatraPDF.exe on Windows")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    origin = urlsplit(args.origin)
    if origin.scheme != "https" and not (origin.scheme == "http" and origin.hostname in ("localhost", "127.0.0.1")):
        parser.error("Use HTTPS or a local server.")
    if os.name == "nt" and not args.sumatra:
        parser.error("Provide --sumatra on Windows.")
    key = os.environ.get("PRINTBEE_PRINT_AGENT_KEY")
    if not key:
        parser.error("Set PRINTBEE_PRINT_AGENT_KEY.")
    run(args.origin.rstrip("/"), key, args.printer, args.sumatra, args.once)

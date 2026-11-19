"""Printer discovery for the PrintBee print agent (runs on the print-room PC; the server can never reach printers).

What it finds, and how:
  * printers installed on this PC: Windows through PowerShell (Get-Printer plus .NET PrinterSettings for colour, duplex and paper sizes),
    Linux and macOS through CUPS (lpstat and lpoptions);
  * printers on the Wi-Fi or LAN: mDNS / Bonjour browse for _ipp._tcp, _ipps._tcp, _printer._tcp and _pdl-datastream._tcp (the zeroconf package,
    pinned in print-agent/requirements.txt, imported only when a scan runs), whose TXT records are read;
  * every printer with an address is then asked over IPP (Get-Printer-Attributes) for its state, state reasons, formats, colour, duplex, paper
    sizes and ink or toner levels;
  * a printer that does not announce itself can be added by IP address or hostname (private networks only).
The same printer seen several ways (USB, a Windows queue, the network) is merged into one record, by UUID or by model name plus address.

Everything here that talks to the outside is injectable and everything that reads text is a plain function, so it is all tested without hardware.
A MOCK mode (PRINTBEE_MOCK_PRINTERS=1 or --mock-discovery) returns four made-up printers so the panel can be built and tested with no printer at all.
Nothing found here is trusted by the server: they are only suggestions, and the agent prints only to printers the server has approved.
"""

import concurrent.futures
import hashlib
import ipaddress
import json
import os
import re
import socket
import ssl
import struct
import subprocess
import threading
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

VERSION = 1
STATES = ("ready", "busy", "offline", "paper-out", "toner-low", "error")
RANK = {"ready": 0, "busy": 1, "toner-low": 2, "error": 3, "paper-out": 4, "offline": 5}     # when several things are wrong, the worst one is shown
PAPER_ORDER = ("A5", "Letter", "A4", "Legal", "A3")                                             # smallest to largest sheet
MEDIA_KEYWORD = {"A4": "iso_a4_210x297mm", "A3": "iso_a3_297x420mm", "A5": "iso_a5_148x210mm", "Letter": "na_letter_8.5x11in", "Legal": "na_legal_8.5x14in"}
VIRTUAL = re.compile(r"(print to pdf|xps document writer|onenote|\bfax\b|adobe pdf|cutepdf|pdf24|pdfcreator|snagit|cups-pdf)", re.I)
SERVICES = ("_ipp._tcp.local.", "_ipps._tcp.local.", "_printer._tcp.local.", "_pdl-datastream._tcp.local.")


# ---- one printer record: the same shape whatever found it -------------------------------------------------

def normalise_model(text):
    """'HP LaserJet Pro M404dn (copy 1)' and 'hp laserjet pro m404dn series' give the same key."""
    text = re.sub(r"\(.*?\)|\[.*?\]", " ", str(text or "").lower())
    text = re.sub(r"\b(series|printer|mfp|all-in-one|aio|ipp|wireless|network|class driver)\b", " ", text)
    return re.sub(r"[^a-z0-9]", "", text)


def paper_names(names):
    """Only the sheet sizes PrintBee sells, in order, from any list of names or media keywords."""
    found = set()
    for name in names or ():
        s = str(name)
        for size, pattern in (("A3", r"(^|[^a-z0-9])(a3|iso_a3)([^a-z0-9]|$)"), ("A4", r"(^|[^a-z0-9])(a4|iso_a4)([^a-z0-9]|$)"), ("A5", r"(^|[^a-z0-9])(a5|iso_a5)([^a-z0-9]|$)"),
                              ("Letter", r"(^|[^a-z0-9])(letter|na_letter)([^a-z0-9]|$)"), ("Legal", r"(^|[^a-z0-9])(legal|na_legal)([^a-z0-9]|$)")):
            if re.search(pattern, s, re.I):
                found.add(size)
    return [size for size in PAPER_ORDER if size in found]


def make_id(uuid, model, host, queue):
    """A stable id: from the printer's own UUID when it has one (so it survives a new IP address), else from model and address."""
    key = f"uuid:{uuid.lower()}" if uuid else f"{normalise_model(model)}|{host or ''}|{'' if host else (queue or '')}"
    return "p_" + hashlib.sha1(key.encode()).hexdigest()[:12]


def record(model, connection, *, host=None, port=None, queue=None, ipp=None, uuid=None, state="ready", reasons=(), colour=False, duplex=False,
           papers=(), pdf=False, page_ranges=False, supplies=(), sources=(), note="", mock=False):
    papers = paper_names(papers)
    return {"id": make_id(uuid, model, host, queue), "model": str(model or "Printer").strip()[:80], "connection": connection, "connections": [connection],
            "host": host, "port": port, "queue": queue, "ipp": ipp, "uuid": uuid or None, "state": state, "reasons": list(dict.fromkeys(reasons)),
            "capabilities": {"colour": bool(colour), "duplex": bool(duplex), "paperSizes": papers, "maxSize": papers[-1] if papers else None,
                             "pdf": bool(pdf), "pageRanges": bool(page_ranges)},
            "supplies": list(supplies), "sources": list(sources), "note": str(note or "")[:120], "mock": bool(mock)}


def worst_state(states):
    return max(states or ["ready"], key=lambda s: RANK.get(s, 0))


# ---- Windows: PowerShell ----------------------------------------------------------------------------------

WINDOWS_SCRIPT = r"""
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing
$ports = @{}
Get-PrinterPort | ForEach-Object { $ports[$_.Name] = $_.PrinterHostAddress }
$out = @()
foreach ($p in Get-Printer) {
  $s = New-Object System.Drawing.Printing.PrinterSettings
  $s.PrinterName = $p.Name
  $cfg = Get-PrintConfiguration -PrinterName $p.Name
  $out += [pscustomobject]@{
    name = $p.Name; status = [string]$p.PrinterStatus; driver = $p.DriverName; port = $p.PortName; host = $ports[$p.PortName];
    colour = [bool]$s.SupportsColor; duplex = [bool]$s.CanDuplex; papers = @($s.PaperSizes | ForEach-Object { $_.PaperName });
    paper = [string]$cfg.PaperSize; valid = [bool]$s.IsValid }
}
ConvertTo-Json -InputObject @($out) -Depth 4 -Compress
"""
WINDOWS_STATUS = {1: "other", 2: "unknown", 3: "idle", 4: "printing", 5: "warmup", 6: "stoppedprinting", 7: "offline", 8: "paused", 9: "error", 10: "busy", 11: "notavailable",
                  12: "waiting", 13: "processing", 14: "initialization", 15: "powersave", 16: "pendingdeletion", 17: "ioactive", 18: "manualfeed"}


def windows_state(status):
    """(state, reasons) from Get-Printer's PrinterStatus, which is a word on new Windows and a number on old."""
    raw = str(status or "").strip()
    word = WINDOWS_STATUS.get(int(raw), "unknown") if raw.isdigit() else raw.lower().replace(" ", "")
    if word in ("normal", "idle", "powersave", "initialization", "warmup", "other", "unknown", ""):
        return "ready", []
    if word in ("printing", "busy", "processing", "waiting", "ioactive", "manualfeed"):
        return "busy", []
    if word in ("offline", "notavailable", "stoppedprinting", "pendingdeletion"):
        return "offline", [word]
    if word == "paused":
        return "offline", ["paused"]
    if word in ("paperout",):
        return "paper-out", ["media-empty"]
    if word in ("tonerlow",):
        return "toner-low", ["toner-low"]
    if word in ("notoner",):
        return "toner-low", ["toner-empty"]
    return "error", [word or "error"]


def host_from_port(port):
    found = re.search(r"(\d{1,3}(?:\.\d{1,3}){3})", str(port or ""))
    return found.group(1) if found else None


def parse_windows_printers(text):
    data = json.loads(text) if text and text.strip() else []
    if isinstance(data, dict):
        data = [data]
    out = []
    for item in data:
        name = str(item.get("name") or "").strip()
        if not name or VIRTUAL.search(name) or VIRTUAL.search(str(item.get("driver") or "")):
            continue
        port = str(item.get("port") or "")
        host = item.get("host") or host_from_port(port)
        connection = "usb" if re.match(r"(usb|dot4|dot\d)", port, re.I) else "network" if host else "pc"
        state, reasons = windows_state(item.get("status"))
        if item.get("valid") is False:
            state, reasons = "offline", reasons + ["not-valid"]
        out.append(record(name, connection, host=host, queue=name, state=state, reasons=reasons, colour=item.get("colour"), duplex=item.get("duplex"),
                          papers=list(item.get("papers") or []) + [item.get("paper") or ""], sources=["installed"], note=str(item.get("driver") or "")))
    return out


# ---- Linux and macOS: CUPS --------------------------------------------------------------------------------

def parse_lpstat_p(text):
    """{queue: (state, reasons)} from `lpstat -p`: 'printer X is idle.', 'printer X now printing X-12.', 'printer X disabled since ...' + a reason line."""
    out, name = {}, None
    for line in text.splitlines():
        found = re.match(r"printer (\S+) (.*)", line)
        if found:
            name, rest = found.group(1), found.group(2).lower()
            if "disabled" in rest:
                out[name] = ("offline", ["disabled"])
            elif "now printing" in rest or "processing" in rest:
                out[name] = ("busy", [])
            else:
                out[name] = ("ready", [])
        elif name and line.startswith(("\t", " ")) and line.strip() and out[name][0] == "offline":
            out[name][1].append(line.strip().lower()[:60])
    return out


def parse_lpstat_v(text):
    """{queue: device-uri} from `lpstat -v`."""
    return {m.group(1): m.group(2).strip() for m in re.finditer(r"device for (\S+?):\s*(\S+)", text)}


def parse_lpoptions(text):
    """(colour, duplex, papers) from `lpoptions -p X -l`."""
    colour = duplex = False
    papers = []
    for line in text.splitlines():
        head, _, values = line.partition(":")
        key = head.split("/")[0].strip().lower()
        options = [v.lstrip("*") for v in values.split()]
        if key in ("colormodel", "printcolormode", "ripcolor", "colorsel", "color", "cncolormode"):
            colour = colour or any(re.search(r"rgb|color|colour|cmyk", o, re.I) and not re.search(r"gray|grey|mono|black", o, re.I) for o in options)
        elif key in ("duplex", "sides", "ejduplex", "kduplex"):
            duplex = duplex or any(not re.match(r"(none|off|false|one|simplex)", o, re.I) for o in options)
        elif key in ("pagesize", "media", "papersize"):
            papers += options
    return colour, duplex, papers


def uri_connection(uri):
    """(connection, host) from a CUPS device URI."""
    uri = (uri or "").strip()
    if uri.lower().startswith("usb:"):
        return "usb", None
    found = re.match(r"(?:ipps?|socket|lpd|http|https|smb|ipp14)://(?:[^@/]*@)?(\[[^\]]+\]|[^:/\s]+)", uri, re.I)
    if found:
        return "network", found.group(1).strip("[]")
    if uri.lower().startswith(("dnssd:", "mdns:")):
        return "network", None
    return "pc", None


def run_command(args, timeout=25):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
    return result.stdout


def installed_printers(runner=run_command, system=None):
    """(records, error). Windows through PowerShell, everything else through CUPS."""
    system = system or ("windows" if os.name == "nt" else "cups")
    try:
        if system == "windows":
            return parse_windows_printers(runner(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_SCRIPT], 30)), None
        states = parse_lpstat_p(runner(["lpstat", "-p"]))
        devices = parse_lpstat_v(runner(["lpstat", "-v"]))
        out = []
        for queue in dict.fromkeys(list(states) + list(devices)):
            if VIRTUAL.search(queue) or VIRTUAL.search(devices.get(queue, "")):
                continue
            colour, duplex, papers = parse_lpoptions(runner(["lpoptions", "-p", queue, "-l"]))
            connection, host = uri_connection(devices.get(queue))
            state, reasons = states.get(queue, ("ready", []))
            out.append(record(queue.replace("_", " "), connection, host=host, queue=queue, state=state, reasons=reasons, colour=colour, duplex=duplex, papers=papers,
                              sources=["installed"]))
        return out, None
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        return [], f"Could not list the printers installed on this PC ({type(error).__name__})."


# ---- IPP: a small encoder and decoder (RFC 8010) ----------------------------------------------------------

OP_PRINT_JOB, OP_GET_PRINTER_ATTRIBUTES = 0x0002, 0x000B
G_OPERATION, G_JOB, G_PRINTER, G_END = 0x01, 0x02, 0x04, 0x03
T_INTEGER, T_BOOLEAN, T_ENUM, T_OCTETS, T_RESOLUTION, T_RANGE, T_BEGCOLL, T_ENDCOLL, T_MEMBER = 0x21, 0x22, 0x23, 0x30, 0x32, 0x33, 0x34, 0x37, 0x4A
T_TEXT, T_NAME, T_KEYWORD, T_URI, T_CHARSET, T_LANG, T_MIME = 0x41, 0x42, 0x44, 0x45, 0x47, 0x48, 0x49
TEXT_TAGS = (0x41, 0x42, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x35, 0x36)


class IppError(Exception):
    """A printer that could not be asked or that refused; the message is short and safe to show."""


class IppTimeout(IppError):
    """The printer went quiet after we connected. For a print job this means it MAY have printed: never send the job again by itself."""


def _value(tag, value):
    if tag in (T_INTEGER, T_ENUM):
        return struct.pack(">i", int(value))
    if tag == T_BOOLEAN:
        return b"\x01" if value else b"\x00"
    if tag == T_RANGE:
        return struct.pack(">ii", int(value[0]), int(value[1]))
    return str(value).encode("utf-8") if not isinstance(value, bytes) else value


def ipp_encode(operation, groups, data=b"", request_id=1):
    """groups: [(group tag, [(value tag, name, [values...]), ...]), ...]. Extra values of an attribute are written with an empty name."""
    out = struct.pack(">BBHI", 1, 1, operation, request_id)
    for group, attributes in groups:
        out += bytes([group])
        for tag, name, values in attributes:
            for index, value in enumerate(values):
                raw = _value(tag, value)
                out += bytes([tag]) + struct.pack(">H", 0 if index else len(name.encode())) + (b"" if index else name.encode()) + struct.pack(">H", len(raw)) + raw
    return out + bytes([G_END]) + data


def _decode_value(tag, raw):
    if tag in (T_INTEGER, T_ENUM) and len(raw) == 4:
        return struct.unpack(">i", raw)[0]
    if tag == T_BOOLEAN:
        return bool(raw[:1] == b"\x01")
    if tag == T_RANGE and len(raw) == 8:
        return struct.unpack(">ii", raw)
    if tag == T_RESOLUTION and len(raw) == 9:
        return struct.unpack(">iib", raw)
    if tag in TEXT_TAGS:
        return raw.decode("utf-8", "replace")
    return raw


def _decode_collection(data, pos):
    """A collection value (for example one media-size): returns ({member: value}, new position)."""
    member, out = None, {}
    while pos < len(data):
        tag = data[pos]
        name_len = struct.unpack(">H", data[pos + 1:pos + 3])[0]
        pos += 3 + name_len
        value_len = struct.unpack(">H", data[pos:pos + 2])[0]
        raw = data[pos + 2:pos + 2 + value_len]
        pos += 2 + value_len
        if tag == T_ENDCOLL:
            return out, pos
        if tag == T_MEMBER:
            member = raw.decode("utf-8", "replace")
        elif tag == T_BEGCOLL:
            out[member], pos = _decode_collection(data, pos)
        elif member is not None:
            out[member] = _decode_value(tag, raw)
    raise IppError("The printer sent an incomplete answer.")


def ipp_decode(data):
    """{'status': code, 'groups': [(group tag, {attribute: [values]})]}"""
    if len(data) < 9:
        raise IppError("The printer sent an empty answer.")
    status = struct.unpack(">H", data[2:4])[0]
    pos, groups, current, last = 8, [], None, None
    try:
        while pos < len(data):
            tag = data[pos]
            pos += 1
            if tag == G_END:
                break
            if tag <= 0x0F:
                current, last = {}, None
                groups.append((tag, current))
                continue
            name_len = struct.unpack(">H", data[pos:pos + 2])[0]
            name = data[pos + 2:pos + 2 + name_len].decode("utf-8", "replace")
            pos += 2 + name_len
            value_len = struct.unpack(">H", data[pos:pos + 2])[0]
            raw = data[pos + 2:pos + 2 + value_len]
            pos += 2 + value_len
            if name:
                last = name
            if current is None or last is None:
                continue
            if tag == T_BEGCOLL:
                value, pos = _decode_collection(data, pos)
            else:
                value = _decode_value(tag, raw)
            current.setdefault(last, []).append(value)
    except (struct.error, IndexError):
        raise IppError("The printer sent a damaged answer.")
    return {"status": status, "groups": groups}


def printer_attributes(response):
    merged = {}
    for tag, attributes in response["groups"]:
        if tag == G_PRINTER:
            merged.update(attributes)
    return merged


def ipp_uri(host, port=631, path="/ipp/print", secure=False):
    host = f"[{host}]" if ":" in host and not host.startswith("[") else host
    return f"{'ipps' if secure else 'ipp'}://{host}:{port}{path}"


REQUESTED = ["printer-state", "printer-state-reasons", "printer-is-accepting-jobs", "printer-make-and-model", "printer-uuid", "printer-info", "document-format-supported",
             "color-supported", "print-color-mode-supported", "sides-supported", "media-supported", "media-size-supported", "page-ranges-supported", "marker-names",
             "marker-levels", "marker-types", "printer-location"]


def operation_attributes(uri, extra=()):
    return (G_OPERATION, [(T_CHARSET, "attributes-charset", ["utf-8"]), (T_LANG, "attributes-natural-language", ["en"]), (T_URI, "printer-uri", [uri]), *extra])


def ipp_post(uri, body, timeout=5, opener=urlopen):
    """POST an IPP message and decode the answer. ipp:// goes over HTTP and ipps:// over HTTPS (printers use self-signed certificates)."""
    secure = uri.lower().startswith("ipps:")
    http = re.sub(r"^ipps?", "https" if secure else "http", uri, flags=re.I)
    kwargs = {"timeout": timeout}
    if secure:
        context = ssl.create_default_context()
        context.check_hostname, context.verify_mode = False, ssl.CERT_NONE
        kwargs["context"] = context
    try:
        with opener(Request(http, data=body, headers={"Content-Type": "application/ipp"}, method="POST"), **kwargs) as response:
            return ipp_decode(response.read())
    except HTTPError as error:
        raise IppError(f"The printer answered with an error ({error.code}).")
    except (OSError, ValueError) as error:
        if isinstance(getattr(error, "reason", error), (TimeoutError, socket.timeout)):
            raise IppTimeout("The printer did not answer in time.")
        raise IppError("The printer did not answer.")


def get_printer_attributes(host, port=631, path=None, secure=False, timeout=3, post=ipp_post):
    """Ask a printer about itself. Tries the usual paths until one answers. Returns the printer attributes (a dict of lists)."""
    last = IppError("The printer did not answer.")
    for candidate in dict.fromkeys([path, "/ipp/print", "/ipp", "/"] if path else ["/ipp/print", "/ipp", "/"]):
        uri = ipp_uri(host, port, candidate, secure)
        try:
            response = post(uri, ipp_encode(OP_GET_PRINTER_ATTRIBUTES, [operation_attributes(uri, [(T_KEYWORD, "requested-attributes", REQUESTED)])]), timeout)
        except IppError as error:
            last = error
            continue
        if response["status"] < 0x0100:
            attrs = printer_attributes(response)
            attrs["_uri"] = [uri]
            return attrs
        last = IppError("The printer would not share its details.")
    raise last


def page_ranges(item):
    """[(first, last), ...] from the job's pageRange (numbers or '3-5' strings), or [] for the whole document."""
    out = []
    for part in item.get("pageRange") or []:
        text = str(part)
        low, _, high = text.partition("-")
        if not (low.strip().isdigit() and (not high or high.strip().isdigit())):
            raise ValueError("The page range could not be read.")
        out.append((int(low), int(high or low)))
    return out


def ipp_job_attributes(item, supported=None):
    """The IPP job attributes for a print job: copies, sides, colour, paper, pages and orientation. Same meaning as the SumatraPDF and lp paths."""
    if item.get("colourPages"):
        raise ValueError("Mixed-colour pages require manual printing.")
    landscape = item.get("orientation") == "Landscape"
    attributes = [(T_INTEGER, "copies", [max(1, int(item.get("copies") or 1))]),
                  (T_KEYWORD, "sides", [("two-sided-short-edge" if landscape else "two-sided-long-edge") if item.get("duplex") else "one-sided"]),
                  (T_KEYWORD, "print-color-mode", ["color" if item.get("colour") else "monochrome"]),
                  (T_KEYWORD, "media", [MEDIA_KEYWORD.get(item.get("paper", "A4"), MEDIA_KEYWORD["A4"])]),
                  (T_ENUM, "orientation-requested", [4 if landscape else 3])]
    ranges = page_ranges(item)
    if ranges:
        attributes.append((T_RANGE, "page-ranges", ranges))
    return attributes


def ipp_print(uri, pdf, item, post=None, timeout=60):
    """Print a PDF straight to a printer over IPP. Returns the printer's job id. Raises IppTimeout if the printer went quiet (it may have printed)."""
    post = post or ipp_post
    attributes = [(T_NAME, "requesting-user-name", ["printbee"]), (T_NAME, "job-name", ["PrintBee job"]), (T_MIME, "document-format", ["application/pdf"])]
    body = ipp_encode(OP_PRINT_JOB, [operation_attributes(uri, attributes), (G_JOB, ipp_job_attributes(item))], pdf)
    response = post(uri, body, timeout)
    if response["status"] >= 0x0100:
        raise IppError("The printer refused the job.")
    return _first(next((a for t, a in response["groups"] if t == G_JOB), {}), "job-id")


def _first(attrs, name, default=None):
    values = attrs.get(name)
    return values[0] if values else default


def ipp_state(attrs):
    """(state, reasons) from IPP printer attributes. Worst thing wins: offline > paper-out > error > toner-low > busy > ready."""
    reasons = [r.rsplit("-", 1)[0] if r.endswith(("-error", "-warning", "-report")) else r for r in attrs.get("printer-state-reasons", []) if r != "none"]
    state, found = "ready", []
    code = _first(attrs, "printer-state", 3)
    if code == 4:
        state = "busy"
    if code == 5:
        found.append("error")
    if _first(attrs, "printer-is-accepting-jobs", True) is False:
        found.append("offline")
    for reason in reasons:
        if reason in ("offline", "shutdown", "connecting-to-device", "paused", "moving-to-paused"):
            found.append("offline")
        elif reason in ("media-empty", "media-needed", "input-tray-missing"):
            found.append("paper-out")
        elif reason in ("toner-low", "marker-supply-low", "ink-low"):
            found.append("toner-low")
        elif reason in ("toner-empty", "marker-supply-empty", "ink-empty", "media-jam", "door-open", "cover-open", "interlock-open", "output-area-full",
                        "marker-waste-full", "spool-area-full", "other"):
            found.append("error")
    supplies = ipp_supplies(attrs)
    if any(s["level"] is not None and s["level"] <= 10 and s["type"] in ("toner", "ink", "ink-cartridge", "toner-cartridge", "") for s in supplies):
        found.append("toner-low")
    return worst_state([state] + found), reasons


def ipp_supplies(attrs):
    names, levels, types = attrs.get("marker-names", []), attrs.get("marker-levels", []), attrs.get("marker-types", [])
    out = []
    for index, name in enumerate(names):
        level = levels[index] if index < len(levels) else None
        out.append({"name": str(name)[:40], "level": level if isinstance(level, int) and 0 <= level <= 100 else None,
                    "type": str(types[index]) if index < len(types) else ""})
    return out


def record_from_ipp(attrs, host, port=631, queue=None, secure=False, model=None, extra_sources=("ipp",), connection="network"):
    formats = attrs.get("document-format-supported", [])
    sides = attrs.get("sides-supported", [])
    modes = attrs.get("print-color-mode-supported", [])
    colour = bool(_first(attrs, "color-supported", False)) or "color" in modes
    papers = paper_names(attrs.get("media-supported", []))
    state, reasons = ipp_state(attrs)
    uuid = str(_first(attrs, "printer-uuid", "") or "").replace("urn:uuid:", "") or None
    return record(model or _first(attrs, "printer-make-and-model") or _first(attrs, "printer-info") or "Network printer", connection, host=host, port=port,
                  queue=queue, ipp=_first(attrs, "_uri") or ipp_uri(host, port, "/ipp/print", secure), uuid=uuid, state=state, reasons=reasons, colour=colour,
                  duplex=any(s.startswith("two-sided") for s in sides), papers=papers, pdf="application/pdf" in formats, page_ranges="page-ranges-supported" in attrs,
                  supplies=ipp_supplies(attrs), sources=list(extra_sources), note=_first(attrs, "printer-location", ""))


# ---- mDNS / Bonjour -----------------------------------------------------------------------------------------

def txt_dict(props):
    """TXT records come as {b'ty': b'HP LaserJet'}: make them {'ty': 'HP LaserJet'}."""
    out = {}
    for key, value in (props or {}).items():
        k = key.decode("utf-8", "replace") if isinstance(key, bytes) else str(key)
        v = value.decode("utf-8", "replace") if isinstance(value, bytes) else ("" if value is None else str(value))
        out[k] = v
    return out


def mdns_record(instance, service_type, addresses, port, props):
    """A printer record (a suggestion) from one Bonjour service and its TXT records (ty, note, Color, Duplex, PaperMax, rp, UUID, pdl)."""
    txt = txt_dict(props)
    host = next((a for a in addresses if ":" not in a), None) or (addresses[0] if addresses else None)
    model = txt.get("ty") or txt.get("product", "").strip("()") or instance.split("._")[0]
    paper_max = txt.get("PaperMax", "")
    papers = ["A4", "A5"] + (["A3"] if re.search(r"A3|tabloid|ledger", paper_max, re.I) else [])
    return record(model, "network", host=host, port=port, queue=None, uuid=(txt.get("UUID") or txt.get("uuid") or "").replace("urn:uuid:", "") or None,
                  ipp=ipp_uri(host, port, "/" + txt.get("rp", "ipp/print").lstrip("/"), service_type.startswith("_ipps")) if host and service_type.startswith("_ipp") else None,
                  colour=txt.get("Color", "").upper() == "T", duplex=txt.get("Duplex", "").upper() == "T", papers=papers, pdf="application/pdf" in txt.get("pdl", ""),
                  sources=["mdns"], note=txt.get("note", ""))


def browse_mdns(timeout=3.0, factory=None):
    """(records, error). Needs the zeroconf package (print-agent/requirements.txt); without it the other ways of finding printers still work."""
    try:
        if factory is None:
            from zeroconf import ServiceBrowser, Zeroconf     # imported here: the agent runs fine without it, only the network scan is skipped
            factory = (Zeroconf, ServiceBrowser)
    except ImportError:
        return [], "Network scan needs the zeroconf package. Run: pip install -r print-agent/requirements.txt"
    make_zeroconf, make_browser = factory
    found = []
    class Listener:
        def add_service(self, zc, kind, name): found.append((kind, name))
        def update_service(self, zc, kind, name): pass
        def remove_service(self, zc, kind, name): pass
    zc = make_zeroconf()
    try:
        browsers = [make_browser(zc, kind, Listener()) for kind in SERVICES]
        time.sleep(timeout)
        out = []
        for kind, name in dict.fromkeys(found):
            info = zc.get_service_info(kind, name, timeout=1500)
            if info:
                out.append(mdns_record(name, kind, info.parsed_addresses(), info.port, info.properties))
        for browser in browsers:
            browser.cancel()
        return out, None
    except OSError as error:
        return [], f"The network scan failed ({type(error).__name__})."
    finally:
        zc.close()


# ---- manual address -------------------------------------------------------------------------------------------

def validate_address(text, resolver=socket.getaddrinfo):
    """(host, port) for a printer typed in by hand. Only private networks: a printer is never on the public internet."""
    text = str(text or "").strip()
    if not text or len(text) > 255 or re.search(r"[\s/\\@]", text):
        raise ValueError("Enter an IP address or hostname, like 192.168.1.40.")
    port = 631
    match = re.fullmatch(r"(\[[0-9a-fA-F:]+\]|[^:]+):(\d{1,5})", text)
    if match:
        text, port = match.group(1), int(match.group(2))
    host = text.strip("[]")
    if not 1 <= port <= 65535 or not re.fullmatch(r"[A-Za-z0-9.:-]+", host):
        raise ValueError("That address does not look right.")
    try:
        addresses = {info[4][0] for info in resolver(host, None)}
    except OSError:
        raise ValueError("That address could not be found on this network.")
    for address in addresses:
        ip = ipaddress.ip_address(address.split("%")[0])
        if not (ip.is_private or ip.is_loopback or ip.is_link_local):
            raise ValueError("Printers must be on your local network. That address is on the internet.")
    return host, port


def manual_record(address, query=get_printer_attributes, resolver=socket.getaddrinfo):
    host, port = validate_address(address, resolver)
    try:
        attrs = query(host, port)
    except IppError:
        raise ValueError("No printer answered at that address. Check it is switched on and on the same network.")
    return record_from_ipp(attrs, host, port, extra_sources=("ipp", "manual"))


# ---- merging duplicates ------------------------------------------------------------------------------------

def _hosts(rec):
    return {rec["host"]} if rec.get("host") else set()


def _same(a, b):
    if a.get("uuid") and b.get("uuid"):
        return a["uuid"].lower() == b["uuid"].lower()
    return bool(normalise_model(a["model"]) and normalise_model(a["model"]) == normalise_model(b["model"]) and _hosts(a) & _hosts(b))


def _combine(a, b):
    """One record from two views of the same printer. The live IPP view wins for state; installed queues keep the queue name."""
    live, other = (a, b) if "ipp" in a["sources"] or "mdns" in a["sources"] else (b, a)
    merged = json.loads(json.dumps(live))
    for key in ("host", "port", "queue", "ipp", "uuid"):
        merged[key] = merged.get(key) or other.get(key)
    caps = merged["capabilities"]
    for key in ("colour", "duplex", "pdf", "pageRanges"):
        caps[key] = caps[key] or other["capabilities"][key]
    sizes = paper_names(list(caps["paperSizes"]) + list(other["capabilities"]["paperSizes"]))
    caps["paperSizes"], caps["maxSize"] = sizes, sizes[-1] if sizes else None
    merged["connections"] = list(dict.fromkeys(a["connections"] + b["connections"]))
    merged["connection"] = "network" if merged.get("host") else "usb" if "usb" in merged["connections"] else merged["connections"][0]
    merged["sources"] = list(dict.fromkeys(a["sources"] + b["sources"]))
    merged["supplies"] = merged["supplies"] or other["supplies"]
    merged["model"] = live["model"] if len(live["model"]) >= len(other["model"]) else other["model"]
    merged["id"] = make_id(merged.get("uuid"), merged["model"], merged.get("host"), merged.get("queue"))
    merged["note"] = merged["note"] or other["note"]
    return merged


def merge_records(records):
    """Merge the same printer seen as a USB or Windows queue, an mDNS service and a network address: by UUID, or by model name plus address.
    A queue with no address (USB, or a local-only driver) is matched to a network printer of the same model only when that is the one
    unambiguous pair: two printers of one model are never joined by guesswork."""
    groups = []
    for rec in records:
        for index, group in enumerate(groups):
            if _same(group, rec):
                groups[index] = _combine(group, rec)
                break
        else:
            groups.append(rec)
    addressless = [g for g in groups if not g.get("host") and not g.get("uuid")]
    for queue in addressless:
        key = normalise_model(queue["model"])
        twins_net = [g for g in groups if g is not queue and g.get("host") and normalise_model(g["model"]) == key]
        twins_queue = [g for g in addressless if normalise_model(g["model"]) == key]
        if len(twins_net) == 1 and len(twins_queue) == 1 and "installed" not in twins_net[0]["sources"]:
            merged = _combine(twins_net[0], queue)
            groups = [g for g in groups if g is not queue and g is not twins_net[0]] + [merged]
    return sorted(groups, key=lambda g: (g["model"].lower(), g["id"]))


# ---- a whole scan --------------------------------------------------------------------------------------------

def enrich(records, query=get_printer_attributes, workers=6):
    """Ask every printer that has an address, in parallel, for its live details."""
    def one(rec):
        try:
            secure = bool(rec.get("ipp") and rec["ipp"].lower().startswith("ipps"))
            path = re.sub(r"^ipps?://[^/]+", "", rec["ipp"]) if rec.get("ipp") else None
            return rec, record_from_ipp(query(rec["host"], rec.get("port") or 631, path, secure), rec["host"], rec.get("port") or 631, queue=rec.get("queue"),
                                        secure=secure, model=None if "mdns" in rec["sources"] else rec["model"], connection=rec["connection"])
        except (IppError, OSError):
            return rec, None
    todo = [r for r in records if r.get("host")]
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(one, todo))
    out = [r for r in records if not r.get("host")]
    for rec, live in results:
        if live:
            live["sources"] = list(dict.fromkeys(rec["sources"] + ["ipp"]))
            out.append(_combine(live, rec))
        else:
            rec = json.loads(json.dumps(rec))
            if "installed" not in rec["sources"]:
                rec["state"], rec["reasons"] = "offline", ["no-answer"]
            out.append(rec)
    return out


def scan_inventory(manual=(), mdns=True, installed=installed_printers, browse=browse_mdns, query=get_printer_attributes, resolver=socket.getaddrinfo):
    """Everything this agent can see, merged. Returns {'printers': [...], 'errors': [...], 'scannedAt': epoch}."""
    errors, found = [], []
    queues, error = installed()
    found += queues
    if error:
        errors.append(error)
    if mdns:
        announced, error = browse()
        found += announced
        if error:
            errors.append(error)
    for address in manual or ():
        try:
            found.append(manual_record(address, query, resolver))
        except ValueError as problem:
            errors.append(f"{address}: {problem}")
    return {"printers": merge_records(enrich(found, query)), "errors": errors, "scannedAt": int(time.time())}


# ---- mock discovery: four made-up printers -----------------------------------------------------------------------

def mock_printers():
    """A laser B&W on USB, a colour inkjet on Wi-Fi, one that is switched off and one that is out of paper. No hardware needed."""
    return [
        record("Mock LaserJet B&W", "usb", queue="Mock LaserJet", uuid="00000000-0000-4000-8000-000000000001", state="ready", colour=False, duplex=True, papers=["A4"],
               supplies=[{"name": "Black toner", "level": 72, "type": "toner"}], sources=["installed"], mock=True),
        record("Mock InkJet Colour", "network", host="192.168.1.50", port=631, ipp="ipp://192.168.1.50:631/ipp/print", uuid="00000000-0000-4000-8000-000000000002",
               state="ready", colour=True, duplex=True, papers=["A4", "A3"], pdf=True, page_ranges=True, sources=["mdns", "ipp"], mock=True,
               supplies=[{"name": "Black ink", "level": 55, "type": "ink"}, {"name": "Cyan ink", "level": 40, "type": "ink"},
                         {"name": "Magenta ink", "level": 38, "type": "ink"}, {"name": "Yellow ink", "level": 61, "type": "ink"}]),
        record("Mock Office Printer (off)", "pc", queue="Mock Office", uuid="00000000-0000-4000-8000-000000000003", state="offline", reasons=["offline"], colour=False,
               duplex=False, papers=["A4"], sources=["installed"], mock=True),
        record("Mock Laser (no paper)", "network", host="192.168.1.60", port=631, ipp="ipp://192.168.1.60:631/ipp/print", uuid="00000000-0000-4000-8000-000000000004",
               state="paper-out", reasons=["media-empty"], colour=False, duplex=False, papers=["A4"], pdf=True, page_ranges=True, sources=["mdns", "ipp"], mock=True,
               supplies=[{"name": "Black toner", "level": 8, "type": "toner"}]),
    ]


# ---- the manager the agent loop uses -------------------------------------------------------------------------------

class PrinterManager:
    """Keeps the agent's picture of the printers: scans when the server asks (within one 3 second poll) and every 10 minutes, and reports the state
    of the approved printers every 20 seconds and when it changes. Slow work (scanning, asking printers) runs in a background thread so print jobs
    keep flowing. Talks only outbound: GET config, POST inventory, and the status rides along with the job poll (the heartbeat)."""
    CONFIG_EVERY, SCAN_EVERY, STATUS_EVERY, CONFIG_RETRY = 3, 600, 20, 60

    def __init__(self, mock=False, mdns=True, clock=time.monotonic, scan=None, probe=None, background=True):
        self.mock, self.mdns, self.clock, self.background = mock, mdns, clock, background
        self._scan = scan or (lambda manual: {"printers": mock_printers(), "errors": [], "scannedAt": int(time.time())} if mock
                              else scan_inventory(manual=manual, mdns=mdns))
        self._probe = probe or (lambda: {r["id"]: {"state": r["state"], "reasons": r["reasons"], "supplies": r["supplies"]} for r in self.inventory} if mock
                                else self._probe_live())
        self.inventory, self.wanted, self.manual = [], set(), []
        self.config_known = False
        self.scanning = self.probing = False
        self.states, self._sent, self._sent_at = {}, None, -1e9
        self._next_config = self._next_status = 0
        self._next_scan = 0
        self._lock = threading.Lock()
        self.scans = 0
        self.log = []

    # -- what the loop asks --
    def record_for(self, device_id):
        with self._lock:
            return next((r for r in self.inventory if r["id"] == device_id), None)

    def approved_ids(self):
        """None until the server has said which printers are approved (the old single-printer mode); then the exact set."""
        return set(self.wanted) if self.config_known else None

    def heartbeat(self):
        """The body for the job poll: the printers' states when they changed or are 20 s old, else nothing."""
        with self._lock:
            now = self.clock()
            if self.states and (self.states != self._sent or now - self._sent_at >= self.STATUS_EVERY):
                self._sent, self._sent_at = json.loads(json.dumps(self.states)), now
                return {"status": self.states}
        return {}

    def tick(self, request):
        """Called every poll (about every 3 s)."""
        now = self.clock()
        if now >= self._next_config:
            self._next_config = now + self.CONFIG_EVERY
            self._poll_config(request, now)
        if self.config_known and now >= self._next_scan and not self.scanning:     # an older server has no inventory route: do not scan for nobody
            self._next_scan = now + self.SCAN_EVERY
            self._start(self._do_scan, request)
        if now >= self._next_status and not self.probing and self.inventory:
            self._next_status = now + self.STATUS_EVERY
            self._start(self._do_probe)

    # -- internals --
    def _start(self, target, *args):
        if self.background:
            threading.Thread(target=target, args=args, daemon=True).start()
        else:
            target(*args)

    def _poll_config(self, request, now):
        try:
            config = json.loads(request("config"))
        except HTTPError as error:
            if error.code == 404:                       # an older server: stay in single-printer mode and ask again later
                self._next_config = now + self.CONFIG_RETRY
            return
        except (OSError, ValueError):
            return
        with self._lock:
            self.config_known = True
            self.wanted = {str(p.get("deviceId")) for p in config.get("printers", []) if p.get("deviceId") and p.get("enabled", True)}
            self.manual = [str(m) for m in config.get("manual", [])][:5]
        if config.get("scan") and not self.scanning:
            self._next_scan = 0

    def _do_scan(self, request):
        self.scanning = True
        try:
            result = self._scan(list(self.manual))
            with self._lock:
                self.inventory = result["printers"]
                self.scans += 1
                self.states = {r["id"]: {"state": r["state"], "reasons": r["reasons"], "supplies": r["supplies"]} for r in self.inventory if r["id"] in self.wanted}
            request("inventory", {"printers": result["printers"], "errors": result.get("errors", []), "scannedAt": result["scannedAt"], "mdns": self.mdns,
                                  "agent": {"version": VERSION, "mock": self.mock, "system": "windows" if os.name == "nt" else "unix"}})
        except Exception as error:                      # a failed scan must never stop printing
            self.log.append(f"scan failed: {type(error).__name__}")
        finally:
            self.scanning = False

    def _probe_live(self):
        """Fresh state for the approved printers: one pass over the installed queues, one IPP question per network printer."""
        out = {}
        queues, _ = installed_printers()
        queue_state = {q["queue"]: q for q in queues}
        for rec in list(self.inventory):
            if rec["id"] not in self.wanted:
                continue
            states, reasons, supplies = [], [], rec["supplies"]
            q = queue_state.get(rec.get("queue"))
            if q:
                states.append(q["state"]); reasons += q["reasons"]
            if rec.get("host"):
                try:
                    attrs = get_printer_attributes(rec["host"], rec.get("port") or 631, re.sub(r"^ipps?://[^/]+", "", rec["ipp"]) if rec.get("ipp") else None,
                                                   bool(rec.get("ipp") and rec["ipp"].lower().startswith("ipps")))
                    state, why = ipp_state(attrs)
                    states, reasons, supplies = [state], list(why), ipp_supplies(attrs) or supplies
                except IppError:
                    states, reasons = ["offline"], ["no-answer"]
            out[rec["id"]] = {"state": worst_state(states), "reasons": list(dict.fromkeys(reasons)), "supplies": supplies}
        return out

    def _do_probe(self):
        self.probing = True
        try:
            result = self._probe()
            with self._lock:
                self.states = {k: v for k, v in result.items() if k in self.wanted or not self.config_known}
        except Exception as error:
            self.log.append(f"status check failed: {type(error).__name__}")
        finally:
            self.probing = False

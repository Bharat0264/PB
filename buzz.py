"""Buzz, the PrintBee support chatbot (backend).

Buzz sits on top of the existing support ticket system: it never has tables of its own for tickets. It creates tickets with
support.create_buzz_ticket and reads a customer's own tickets with support.buzz_find_tickets / buzz_get_ticket.

Safety model (read this before changing anything):
  * Every tool runs on the server under the caller's own session. The tools take no email or user id from the model, so
    the model cannot ask for somebody else's data, whatever it is told. Order and ticket lookups are bound to that email.
  * The model never creates a ticket. It can only write a DRAFT. The customer presses Confirm, which calls confirm_ticket.
    A confirmed draft is consumed, so a double click returns the same ticket instead of creating two.
  * Delivery codes are never given to the model, and every reply is scrubbed of the customer's active codes as well.
  * What people type is redacted (emails, phone and card-like numbers, codes) before it is sent to the model or stored.
  * Limits: per user and per IP rate limit, message and reply length caps, 10 turns of history, a daily cost cap.
With no ANTHROPIC_API_KEY (or PRINTBEE_BUZZ_MOCK=1) Buzz answers from the same tools with canned wording, so the UI works offline.
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import time
from pathlib import Path

import order_status
import support
from checkout_terms import bill_for
from order_rules import quote_items

ROOT = Path(__file__).resolve().parent
PROMPT_FILE = ROOT / "buzz_prompt.md"
FAQ_FILE = ROOT / "kb" / "faq.md"

SCHEMA = """
CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    unhelpful INTEGER NOT NULL DEFAULT 0,
    draft TEXT
);
CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created INTEGER NOT NULL,
    rating INTEGER
);
CREATE INDEX IF NOT EXISTS chat_messages_session ON chat_messages(session_id, id);
CREATE INDEX IF NOT EXISTS chat_sessions_updated ON chat_sessions(updated);
CREATE TABLE IF NOT EXISTS chat_usage (
    day TEXT PRIMARY KEY,
    micro_usd INTEGER NOT NULL DEFAULT 0,
    calls INTEGER NOT NULL DEFAULT 0
);
"""

MAX_MESSAGE_CHARS = 800
MAX_REPLY_CHARS = 700
MAX_HISTORY_MESSAGES = 20          # about 10 turns
MAX_SESSION_MESSAGES = 80
MAX_TOOL_ROUNDS = 4
MAX_OUTPUT_TOKENS = 500
DEFAULT_MODEL = "claude-haiku-5-5"
# Claude Haiku 5.5: $0.10 per million input tokens, $0.50 per million output tokens (one micro-dollar per token per $1/M).
PRICE_INPUT, PRICE_OUTPUT = 0.10, 0.50
DEFAULT_DAILY_CAP_USD = 5.0
DEFAULT_RETENTION_DAYS = 30


class BuzzError(support.SupportError):
    """A problem to show the customer in plain words."""


# ---- settings ---------------------------------------------------------------------------------------------

def api_key():
    return os.environ.get("ANTHROPIC_API_KEY", "").strip()


def mock_mode():
    return not api_key() or os.environ.get("PRINTBEE_BUZZ_MOCK") == "1"


def model_name():
    return os.environ.get("PRINTBEE_SUPPORT_MODEL", "").strip() or DEFAULT_MODEL


def _number(name, default, low, high):
    try:
        value = float(os.environ.get(name, ""))
    except ValueError:
        return default
    return min(high, max(low, value))


def daily_cap_micro():
    return int(_number("PRINTBEE_CHAT_DAILY_CAP_USD", DEFAULT_DAILY_CAP_USD, 0, 10000) * 1_000_000)


def retention_days():
    return int(_number("PRINTBEE_CHAT_RETENTION_DAYS", DEFAULT_RETENTION_DAYS, 1, 3650))


def system_prompt():
    return PROMPT_FILE.read_text(encoding="utf-8")


def install(db):
    db.executescript(SCHEMA)
    purge(db)


def purge(db, now=None):
    """Delete chats older than the retention period (days, from PRINTBEE_CHAT_RETENTION_DAYS)."""
    cutoff = (now or int(time.time())) - retention_days() * 86400
    db.execute("DELETE FROM chat_messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE updated<?)", (cutoff,))
    db.execute("DELETE FROM chat_sessions WHERE updated<?", (cutoff,))


# ---- redaction --------------------------------------------------------------------------------------------

EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
LONG_NUMBER = re.compile(r"(?<![\w.])(?:\d[ -]?){10,19}(?!\w)")
CODE_AFTER_WORD = re.compile(r"(?i)\b(otp|code|pin|cvv|password|passcode)\b([^0-9\n]{0,12})(\d{3,8})\b")
BARE_CODE = re.compile(r"(?<![\w.])\d{4,6}(?![\w.])")


def redact(text, secrets_to_hide=()):
    """Take out what must not reach the model, the database or the logs: emails, phone and card-like numbers, codes
    that follow a word like OTP/PIN/CVV, and any delivery code in `secrets_to_hide`."""
    text = str(text)
    for secret in secrets_to_hide:
        if secret:
            text = text.replace(str(secret), "[code]")
    text = EMAIL.sub("[email]", text)
    text = CODE_AFTER_WORD.sub(lambda m: f"{m[1]}{m[2]}[code]", text)
    return LONG_NUMBER.sub("[number]", text)


def clean_user_text(value):
    if not isinstance(value, str):
        raise BuzzError("Type a message for Buzz.")
    value = "".join(ch for ch in value if ch in "\n\t" or ord(ch) >= 32).strip()
    value = re.sub(r"\s+", " ", value)
    if not value:
        raise BuzzError("Type a message for Buzz.")
    if len(value) > MAX_MESSAGE_CHARS:
        raise BuzzError(f"That message is a bit long. Please keep it under {MAX_MESSAGE_CHARS} characters.")
    return value


# ---- prompt-injection screen (cheap, before the model) ---------------------------------------------------

INJECTION = re.compile(
    r"(?i)(ignore|disregard|forget|override)\W+(all\W+|any\W+|the\W+|your\W+|previous\W+|prior\W+|above\W+)*"
    r"(instructions?|rules?|prompts?|guidelines?)|"
    r"(reveal|show|print|repeat|tell me|what('s| is| are))\W+(me\W+)?(your\W+|the\W+)?(system\W+|hidden\W+|initial\W+|secret\W+)"
    r"(prompt|instructions?|rules?)|"
    r"\b(you are now|act as|pretend (to be|you are)|roleplay as|developer mode|jailbreak|DAN mode)\b|"
    r"</?\s*(system|assistant|tool|instructions?)\s*>|"
    r"(other|another|every|all)\W+(customers?|users?|people)('s)?\W+(orders?|tickets?|data|details|emails?|numbers?)|"
    r"(delivery|otp)\W+code\W+(of|for)\W+(order|someone|another|any)"
)
REFUSAL = ("I can only help with PrintBee: pricing, printing, your orders, deliveries and support. "
           "I can't change how I work or share anything private. What can I help you print today?")


def looks_like_injection(text):
    return bool(INJECTION.search(text))


# ---- FAQ (kb/faq.md) --------------------------------------------------------------------------------------

def faq_sections():
    """[(title, body, unconfirmed)] from kb/faq.md. A section with a TODO anywhere, or DRAFT in its heading, is unconfirmed."""
    try:
        raw = FAQ_FILE.read_text(encoding="utf-8")
    except OSError:
        return []
    sections, title, lines = [], None, []
    for line in raw.splitlines() + ["## "]:
        if line.startswith("## "):
            if title:
                body = "\n".join(lines).strip()
                sections.append((title, body, "TODO" in body or "DRAFT" in title.upper()))
            title, lines = line[3:].strip(), []
        elif title:
            lines.append(line)
    return sections


STOPWORDS = {"what", "your", "the", "how", "does", "for", "and", "can", "you", "with", "this", "that", "from", "have", "are", "was",
             "who", "why", "when", "where", "which", "will", "its", "our", "any", "get", "about", "tell", "please"}


def _words(text):
    return {w for w in re.findall(r"[a-z0-9]+", text.lower()) if len(w) > 2 and w not in STOPWORDS}


def _items(body):
    """The section's lines, with the wrapped lines of one bullet joined back together."""
    items = []
    for line in body.splitlines():
        if line.lstrip().startswith("- ") and not line.startswith(" "):
            items.append(line.strip()[2:].strip())
        elif line.strip() and items and line.startswith(" "):
            items[-1] += " " + line.strip()
        elif line.strip():
            items.append(line.strip())
    return items


def faq_facts(body):
    """(facts, not_confirmed): the section text without its TODO placeholders, and the names of the facts still missing.
    "Label: TODO ..." drops the label and the TODO sentence (the label goes into not_confirmed); "(TODO: ...)" notes are removed."""
    facts, missing = [], []
    for item in _items(body):
        trimmed = re.sub(r"\s*\(TODO[^)]*\)", "", item)
        if trimmed != item:
            missing.append("exact details of: a figure in this topic marked as not final (say 'usually' or 'the team will confirm')")
        item = trimmed
        if "TODO" in item:
            before, _, after = item.partition("TODO")
            label = before.rstrip(" :-").strip()
            if label:
                missing.append(label)
            after = after.split(". ", 1)[1] if ". " in after else ""
            item = after.strip() if label else ""
        if item:
            facts.append(item)
    return "\n".join(facts), missing


def search_faq(query):
    """Best matching help topics. Unconfirmed (TODO or DRAFT) facts are flagged, and a TODO placeholder is never shown as a fact."""
    wanted = _words(str(query))
    if wanted & {"whatsapp", "email", "instagram", "phone", "call", "number", "reach"}:
        wanted.add("contact")
    scored = []
    for title, body, unconfirmed in faq_sections():
        facts, missing = faq_facts(body)
        score = 3 * len(wanted & _words(title)) + len(wanted & _words(facts)) + 2 * len(wanted & _words(" ".join(missing)))
        if score:
            scored.append((score, title, facts, missing, unconfirmed))
    scored.sort(key=lambda item: -item[0])
    results = []
    for _, title, facts, missing, unconfirmed in scored[:2]:
        note = ""
        if "DRAFT" in title.upper():
            note = ("This is the planned policy, not final. Describe it as our usual approach, say the PrintBee team confirms every case, "
                    "and never promise a refund.")
        if missing:
            note += (" " if note else "") + "Not confirmed yet, so say you are not sure and offer a person: " + "; ".join(missing) + "."
        results.append({"topic": title, "text": facts, "unconfirmed": unconfirmed, "not_confirmed": missing, "note": note})
    return {"results": results} if results else {"results": [], "note": "No help topic matched. Say you are not sure and offer a human."}


# ---- tools (all run under the caller's own session) -------------------------------------------------------

def _rupees(paise):
    return round(paise / 100, 2)


def get_pricing(terms):
    """Live prices from the admin-published checkout terms, in rupees per page, per copy, and so on."""
    paper = {}
    for size, rates in terms["paperRates"].items():
        paper[size] = {"black_and_white_single_sided_per_page": _rupees(rates[0]), "black_and_white_double_sided_per_page": _rupees(rates[1]),
                       "colour_single_sided_per_page": _rupees(rates[2]), "colour_double_sided_per_page": _rupees(rates[3])}
    fees = {key: _rupees(terms.get(key, 0)) for key in ("packing", "platform", "delivery") if terms.get(key)}
    return {"currency": "INR", "paper": paper,
            "binding_per_copy": {name: _rupees(rate) for name, rate in terms["bindingRates"].items() if name != "none"},
            "fees": fees, "tax_percent": terms.get("taxBasisPoints", 0) / 100 or None,
            "per_km_delivery": bool(terms.get("deliveryPerKm")),
            "note": "Final total (with any delivery by distance and coupons) is shown at checkout."}


def estimate_price(terms, pages, copies=1, colour=False, duplex=False, paper="A4", binding="none"):
    """The same pricing code checkout uses (quote_items and bill_for), so the estimate matches the live prices."""
    try:
        item = {"name": "estimate.pdf", "size": 1, "pages": pages, "copies": copies, "colour": bool(colour), "duplex": bool(duplex),
                "orientation": "Portrait", "paper": paper, "binding": binding}
        documents, subtotal = quote_items([item], terms["paperRates"], terms["bindingRates"])
    except (ValueError, KeyError, TypeError):
        return {"error": "Those options are not available. Check pages (1-10000), copies (1-100), paper size and binding."}
    binding_total = terms["bindingRates"].get(binding, 0) * copies
    bill = bill_for(subtotal, binding_total, "", {**terms, "deliveryPerKm": 0})
    return {"currency": "INR", "printing": _rupees(bill["printing"]), "binding": _rupees(bill["binding"]),
            "fees": {key: _rupees(bill[key]) for key in ("packing", "platform", "delivery", "surge", "tax") if bill.get(key)},
            "estimated_total": _rupees(bill["total"]),
            "note": "An estimate. Delivery by distance, and coupons, are worked out at checkout." if terms.get("deliveryPerKm")
                    else "An estimate. Coupons are applied at checkout."}


def _order_view(db, row, eta_minutes=None):
    details = json.loads(row["details"])
    model = order_status.STATUSES.get(row["status"], {"label": row["status"], "customer": ""})
    events = [{"event": order_status.EVENT_LABELS.get(e["action"], e["action"].replace("_", " ").capitalize()), "at": e["created"]}
              for e in db.execute("SELECT action, created FROM audit WHERE order_id=? ORDER BY id", (row["id"],))
              if e["action"] in order_status.EVENT_LABELS]
    view = {"id": row["id"], "order_number": row["order_number"] or "PB-" + row["id"][:8].upper(), "status": row["status"],
            "status_label": model["label"], "what_it_means": model["customer"],
            "total_inr": _rupees(details["bill"]["total"]) if details.get("bill") else None,
            "items": len(details.get("items", [])), "timeline": events[-6:]}
    if row["status"] == "out_for_delivery":
        view["delivery_code"] = "Shown to the customer on their Orders/tracking page. Never repeat or ask for it."
        if eta_minutes:
            view["eta_minutes"] = eta_minutes
    return view


ORDER_SQL = ("SELECT orders.id, orders.status, orders.details, order_owners.order_number FROM order_owners JOIN orders "
             "ON orders.id=order_owners.order_id WHERE order_owners.email=? AND orders.status!='pending' ")


def my_orders(db, email, eta=None, limit=5):
    """The signed-in customer's own recent orders. `eta(db, order_id, status)` gives minutes for an order on its way."""
    rows = db.execute(ORDER_SQL + "ORDER BY orders.rowid DESC LIMIT ?", (email, max(1, min(int(limit), 10)))).fetchall()
    return [_order_view(db, row, eta(db, row["id"], row["status"]) if eta else None) for row in rows]


def _own_order(db, email, order_number):
    if not isinstance(order_number, str):
        return None
    return db.execute(ORDER_SQL + "AND upper(order_owners.order_number)=?", (email, order_number.strip().upper())).fetchone()


def order_with_key(db, order_number, order_key):
    """A guest's order, by its number plus the secret order key. The same answer for a wrong number and a wrong key."""
    miss = {"error": "I could not find an order with that number and key."}
    if not isinstance(order_number, str) or not isinstance(order_key, str) or not order_key:
        return miss
    row = db.execute("SELECT orders.id, orders.status, orders.details, orders.token, order_owners.order_number FROM order_owners "
                     "JOIN orders ON orders.id=order_owners.order_id WHERE upper(order_owners.order_number)=? AND orders.status!='pending'",
                     (order_number.strip().upper(),)).fetchone()
    if not row or not hmac.compare_digest(order_key.encode(), (row["token"] or "").encode()):
        return miss
    model = order_status.STATUSES.get(row["status"], {"label": row["status"], "customer": ""})
    return {"order_number": row["order_number"], "status_label": model["label"], "what_it_means": model["customer"]}


def my_tickets(db, email, query=None, status=None):
    found = support.buzz_find_tickets(db, email, query=query, status=status, limit=8)
    return [{"ticket_number": t["number"], "subject": t["subject"], "status": t["status"], "category": t["categoryLabel"],
             "updated": t["updated"], "order_number": (t["order"] or {}).get("number")} for t in found]


def my_ticket(db, email, ticket_number):
    for found in support.buzz_find_tickets(db, email, query=str(ticket_number)[:20], limit=3):
        if found["number"].lower() == str(ticket_number).strip().lower():
            full = support.buzz_get_ticket(db, email, found["id"])
            return {"ticket_number": full["number"], "subject": full["subject"], "status": full["status"], "category": full["categoryLabel"],
                    "last_messages": [{"from": m["from"], "text": m["body"][:300]} for m in full["messages"][-3:]]}
    return {"error": "I could not find a ticket with that number on your account."}


TICKET_CATEGORIES = {key: label for key, label, needs in ((c["key"], c["label"], c["needsOrder"]) for c in support.categories())}


def draft_ticket(db, session_id, email, args):
    """Save a DRAFT on the chat session for the customer to confirm. Nothing is created here."""
    if not email:
        return {"error": "sign_in_required", "note": "Ask the customer to sign in first so a ticket can be created."}
    category = args.get("category")
    if category not in TICKET_CATEGORIES:
        return {"error": "Unknown category. Use one of: " + ", ".join(TICKET_CATEGORIES)}
    order_id, order_number = None, None
    if args.get("order_number"):
        row = _own_order(db, email, args["order_number"])
        if not row:
            return {"error": "That order number is not on this customer's account. Ask which order they mean (get_my_orders lists theirs)."}
        order_id, order_number = row["id"], row["order_number"]
    elif support.CATEGORIES[category][1]:
        return {"error": "This kind of ticket needs an order. Ask which order it is about."}
    try:
        subject = support._text(args.get("subject"), "subject", 120, 3)
        message = support._text(args.get("message"), "message", 1500, 3)
        summary = support._text(args.get("summary"), "summary", 400, 3)
    except support.SupportError as error:
        return {"error": str(error)}
    draft = {"id": secrets.token_hex(6), "category": category, "categoryLabel": TICKET_CATEGORIES[category], "subject": subject,
             "message": message, "summary": summary, "orderId": order_id, "orderNumber": order_number,
             "escalation": bool(args.get("escalate")), "ticketId": None}
    db.execute("UPDATE chat_sessions SET draft=? WHERE id=?", (json.dumps(draft), session_id))
    return {"draft_saved": True, "note": "The customer now sees this draft with a Confirm button. Ask them to check it and confirm. "
                                          "Do not say a ticket exists yet."}


def public_draft(draft):
    if not draft:
        return None
    return {key: draft[key] for key in ("id", "category", "categoryLabel", "subject", "message", "orderNumber", "escalation")} | {
        "created": bool(draft.get("ticketId"))}


TOOLS = [
    {"name": "search_faq", "description": "Look up PrintBee help topics (how it works, files, delivery, refunds, OTP, contact). Returns topics, some may be unconfirmed.",
     "input_schema": {"type": "object", "properties": {"query": {"type": "string", "description": "What the customer asked, in a few English keywords"}},
                      "required": ["query"], "additionalProperties": False}, "strict": True},
    {"name": "get_pricing", "description": "Live PrintBee prices per page, binding and fees. Never quote prices without calling this or estimate_price.",
     "input_schema": {"type": "object", "properties": {}, "additionalProperties": False}, "strict": True},
    {"name": "estimate_price", "description": "Estimate the cost of printing a document with the live pricing.",
     "input_schema": {"type": "object", "properties": {
         "pages": {"type": "integer", "description": "Pages in the document, 1-10000"}, "copies": {"type": "integer", "description": "Copies, 1-100"},
         "colour": {"type": "boolean"}, "duplex": {"type": "boolean", "description": "Double sided"},
         "paper": {"type": "string", "description": "A4, A3 or A5"}, "binding": {"type": "string", "description": "none or a binding name from get_pricing"}},
         "required": ["pages", "copies", "colour", "duplex", "paper", "binding"], "additionalProperties": False}, "strict": True},
    {"name": "get_my_orders", "description": "The signed-in customer's own recent orders with status, timeline and ETA. Read only.",
     "input_schema": {"type": "object", "properties": {}, "additionalProperties": False}, "strict": True},
    {"name": "get_order_with_key", "description": "For a guest who is not signed in: status of one order, with its order number and secret order key.",
     "input_schema": {"type": "object", "properties": {"order_number": {"type": "string"}, "order_key": {"type": "string"}},
                      "required": ["order_number", "order_key"], "additionalProperties": False}, "strict": True},
    {"name": "get_my_tickets", "description": "The signed-in customer's own support tickets (status only).",
     "input_schema": {"type": "object", "properties": {"query": {"type": "string", "description": "Optional word from the subject, or a ticket number"},
                                                       "status": {"type": "string", "description": "active, open, in_progress, pending, resolved, closed, or empty for all"}},
                      "required": [], "additionalProperties": False}, "strict": True},
    {"name": "get_my_ticket", "description": "One of the signed-in customer's own tickets by number, with the last few messages.",
     "input_schema": {"type": "object", "properties": {"ticket_number": {"type": "string"}}, "required": ["ticket_number"], "additionalProperties": False}, "strict": True},
    {"name": "draft_ticket", "description": "Write a support ticket DRAFT for the customer to confirm. This does not create the ticket.",
     "input_schema": {"type": "object", "properties": {
         "category": {"type": "string", "description": "order (payment/refund/account of an order), delivery (Bee Runner or late order), print_quality, account, other"},
         "order_number": {"type": "string", "description": "The customer's order number, if the issue is about an order"},
         "subject": {"type": "string"}, "message": {"type": "string", "description": "In the customer's voice, first person, facts only"},
         "summary": {"type": "string", "description": "One neutral line for staff"}, "escalate": {"type": "boolean", "description": "True only if urgent or a safety matter"}},
         "required": ["category", "subject", "message", "summary", "escalate"], "additionalProperties": False}, "strict": True},
]


class Caller:
    """Who is chatting, and what the server lets Buzz do for them. Built by the server from the real session."""

    def __init__(self, db, email, ip, terms, eta=None, codes=None):
        self.db, self.email, self.ip = db, email, ip
        self.terms = terms                  # live checkout terms (callable returning the dict)
        self.eta = eta                      # eta(db, order_id, status) -> minutes or None
        self.codes = codes                  # codes(db, email) -> the customer's active delivery codes, only used to scrub text
        self.session_id = None
        self.cards = []                     # the customer's orders as Buzz looked them up this turn (for the order card)

    def order_card(self, preferred=None):
        """What the chat shows as an order card: the order the customer asked about, else their latest. No codes."""
        if not self.cards:
            return None
        order = next((o for o in self.cards if preferred and o["order_number"] == preferred), self.cards[0])
        card = {key: order.get(key) for key in ("id", "order_number", "status", "status_label", "what_it_means", "items", "total_inr", "eta_minutes")}
        card["timeline"] = order["timeline"][-3:]
        return card

    def active_codes(self):
        return list(self.codes(self.db, self.email)) if self.codes and self.email else []

    def run_tool(self, name, args):
        """Run a tool for this caller. Always returns JSON-able data; any bad input becomes an error the model can read."""
        args = args if isinstance(args, dict) else {}
        try:
            if name == "search_faq":
                return search_faq(args.get("query", ""))
            if name == "get_pricing":
                return get_pricing(self.terms())
            if name == "estimate_price":
                return estimate_price(self.terms(), args.get("pages"), args.get("copies", 1), args.get("colour", False),
                                      args.get("duplex", False), args.get("paper", "A4"), args.get("binding", "none"))
            if name == "get_order_with_key":
                if self.email:
                    return {"error": "The customer is signed in. Use get_my_orders."}
                return order_with_key(self.db, args.get("order_number"), args.get("order_key"))
            if name in ("get_my_orders", "get_my_tickets", "get_my_ticket", "draft_ticket") and not self.email:
                return {"error": "sign_in_required", "note": "Ask the customer to sign in on PrintBee to use this."}
            if name == "get_my_orders":
                self.cards = my_orders(self.db, self.email, self.eta)
                return {"orders": [{key: value for key, value in order.items() if key != "id"} for order in self.cards]}
            if name == "get_my_tickets":
                return {"tickets": my_tickets(self.db, self.email, args.get("query") or None, args.get("status") or None)}
            if name == "get_my_ticket":
                return my_ticket(self.db, self.email, args.get("ticket_number", ""))
            if name == "draft_ticket":
                outcome = draft_ticket(self.db, self.session_id, self.email, args)
                self.db.commit()            # never hold the database write lock while waiting for the model
                return outcome
        except (support.SupportError, TypeError, ValueError, KeyError):
            return {"error": "That did not work. Say so and offer a human."}
        return {"error": "Unknown tool."}


# ---- sessions and logs ------------------------------------------------------------------------------------

def owner_key(email, ip):
    """Signed-in customers own their chats by email, guests by a hash of their address."""
    return email or "guest:" + hashlib.sha256((ip or "?").encode()).hexdigest()[:16]


def _session(db, session_id, owner):
    """The caller's own chat session. Somebody else's id (or an unknown one) simply starts a new session."""
    row = db.execute("SELECT * FROM chat_sessions WHERE id=? AND owner=?", (session_id, owner)).fetchone() \
        if isinstance(session_id, str) and re.fullmatch(r"[a-f0-9]{32}", session_id) else None
    if row:
        return row
    now = int(time.time())
    ident = secrets.token_hex(16)
    db.execute("INSERT INTO chat_sessions(id, owner, created, updated) VALUES (?,?,?,?)", (ident, owner, now, now))
    return db.execute("SELECT * FROM chat_sessions WHERE id=?", (ident,)).fetchone()


def _log(db, session_id, role, text):
    cursor = db.execute("INSERT INTO chat_messages(session_id, role, content, created) VALUES (?,?,?,?)",
                        (session_id, role, text, int(time.time())))
    db.execute("UPDATE chat_sessions SET updated=? WHERE id=?", (int(time.time()), session_id))
    return cursor.lastrowid


def _history(db, session_id):
    rows = db.execute("SELECT role, content FROM chat_messages WHERE session_id=? ORDER BY id DESC LIMIT ?",
                      (session_id, MAX_HISTORY_MESSAGES)).fetchall()[::-1]
    messages = []
    for row in rows:
        if messages and messages[-1]["role"] == row["role"]:
            messages[-1]["content"] += "\n" + row["content"]
        else:
            messages.append({"role": row["role"], "content": row["content"]})
    while messages and messages[0]["role"] != "user":
        messages.pop(0)
    return messages


def _spent(db):
    row = db.execute("SELECT micro_usd FROM chat_usage WHERE day=?", (time.strftime("%Y-%m-%d", time.gmtime()),)).fetchone()
    return row["micro_usd"] if row else 0


def _add_usage(db, input_tokens, output_tokens):
    micro = int(input_tokens * PRICE_INPUT + output_tokens * PRICE_OUTPUT + 0.999)
    day = time.strftime("%Y-%m-%d", time.gmtime())
    db.execute("INSERT OR IGNORE INTO chat_usage(day, micro_usd, calls) VALUES (?,0,0)", (day,))
    db.execute("UPDATE chat_usage SET micro_usd=micro_usd+?, calls=calls+1 WHERE day=?", (micro, day))


def tidy_reply(text, hide=()):
    """Last gate on every reply: no leaked prompt, no delivery code, no markdown noise, a hard length cap."""
    if "[[buzz-internal]]" in text or "strict: true" in text:
        return REFUSAL
    text = re.sub(r"[*_`#]{1,3}", "", text).strip()
    for code in hide:
        if code and code in text:
            text = text.replace(code, "[code]")
    if len(text) > MAX_REPLY_CHARS:
        cut = text[:MAX_REPLY_CHARS]
        end = max(cut.rfind(". "), cut.rfind("? "), cut.rfind("! "))
        text = cut[:end + 1] if end > 200 else cut.rstrip() + "..."
    return text or REFUSAL


# ---- mock mode (no API key) ---------------------------------------------------------------------------------

def _money(value):
    return f"Rs {value:g}"


def mock_reply(caller, text, order_number=None):
    """Canned answers built from the same tools the model uses. English only."""
    lower = text.lower()
    pages = re.search(r"(\d{1,5})\s*(?:pages?|pgs?)", lower)
    if pages and re.search(r"price|cost|how much|rate|estimate|print", lower):
        result = caller.run_tool("estimate_price", {"pages": int(pages[1]), "copies": 1, "colour": "colo" in lower and "black" not in lower,
                                                    "duplex": "double" in lower, "paper": "A4", "binding": "none"})
        if "estimated_total" in result:
            return (f"{pages[1]} pages would be about {_money(result['estimated_total'])} with fees. "
                    "Checkout shows your final total, so no surprises. Buzzing along!")
    if re.search(r"price|cost|how much|rate|pricing", lower):
        info = caller.run_tool("get_pricing", {})
        a4 = info["paper"].get("A4", {})
        return (f"A4 black and white is {_money(a4.get('black_and_white_single_sided_per_page', 0))} a page single sided, "
                f"colour {_money(a4.get('colour_single_sided_per_page', 0))}. Tell me pages and options and I'll estimate it.")
    if re.search(r"\bhuman\b|\bagent\b|\bperson\b|talk to someone|real person", lower):
        return "Of course. Tell me what happened and I'll write it up for our team to read. You'll get to check it first."
    if re.search(r"ticket|complaint", lower) and re.search(r"status|check|where|any update|my tickets?", lower):
        result = caller.run_tool("get_my_tickets", {})
        if result.get("error"):
            return "Please sign in and I'll look up your tickets."
        if not result["tickets"]:
            return "You have no tickets with us right now."
        top = result["tickets"][0]
        return f"Your latest ticket is {top['ticket_number']} ({top['subject']}): it is {top['status'].replace('_', ' ')}."
    if re.search(r"\border\b|\btrack|status|where is|\beta\b", lower) and not re.search(r"refund|payment|paid|charged", lower):
        result = caller.run_tool("get_my_orders", {})
        if result.get("error"):
            return "Please sign in and I'll check your orders. If you're a guest, send the order number and your order key."
        orders = result["orders"]
        if order_number:
            orders = [o for o in orders if o["order_number"] == order_number] or orders
        if not orders:
            return "I can't see any paid orders on your account yet."
        top = orders[0]
        eta = f" It should reach you in about {top['eta_minutes']} minutes." if top.get("eta_minutes") else ""
        return f"{top['order_number']}: {top['status_label']}. {top['what_it_means']}{eta}"
    runner_problem = re.search(r"runner|rider", lower) and re.search(r"late|rude|problem|issue|complain|unsafe|didn|wrong|missing|can.?t find|not (come|came|arriv|here)", lower)
    if runner_problem or re.search(r"payment|paid|refund|charged|money|wrong print|faded|missing page", lower):
        if not caller.email:
            return "I'm sorry about that. Please sign in so I can write this up for our team."
        category = ("print_quality" if re.search(r"print|faded|page", lower) else "delivery" if re.search(r"rider|runner|late", lower) else "order")
        number = order_number
        if not number:
            orders = caller.run_tool("get_my_orders", {}).get("orders", [])
            number = orders[0]["order_number"] if orders else None
        if category != "order" and not number:
            return "I'm sorry. Which order is this about? I can't see any paid orders yet."
        args = {"category": category, "subject": "Help needed: " + text[:60], "message": text, "summary": "Customer asked Buzz for help: " + text[:200],
                "escalate": bool(re.search(r"unsafe|safety|threat|harass", lower))}
        if number:
            args["order_number"] = number
        outcome = caller.run_tool("draft_ticket", args)
        if outcome.get("draft_saved"):
            return "I'm sorry about that. I've drafted a ticket for our team below. Check it and press Confirm and I'll send it in."
        return "I'm sorry about that. Could you tell me a little more so I can write it up for our team?"
    found = search_faq(text)["results"]
    if found:
        top = found[0]
        asked = _words(text)
        for label in top["not_confirmed"]:
            if label.startswith("exact details"):
                continue
            label_words = _words(label)
            when = asked & {"long", "time", "when", "hours", "take", "takes", "fast", "soon"} and label_words & {"time", "hours"}
            if len(asked & label_words) >= 2 or (when and asked & label_words):
                return f"I'm not sure about the {label.lower()} yet. I can create a ticket so a person can answer. Want that?"
        if top["unconfirmed"] and not top["text"]:
            return "I'm not sure about that yet. I can create a ticket so a person can answer. Want that?"
        lead = " ".join(re.split(r"(?<=[.!?]) ", " ".join(top["text"].split("\n")))[:3])
        return lead + (" I'm not sure about the rest yet, so I can ask a person if you like." if top["not_confirmed"] else "")
    return "Bzzz, I'm not sure about that one. I can help with pricing, uploads, your orders and problems, or hand you to a person."


# ---- the model loop -----------------------------------------------------------------------------------------

def _client():
    import anthropic
    return anthropic.Anthropic(api_key=api_key(), max_retries=1, timeout=25.0)


def model_reply(caller, history, context_note, client=None):
    """Run Claude with the tools, under this caller. Returns (text, input_tokens, output_tokens)."""
    client = client or _client()
    messages = [dict(m) for m in history]
    if context_note:
        messages[-1] = {"role": "user", "content": [{"type": "text", "text": messages[-1]["content"]},
                                                    {"type": "text", "text": "[from the PrintBee app, not typed by the customer] " + context_note}]}
    spent_in = spent_out = 0
    for _ in range(MAX_TOOL_ROUNDS + 1):
        response = client.messages.create(model=model_name(), max_tokens=MAX_OUTPUT_TOKENS, system=system_prompt(), tools=TOOLS,
                                          messages=messages, output_config={"effort": "low"})
        spent_in += getattr(response.usage, "input_tokens", 0)
        spent_out += getattr(response.usage, "output_tokens", 0)
        if response.stop_reason == "refusal":
            return REFUSAL, spent_in, spent_out
        calls = [block for block in response.content if block.type == "tool_use"]
        if response.stop_reason != "tool_use" or not calls:
            text = " ".join(block.text for block in response.content if block.type == "text").strip()
            return text, spent_in, spent_out
        messages.append({"role": "assistant", "content": response.content})
        results = []
        for call in calls:
            outcome = caller.run_tool(call.name, call.input)
            results.append({"type": "tool_result", "tool_use_id": call.id, "content": json.dumps(outcome)[:6000]})
        messages.append({"role": "user", "content": results})
    return "", spent_in, spent_out


# ---- entry points -------------------------------------------------------------------------------------------

FALLBACK = ("My hive is a bit busy right now. I can still create a ticket so a person can help you. "
            "Use Talk to a human and I'll write it up.")


def _order_hint(caller, order_number):
    if not order_number or not caller.email:
        return None, None
    row = _own_order(caller.db, caller.email, order_number)
    if not row:
        return None, None
    return row["order_number"], f"The customer opened this chat from their order {row['order_number']}. Treat questions as being about it."


def _result(db, session, reply, **extra):
    fresh = db.execute("SELECT draft, unhelpful FROM chat_sessions WHERE id=?", (session["id"],)).fetchone()
    draft = json.loads(fresh["draft"]) if fresh["draft"] else None
    if draft and draft.get("ticketId"):
        draft = None            # a confirmed draft is finished: later replies do not show it again
    return {"sessionId": session["id"], "reply": reply, "draft": public_draft(draft), "offerTicket": fresh["unhelpful"] >= 2,
            "mock": mock_mode(), **extra}


def chat(caller, body, client=None):
    """One customer message in, one reply out. `body` is the parsed JSON from the browser."""
    db = caller.db
    if not isinstance(body, dict):
        raise BuzzError("Type a message for Buzz.")
    text = clean_user_text(body.get("message"))
    support.check_rate(db, "chat", caller.email, caller.ip)
    owner = owner_key(caller.email, caller.ip)
    session = _session(db, body.get("sessionId"), owner)
    caller.session_id = session["id"]
    if db.execute("SELECT count(*) FROM chat_messages WHERE session_id=?", (session["id"],)).fetchone()[0] >= MAX_SESSION_MESSAGES:
        raise BuzzError("This chat has gotten long. Please start a new one, or use Talk to a human.")
    hide = caller.active_codes()
    safe = redact(text, hide)
    number, hint = _order_hint(caller, body.get("orderNumber") if isinstance(body.get("orderNumber"), str) else None)
    support.record_rate(db, "chat", caller.email, caller.ip)
    _log(db, session["id"], "user", safe)
    if looks_like_injection(safe):
        _log(db, session["id"], "assistant", REFUSAL)
        return _result(db, session, REFUSAL, blocked=True)
    if _spent(db) >= daily_cap_micro() and not mock_mode():
        _log(db, session["id"], "assistant", FALLBACK)
        return _result(db, session, FALLBACK, limitReached=True, offerTicket=True)
    db.commit()                     # release the write lock before any slow model call
    try:
        if mock_mode():
            reply = mock_reply(caller, safe, number)
        else:
            reply, tokens_in, tokens_out = model_reply(caller, _history(db, session["id"]), hint, client)
            _add_usage(db, tokens_in, tokens_out)
            if not reply:
                reply = FALLBACK
    except Exception as error:      # network, quota, bad key, SDK missing: never show details, never lose the customer
        print(f"buzz: model call failed: {type(error).__name__}", flush=True)
        reply = FALLBACK
        db.execute("UPDATE chat_sessions SET unhelpful=unhelpful+1 WHERE id=?", (session["id"],))
    reply = tidy_reply(reply, hide)
    message_id = _log(db, session["id"], "assistant", redact(reply))
    if secrets.randbelow(50) == 0:
        purge(db)
    return _result(db, session, reply, messageId=message_id, orderCard=caller.order_card(number))


def human_draft(caller, session_id, order_number=None):
    """The "Talk to a human" button: draft a ticket from what the customer wrote in this chat (no model involved)."""
    db = caller.db
    if not caller.email:
        raise BuzzError("Please sign in so a person can reply to you.")
    session = _session(db, session_id, owner_key(caller.email, caller.ip))
    caller.session_id = session["id"]
    said = [row["content"] for row in db.execute("SELECT content FROM chat_messages WHERE session_id=? AND role='user' ORDER BY id DESC LIMIT 3",
                                                 (session["id"],))][::-1]
    message = " ".join(said)[:1400] or "I would like to speak to a person about my order."
    number, _ = _order_hint(caller, order_number)
    args = {"category": "order" if number else "other", "subject": "Chat with Buzz: help from a person",
            "message": message, "summary": "Customer asked for a person after chatting with Buzz.", "escalate": False}
    if number:
        args["order_number"] = number
    outcome = caller.run_tool("draft_ticket", args)
    if not outcome.get("draft_saved"):
        raise BuzzError(outcome.get("error", "I could not prepare that. Please try again."))
    reply = "Here's a ticket for our team. Check it, then press Confirm."
    _log(db, session["id"], "assistant", reply)
    return _result(db, session, reply)


def confirm_ticket(caller, session_id, draft_id):
    """The customer pressed Confirm. Creates exactly one ticket per draft (a repeat returns the same ticket)."""
    db = caller.db
    if not caller.email:
        raise BuzzError("Please sign in so a person can reply to you.")
    session = db.execute("SELECT * FROM chat_sessions WHERE id=? AND owner=?", (session_id, caller.email)).fetchone() \
        if isinstance(session_id, str) else None
    draft = json.loads(session["draft"]) if session and session["draft"] else None
    if not draft or draft["id"] != draft_id:
        raise BuzzError("That draft is no longer available. Please ask Buzz again.")
    if not draft.get("ticketId"):
        support.check_rate(db, "ticket", caller.email, caller.ip)
        ticket_id = support.create_buzz_ticket(db, customer_email=caller.email, category=draft["category"], subject=draft["subject"],
                                               message=draft["message"], summary=draft["summary"], order_id=draft["orderId"],
                                               escalation=draft["escalation"])
        support.record_rate(db, "ticket", caller.email, caller.ip)
        draft["ticketId"] = ticket_id
        db.execute("UPDATE chat_sessions SET draft=? WHERE id=?", (json.dumps(draft), session["id"]))
        _log(db, session["id"], "assistant", f"Ticket created: {support.customer_ticket(db, ticket_id, caller.email)['number']}")
    ticket = support.customer_ticket(db, draft["ticketId"], caller.email)
    return {"sessionId": session["id"], "ticket": {"id": ticket["id"], "number": ticket["number"], "status": ticket["status"]},
            "reply": f"Done! Your ticket {ticket['number']} is with our team. You'll see replies under the bell.",
            "draft": public_draft(draft)}


def feedback(db, owner, session_id, message_id, rating):
    """Thumbs up (1) or down (-1) on one of Buzz's replies. Two thumbs down offer the ticket button."""
    if rating not in (1, -1) or type(message_id) is not int:
        raise BuzzError("Invalid feedback.")
    session = db.execute("SELECT id FROM chat_sessions WHERE id=? AND owner=?", (session_id, owner)).fetchone() \
        if isinstance(session_id, str) else None
    row = db.execute("SELECT rating FROM chat_messages WHERE id=? AND session_id=? AND role='assistant'",
                     (message_id, session["id"])).fetchone() if session else None
    if not row:
        raise support.NotFound("That message was not found.")
    if row["rating"] != rating:
        if rating == -1:
            db.execute("UPDATE chat_sessions SET unhelpful=unhelpful+1 WHERE id=?", (session["id"],))
        elif row["rating"] == -1:
            db.execute("UPDATE chat_sessions SET unhelpful=max(0, unhelpful-1) WHERE id=?", (session["id"],))
        db.execute("UPDATE chat_messages SET rating=? WHERE id=?", (rating, message_id))
    unhelpful = db.execute("SELECT unhelpful FROM chat_sessions WHERE id=?", (session["id"],)).fetchone()[0]
    return {"saved": True, "offerTicket": unhelpful >= 2}

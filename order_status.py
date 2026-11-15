"""The single definition of PrintBee order statuses, transitions and wording.

Everything that needs to know "what can happen to an order" reads it from here:
  * the server (role checks in endpoints, plus a database guard that rejects illegal jumps),
  * the event feed and notifications (labels, customer wording),
  * all four portals (via GET /api/status-model and status-model.js).

Stored statuses stay as they were so no data migration is needed. The brief's finer stages
(PRINTED, READY, ASSIGNED, PICKED_UP) are exposed as derived `stage` values, because the
repo already records "all files printed" as READY (`packed`) and assignment in `deliveries`.
"""

# key -> presentation. `tone` maps to each portal's own colour tokens; `colour` is a fixed fallback.
STATUSES = {
    "pending": {"label": "Awaiting payment", "tone": "neutral", "colour": "#7A6A4A", "stage": "PENDING",
                "customer": "We're waiting for your payment.", "terminal": False},
    "paid": {"label": "Paid", "tone": "info", "colour": "#3B7DD8", "stage": "PAID",
             "customer": "Payment received. Your order is queued for printing.", "terminal": False},
    "printing": {"label": "Printing", "tone": "honey", "colour": "#E0A91E", "stage": "PRINTING",
                 "customer": "Your documents are printing.", "terminal": False},
    "packed": {"label": "Ready for pickup", "tone": "warning", "colour": "#C77D12", "stage": "READY",
               "customer": "Printed and packed. A delivery partner is being assigned.", "terminal": False},
    "out_for_delivery": {"label": "Out for delivery", "tone": "honey", "colour": "#B9831A", "stage": "OUT_FOR_DELIVERY",
                         "customer": "Your order is on its way. Share your delivery code only when you receive it.",
                         "terminal": False},
    "delivered": {"label": "Delivered", "tone": "success", "colour": "#3E8E5A", "stage": "DELIVERED",
                  "customer": "Delivered. Thank you for printing with PrintBee.", "terminal": True},
    "undeliverable": {"label": "Undeliverable", "tone": "danger", "colour": "#D64545", "stage": "UNDELIVERABLE",
                      "customer": "We couldn't deliver your order. PrintBee will contact you.", "terminal": False},
    "cancelled": {"label": "Cancelled", "tone": "neutral", "colour": "#7A6A4A", "stage": "CANCELLED",
                  "customer": "This order was cancelled.", "terminal": True},
    "refund_pending": {"label": "Refund pending", "tone": "warning", "colour": "#C77D12", "stage": "REFUND_PENDING",
                       "customer": "Your refund is being processed.", "terminal": False},
    "refunded": {"label": "Refunded", "tone": "neutral", "colour": "#7A6A4A", "stage": "REFUNDED",
                 "customer": "Your refund has been processed.", "terminal": True},
    "refund_failed": {"label": "Refund needs assistance", "tone": "danger", "colour": "#D64545", "stage": "REFUND_FAILED",
                      "customer": "Your refund needs attention. PrintBee will contact you.", "terminal": False},
}

# Who may cause each change. "razorpay" = verified webhook, "checkout" = test payment, "system" = server logic.
TRANSITIONS = {
    "pending": {"paid": {"razorpay", "checkout"}, "cancelled": {"system"}},
    "paid": {"printing": {"warehouse", "admin", "system"}, "cancelled": {"admin"}, "refund_pending": {"admin"}},
    "printing": {"packed": {"warehouse", "admin", "print-agent", "system"}},
    "packed": {"out_for_delivery": {"partner"}},
    "out_for_delivery": {"delivered": {"partner"}, "undeliverable": {"partner", "admin"}},
    "undeliverable": {"packed": {"admin"}, "refund_pending": {"admin"}},
    "refund_pending": {"refunded": {"razorpay", "admin"}, "refund_failed": {"razorpay"}},
    "refund_failed": {"refund_pending": {"admin"}},
    "delivered": {}, "cancelled": {}, "refunded": {},
}

# Events that change nothing but are worth a timeline row. Everything else is a status change.
EVENT_LABELS = {
    "order_created": "Order placed", "paid": "Payment received", "print_queued": "Sent to the printer",
    "print_done": "Printed", "print_failed": "Print failed", "printed_manually": "Printed (confirmed by staff)",
    "packed": "Ready for pickup", "delivery_accepted": "Delivery partner assigned",
    "delivery_picked_up": "Out for delivery", "delivery_completed": "Delivered",
    "delivery_undeliverable": "Could not be delivered", "delivery_reassigned": "Delivery partner changed",
    "delivery_code_renewed": "Delivery code renewed", "delivery_code_rejected": "Wrong delivery code entered",
    "order_cancelled": "Cancelled", "refund_requested": "Refund requested", "refund.processed": "Refunded",
    "refund.failed": "Refund needs assistance", "print_job_recovered": "Print job recovered",
}

ROLES = ("customer", "warehouse", "print-agent", "partner", "admin", "system", "razorpay", "checkout")


def allowed(old, new):
    return old == new or new in TRANSITIONS.get(old, {})


def can(role, old, new):
    return old == new or role in TRANSITIONS.get(old, {}).get(new, ())


def stage(status, assigned=False):
    """The brief's stage names. A packed order with a delivery row is ASSIGNED."""
    if status == "packed" and assigned:
        return "ASSIGNED"
    return STATUSES.get(status, {}).get("stage", status.upper())


def public_model():
    """JSON for GET /api/status-model. Portals render labels, tones and the allowed next steps from this."""
    return {
        "statuses": {key: {k: v for k, v in value.items()} for key, value in STATUSES.items()},
        "transitions": {old: {new: sorted(roles) for new, roles in targets.items()} for old, targets in TRANSITIONS.items()},
        "events": EVENT_LABELS,
        "flow": ["pending", "paid", "printing", "packed", "out_for_delivery", "delivered"],
    }


def install_guards(db):
    """Make illegal status jumps impossible at the database level, whatever code path tries them."""
    pairs = " OR ".join(f"(OLD.status='{old}' AND NEW.status='{new}')"
                        for old, targets in TRANSITIONS.items() for new in targets)
    known = ",".join(f"'{key}'" for key in STATUSES)
    db.execute("DROP TRIGGER IF EXISTS orders_status_guard")
    db.execute("DROP TRIGGER IF EXISTS orders_insert_guard")
    db.execute(
        "CREATE TRIGGER orders_status_guard BEFORE UPDATE OF status ON orders "
        f"WHEN NEW.status IS NOT OLD.status AND NOT ({pairs}) "
        "BEGIN SELECT RAISE(ABORT, 'Illegal order status change'); END"
    )
    db.execute(
        "CREATE TRIGGER orders_insert_guard BEFORE INSERT ON orders "
        f"WHEN NEW.status IS NOT 'pending' OR NEW.status NOT IN ({known}) "
        "BEGIN SELECT RAISE(ABORT, 'New orders must start as pending'); END"
    )

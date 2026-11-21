"""The security headers PrintBee adds to every response (kept apart from request handling so they are easy to review)."""
import os

# ENFORCED now: the parts of a Content-Security-Policy that need no page changes (no plugins, no <base> tricks,
# forms and framing only for ourselves).
CSP_ENFORCED = "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"

# The strict script/style/image/... policy is still sent in REPORT-ONLY mode: browsers log what it would block but nothing is blocked yet.
CSP_REPORT_ONLY = "; ".join((
    "default-src 'self'",
    "script-src 'self' https://checkout.razorpay.com https://maps.googleapis.com",
    "style-src 'self'",
    "img-src 'self' data: blob: https://maps.gstatic.com https://maps.googleapis.com",
    "font-src 'self'",
    "connect-src 'self' blob: https://maps.googleapis.com https://lumberjack.razorpay.com",
    "frame-src 'self' blob: https://api.razorpay.com https://checkout.razorpay.com",     # blob: = the PDF preview
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
))


def response_headers(secure):
    """Name -> value for every response. `secure` is True when the request came over https."""
    headers = {
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "X-Frame-Options": "SAMEORIGIN",          # navigation.html and the phone tabs frame our own pages
        # Browser features PrintBee never uses are switched off; location stays on (address pin, delivery tracking).
        # `payment` is left alone on purpose: Razorpay's checkout window needs it.
        "Permissions-Policy": "camera=(), microphone=(), geolocation=(self), usb=(), display-capture=()",
        "Content-Security-Policy": CSP_ENFORCED,
        "Content-Security-Policy-Report-Only": CSP_REPORT_ONLY,
    }
    if secure:
        # includeSubDomains only when the owner confirms every subdomain of the site is https (PRINTBEE_HSTS_SUBDOMAINS=1).
        headers["Strict-Transport-Security"] = "max-age=31536000" + (
            "; includeSubDomains" if os.environ.get("PRINTBEE_HSTS_SUBDOMAINS") == "1" else "")
    return headers

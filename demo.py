"""Run PrintBee locally with one-click demo identities for every portal.

    python demo.py            start the server (test payments) and demo data
    python demo.py --reset    wipe the demo database first
    python demo.py --port 4200

Open http://127.0.0.1:4188/ and use the "Local demo: sign in as" buttons: customer, warehouse,
two delivery partners, admin, and one identity with every role (to try "Switch portal").
Demo mode is local-only and uses test payments, so no real money or messages are involved.
The demo database lives in .demo-data/ (git-ignored) and is separate from your real data.
"""

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent
TERMS = {
    "packing": 500, "platform": 300, "delivery": 1500, "taxBasisPoints": 500, "partnerPayout": 1200,
    "slots": [], "coupons": {"WELCOME10": 1000}, "paperRates": {}, "bindingRates": {},
}


def wait_for(url, seconds=20):
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            urlopen(url, timeout=2).read()
            return True
        except OSError:
            time.sleep(0.4)
    return False


def add_sample_order(db):
    """One finished sample order, so the demo customer's Orders page is not empty."""
    order_id = "d3a1c0de" * 4
    if db.execute("SELECT 1 FROM orders WHERE id=?", (order_id,)).fetchone():
        return
    item = {"name": "Lecture notes.pdf", "pages": 24, "copies": 1, "colour": False, "duplex": True,
            "orientation": "Portrait", "binding": "spiral", "paper": "A4", "size": 0, "subtotal": 4800}
    details = {"customer": "Demo Customer", "phone": "9876543210", "address": "SRM University, Kattankulathur",
               "items": [item], "subtotal": 4800,
               "bill": {"subtotal": 4800, "total": 9800}}
    db.execute("INSERT INTO orders VALUES (?, ?, 'pending', ?)", (order_id, "0" * 64, json.dumps(details)))
    for status in ("paid", "printing", "packed", "out_for_delivery", "delivered"):
        db.execute("UPDATE orders SET status=? WHERE id=?", (status, order_id))
    db.execute("INSERT INTO order_owners (order_id, email, order_number) VALUES (?, ?, ?)",
               (order_id, "customer@demo.printbee.test", "PB-DEMO-0001"))


def seed(data):
    """Demo data that does not need a signed-in browser: a default warehouse pickup for partners."""
    sys.path.insert(0, str(ROOT))
    import admin_records
    db = sqlite3.connect(data / "orders.sqlite", timeout=30)
    db.row_factory = sqlite3.Row
    try:
        with db:
            admin_records.save_warehouse(db, {
                "name": "PrintBee print room", "address": "SRM University, Kattankulathur",
                "email": "warehouse@demo.printbee.test", "useForPickup": True}, "demo")
            add_sample_order(db)
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=4188)
    parser.add_argument("--reset", action="store_true", help="delete the demo database first")
    args = parser.parse_args()
    data = ROOT / ".demo-data"
    if args.reset and data.exists():
        shutil.rmtree(data)
    data.mkdir(exist_ok=True)
    origin = f"http://127.0.0.1:{args.port}"
    env = {**os.environ, "PRINTBEE_DEMO": "1", "PRINTBEE_PAYMENT_MODE": "test", "PRINTBEE_ORIGIN": origin,
           "PRINTBEE_DATA_DIR": str(data), "PRINTBEE_CHECKOUT_TERMS": json.dumps(TERMS)}
    server = subprocess.Popen([sys.executable, str(ROOT / "server.py"), "--port", str(args.port)], env=env, cwd=ROOT)

    try:
        if not wait_for(origin + "/api/status-model"):
            raise SystemExit("The server did not start. Is port %d already in use?" % args.port)
        seed(data)
        print(f"""
PrintBee demo is running at {origin}/

  1. Open {origin}/ and click a "Local demo: sign in as" button
     (Customer, Warehouse, Delivery partner 1 and 2, Admin, or All roles).
  2. Customer: upload a PDF, review, pay with the test payment.
  3. Warehouse: the order appears instantly. Print the files yourself, then press Mark printed.
  4. Partner: go online, accept the order, confirm pickup.
  5. Customer: open Orders to see the delivery code; partner enters it to deliver.
  6. Admin: revenue, profit and partner earnings update.

Tip: use two browsers (or a private window) to be signed in as different roles at once.
Press Ctrl+C to stop.""")
        server.wait()
    except KeyboardInterrupt:
        pass
    finally:
        for process in (server,):
            if process and process.poll() is None:
                process.terminate()


if __name__ == "__main__":
    main()

"""Run PrintBee locally with one-click demo identities for every portal.

    python demo.py            start the server (test payments), a mock print agent and demo data
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
    "packing": 500, "platform": 300, "delivery": 1500, "taxBasisPoints": 500, "partnerPayout": 4000,
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
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=4188)
    parser.add_argument("--reset", action="store_true", help="delete the demo database first")
    parser.add_argument("--no-agent", action="store_true", help="do not start the mock print agent")
    args = parser.parse_args()
    data = ROOT / ".demo-data"
    if args.reset and data.exists():
        shutil.rmtree(data)
    data.mkdir(exist_ok=True)
    origin = f"http://127.0.0.1:{args.port}"
    env = {**os.environ, "PRINTBEE_DEMO": "1", "PRINTBEE_PAYMENT_MODE": "test", "PRINTBEE_ORIGIN": origin,
           "PRINTBEE_DATA_DIR": str(data), "PRINTBEE_CHECKOUT_TERMS": json.dumps(TERMS)}
    server = subprocess.Popen([sys.executable, str(ROOT / "server.py"), "--port", str(args.port)], env=env, cwd=ROOT)
    agent = None
    try:
        if not wait_for(origin + "/api/status-model"):
            raise SystemExit("The server did not start. Is port %d already in use?" % args.port)
        seed(data)
        if not args.no_agent:
            keys = json.loads((data / "staff-keys.json").read_text(encoding="utf-8"))
            agent = subprocess.Popen([sys.executable, str(ROOT / "print_agent.py"), "--origin", origin, "--mock-printer"],
                                     env={**env, "PRINTBEE_PRINT_AGENT_KEY": keys["print-agent"]}, cwd=ROOT)
        print(f"""
PrintBee demo is running at {origin}/

  1. Open {origin}/ and click a "Local demo: sign in as" button
     (Customer, Warehouse, Delivery partner 1 and 2, Admin, or All roles).
  2. Customer: upload a PDF, review, pay with the test payment.
  3. Warehouse: the order appears instantly. Press Print (the mock printer completes it).
  4. Partner: go online, accept the order, confirm pickup.
  5. Customer: open Orders to see the delivery code; partner enters it to deliver.
  6. Admin: revenue, profit and partner earnings update.

Tip: use two browsers (or a private window) to be signed in as different roles at once.
Press Ctrl+C to stop.""")
        server.wait()
    except KeyboardInterrupt:
        pass
    finally:
        for process in (agent, server):
            if process and process.poll() is None:
                process.terminate()


if __name__ == "__main__":
    main()

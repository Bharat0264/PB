"""Remove print uploads after verified delivery; retain receipts and financial records."""
import json
import os
import threading
import time
from contextlib import closing

# Orders that were never paid. Their files are removed after UNPAID_MAX_AGE, and one customer may keep only a few
# (and only so many bytes) at a time, so an account cannot fill the disk with uploads it never pays for.
UNPAID_MAX_AGE = int(os.environ.get("PRINTBEE_UNPAID_ORDER_HOURS", "24")) * 3600
MAX_PENDING_ORDERS = 5
MAX_PENDING_BYTES = 500 * 1024 * 1024
# "Unpaid" means still pending AND no payment was ever started with the provider (a started payment can still complete).
UNPAID = "status='pending' AND NOT EXISTS(SELECT 1 FROM razorpay_orders WHERE order_id=orders.id)"


SCHEMA = """
CREATE TABLE IF NOT EXISTS file_deletions (
    order_id TEXT PRIMARY KEY, remote INTEGER NOT NULL, created INTEGER NOT NULL,
    completed INTEGER, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT
);
"""


def delete_delivered_files(db, order_id, remote_storage=False):
    """Run inside the delivery transaction: revoke downloads and remove local bytes.

    The remote job commits with delivery, so a crash cannot lose its deletion request.
    """
    order = db.execute("SELECT status FROM orders WHERE id=?", (order_id,)).fetchone()
    if not order or order['status'] != 'delivered':
        raise ValueError('Only delivered print files can be deleted.')
    remote = remote_storage or bool(db.execute(
        "SELECT 1 FROM files WHERE order_id=? AND object_key IS NOT NULL LIMIT 1", (order_id,)
    ).fetchone())
    now = int(time.time())
    inserted = db.execute(
        "INSERT OR IGNORE INTO file_deletions(order_id, remote, created, completed) VALUES (?,?,?,?)",
        (order_id, int(remote), now, None if remote else now)
    ).rowcount
    db.execute("DELETE FROM files WHERE order_id=?", (order_id,))
    if inserted:
        action = 'order_files_removal_queued' if remote else 'order_files_deleted'
        db.execute("INSERT INTO audit(actor,action,order_id,created) VALUES ('privacy',?,?,?)",
                   (action, order_id, now))


def discard_unpaid_order(db, order_id, remote_storage=False):
    """Run inside a write transaction. Remove an order that was never paid, with its files. True if removed."""
    remote = remote_storage or bool(db.execute(
        "SELECT 1 FROM files WHERE order_id=? AND object_key IS NOT NULL LIMIT 1", (order_id,)
    ).fetchone())
    if not db.execute(f"DELETE FROM orders WHERE id=? AND {UNPAID}", (order_id,)).rowcount:
        return False
    now = int(time.time())
    if remote:   # the same durable queue as delivered orders; the worker erases the stored objects
        db.execute("INSERT OR IGNORE INTO file_deletions(order_id, remote, created, completed) VALUES (?,1,?,NULL)",
                   (order_id, now))
    for table in ("files", "order_owners", "order_events", "audit"):
        db.execute(f"DELETE FROM {table} WHERE order_id=?", (order_id,))
    db.execute("INSERT INTO audit(actor,action,order_id,created) VALUES ('privacy','unpaid_order_removed',?,?)",
               (order_id, now))
    return True


def expire_unpaid_orders(db, remote_storage=False, now=None):
    """Run inside a write transaction (BEGIN IMMEDIATE). Remove unpaid orders older than UNPAID_MAX_AGE."""
    cutoff = int(now if now is not None else time.time()) - UNPAID_MAX_AGE
    rows = db.execute(
        f"SELECT id FROM orders WHERE {UNPAID} AND COALESCE((SELECT min(created) FROM audit "
        "WHERE audit.order_id=orders.id AND action='order_created'), 0) <= ?", (cutoff,)).fetchall()
    return sum(discard_unpaid_order(db, row["id"], remote_storage) for row in rows)


def make_room(db, email, new_bytes, remote_storage=False):
    """Run inside a write transaction before a NEW order is stored. Keeps one customer's unpaid orders under the
    caps by removing their oldest unpaid ones first, so an honest customer who abandons carts is never locked out."""
    rows = db.execute(
        f"SELECT orders.id, orders.details FROM orders JOIN order_owners o ON o.order_id=orders.id "
        f"WHERE o.email=? AND {UNPAID} ORDER BY orders.rowid", (email,)).fetchall()
    sizes = {row["id"]: sum(int(item.get("size", 0)) for item in json.loads(row["details"]).get("items", [])) for row in rows}
    count, total, removed = len(rows), sum(sizes.values()), 0
    for row in rows:
        if count < MAX_PENDING_ORDERS and total + new_bytes <= MAX_PENDING_BYTES:
            break
        if discard_unpaid_order(db, row["id"], remote_storage):
            count, total, removed = count - 1, total - sizes[row["id"]], removed + 1
    return removed


def recover_verified_deliveries(db, remote_storage=False):
    """Backfill only historical orders with an actual successful OTP delivery audit."""
    rows = db.execute(
        "SELECT DISTINCT files.order_id FROM files JOIN orders ON orders.id=files.order_id "
        "WHERE orders.status='delivered' AND EXISTS(SELECT 1 FROM audit "
        "WHERE audit.order_id=orders.id AND action='delivery_completed')"
    ).fetchall()
    for row in rows:
        delete_delivered_files(db, row['order_id'], remote_storage)


def process_deletions(connect, storage, limit=20):
    """Idempotent cloud retries. Never keep a SQLite write transaction over network I/O."""
    with closing(connect()) as db:
        jobs = db.execute("SELECT order_id FROM file_deletions WHERE completed IS NULL "
                          "ORDER BY attempts, created LIMIT ?", (limit,)).fetchall()
    for job in jobs:
        order_id = job['order_id']
        error = None
        if storage is None:
            error = 'StorageUnavailable'
        else:
            try:
                storage.delete_order(order_id)
            except Exception as failure:
                # SDK messages can contain credentials/URLs. Store only the exception type.
                error = type(failure).__name__
        with closing(connect()) as db, db:
            if error:
                db.execute("UPDATE file_deletions SET attempts=attempts+1, last_error=? "
                           "WHERE order_id=? AND completed IS NULL", (error, order_id))
            else:
                now = int(time.time())
                changed = db.execute("UPDATE file_deletions SET completed=?, attempts=attempts+1, last_error=NULL "
                                     "WHERE order_id=? AND completed IS NULL", (now, order_id)).rowcount
                if changed:
                    db.execute("INSERT INTO audit(actor,action,order_id,created) "
                               "VALUES ('privacy','order_files_deleted',?,?)", (order_id, now))


class CleanupWorker:
    def __init__(self, connect, storage):
        self.connect, self.storage = connect, storage
        self.pending = threading.Event()
        self.stopping = threading.Event()
        self.thread = threading.Thread(target=self.run, name='print-file-cleanup', daemon=True)

    def start(self):
        self.thread.start()

    def wake(self):
        self.pending.set()

    def stop(self):
        self.stopping.set()
        self.pending.set()
        self.thread.join(timeout=2)

    def run(self):
        # Recover unfinished deletions on boot, then react to OTP verification and retry outages.
        last_sweep = 0
        while not self.stopping.is_set():
            try:
                with closing(self.connect()) as db, db:
                    recover_verified_deliveries(db, self.storage is not None)
                if time.time() - last_sweep > 600:       # unpaid orders: look every ten minutes
                    last_sweep = time.time()
                    with closing(self.connect()) as db, db:
                        db.execute("BEGIN IMMEDIATE")
                        expire_unpaid_orders(db, self.storage is not None)
                process_deletions(self.connect, self.storage)
            except Exception:
                # No upload data, keys or exception messages in logs; durable jobs survive restart.
                pass
            self.pending.wait(30)
            self.pending.clear()

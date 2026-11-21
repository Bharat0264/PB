"""Admin-created practice deliveries, separate from customer sales and earnings."""
import json
import secrets
import time
import uuid

import admin_records
import fulfillment as ops

TEST = "COALESCE(json_extract(details,'$.testDelivery'),0)=1"


def listing(db):
    return [dict(row) for row in db.execute(
        "SELECT orders.id, order_number AS number, status, "
        "json_extract(details,'$.testPartner') AS partner FROM orders "
        "JOIN order_owners ON order_owners.order_id=orders.id WHERE " + TEST +
        " ORDER BY orders.rowid DESC LIMIT 20")]


def create(db, data, actor, eligible):
    if not isinstance(data, dict) or not isinstance(data.get('partner'), str) or data['partner'] not in eligible:
        raise admin_records.InputError('Choose a registered delivery partner for this test.')
    partner = data['partner']
    # Repeated clicks/retries return the same unfinished practice delivery.
    existing = db.execute("SELECT id FROM orders WHERE " + TEST +
                          " AND json_extract(details,'$.testPartner')=? "
                          "AND status IN ('packed','out_for_delivery','undeliverable') LIMIT 1", (partner,)).fetchone()
    if existing:
        return existing['id']
    pickup = admin_records.default_pickup(db)
    if not pickup:
        raise admin_records.InputError('Add a warehouse pickup before creating a test delivery.')
    ident = uuid.uuid4().hex
    details = {
        'testDelivery': True, 'testPartner': partner,
        'customer': 'TEST DELIVERY — practice only', 'phone': '',
        'address': pickup['address'], 'pickupWarehouse': pickup,
        'notes': 'TEST ONLY. No customer or parcel. Stay at the pickup location; no travel, printing or payment required.',
        'slot': '', 'items': [], 'subtotal': 0, 'partnerPayout': 0,
        'bill': {'subtotal': 0, 'total': 0, 'tax': 0},
    }
    db.execute("INSERT INTO orders VALUES (?,?,'pending',?)", (ident, secrets.token_hex(32), json.dumps(details)))
    db.execute("INSERT INTO order_owners(order_id,email,order_number) VALUES (?,?,?)",
               (ident, 'delivery-test@internal.printbee.invalid', 'PB-TEST-' + ident[:10].upper()))
    # Use the canonical status transitions, without creating a payment or print job.
    for status in ('paid', 'printing', 'packed'):
        db.execute('UPDATE orders SET status=? WHERE id=?', (status, ident))
    ops.audit(db, actor, 'packed', ident)
    ops.audit(db, actor, 'test_delivery_created', ident)
    return ident


def view(db, ident, secret):
    row = db.execute("SELECT orders.id, status, order_number, nonce, expires, attempts "
                     "FROM orders JOIN order_owners ON order_owners.order_id=orders.id "
                     "LEFT JOIN deliveries ON deliveries.order_id=orders.id "
                     "WHERE orders.id=? AND " + TEST, (ident,)).fetchone()
    if not row:
        return None
    code = None
    if row['status'] == 'out_for_delivery' and row['nonce'] and row['expires'] > time.time() and row['attempts'] < 3:
        code = ops.delivery_code(secret, row['nonce'])
    return {'id': ident, 'number': row['order_number'], 'status': row['status'], 'code': code}

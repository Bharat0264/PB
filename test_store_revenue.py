import json
import sqlite3
import unittest

import admin_records
import fulfillment as ops
from test_e2e_workflow import Server, Customer, closing_db


class StoreRevenueTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.db.executescript(ops.SCHEMA + 'CREATE TABLE orders(id TEXT PRIMARY KEY,status TEXT,details TEXT);' + admin_records.SCHEMA)
        for name in ('A', 'B'):
            admin_records.save_warehouse(self.db, {'name':name,'address':name+' Road','email':name+'@example.test','useForPickup':False}, 'admin')
        self.a, self.b = admin_records.warehouse_directory(self.db)

    def add_order(self, ident, store, amount, status='paid', legacy=False):
        pickup = {key:store[key] for key in ('id','name','address')} if store else None
        if legacy and pickup:
            pickup.pop('id')
        self.db.execute('INSERT INTO orders VALUES (?,?,?)', (str(ident), status, json.dumps({'pickupWarehouse':pickup,'bill':{'total':amount}})))

    def test_counts_saved_bills_by_store_and_excludes_unpaid_refunded_cancelled(self):
        self.add_order('a1', self.a, 12550)
        self.add_order('a2', self.a, 24000, 'delivered')
        self.add_order('a3', self.a, 500, legacy=True)
        self.add_order('b1', self.b, 999)
        self.add_order('unknown', None, 99999)
        for status in ('pending','cancelled','refunded','refund_pending','refund_failed'):
            self.add_order(status, self.a, 99999, status)
        rows = {row['id']:row for row in admin_records.warehouse_directory(self.db)}
        self.assertEqual((rows[self.a['id']]['revenue'], rows[self.a['id']]['paidOrders']), (37050, 3))
        self.assertEqual((rows[self.b['id']]['revenue'], rows[self.b['id']]['paidOrders']), (999, 1))
        admin_records.save_warehouse(self.db, {'name':'B','address':'B Road','email':'B@example.test','useForPickup':True}, 'admin')
        self.assertEqual(next(row for row in admin_records.warehouse_directory(self.db) if row['id']==self.a['id'])['revenue'], 37050)

    def test_ambiguous_legacy_and_reused_ids_do_not_claim_other_revenue(self):
        admin_records.save_warehouse(self.db, {'name':'A','address':'A Road','email':'another@example.test','useForPickup':False}, 'admin')
        self.add_order('old', self.a, 5000, legacy=True)
        self.add_order('new', self.a, 3000)
        self.add_order('removed', {**self.a,'name':'Removed store','address':'Different Road'}, 99999)
        rows = admin_records.warehouse_directory(self.db)
        self.assertEqual(sum(row['revenue'] for row in rows), 3000)

    def test_totals_are_not_limited_to_the_admin_recent_order_list(self):
        for i in range(510):
            self.add_order(i, self.a, 100)
        row = next(row for row in admin_records.warehouse_directory(self.db) if row['id']==self.a['id'])
        self.assertEqual((row['revenue'],row['paidOrders']), (51000,510))


class StoreRevenueCheckoutFlow(unittest.TestCase):
    def test_new_checkout_snapshots_store_id_and_admin_sees_revenue(self):
        server = Server()
        self.addCleanup(server.stop)
        headers = {'X-Staff-Key':server.keys['admin']}
        payload = {'name':'Campus print room','address':'Test Road','email':'store@example.test','useForPickup':True}
        self.assertEqual(server.request('POST','/api/admin/warehouses',payload,headers)[0],200)
        customer = Customer(server,'store-customer@example.test')
        order = customer.order()
        with closing_db(server) as db:
            stored = json.loads(db.execute('SELECT details FROM orders WHERE id=?',(order['id'],)).fetchone()[0])
            self.assertIsInstance(stored['pickupWarehouse']['id'],int)
        customer.pay(order)
        row = server.request('GET','/api/admin',headers=headers)[1]['warehouses'][0]
        self.assertEqual((row['revenue'],row['paidOrders']), (order['total'],1))
        self.assertEqual(customer.get('/api/admin')[0],403)


if __name__ == '__main__':
    unittest.main()

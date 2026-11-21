import json
import unittest

import customer_auth as auth
import event_feed
from test_e2e_workflow import BOSS, Customer, RIDER_KEYS, Server, closing_db


class PracticeDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.server = Server()
        self.addCleanup(self.server.stop)
        self.admin = {'X-Staff-Key': self.server.keys['admin']}
        self.warehouse = {'X-Staff-Key': self.server.keys['warehouse']}
        self.riders = {key: {'X-Staff-Key': value} for key, value in RIDER_KEYS.items()}
        self.customer = Customer(self.server, 'test-buyer@example.test')
        status, result, _ = self.server.request('POST', '/api/admin/warehouses', {
            'name': 'Test print room', 'email': 'warehouse@example.test',
            'address': 'SRM Test pickup\nPickup pin: 12.8240, 80.0450', 'useForPickup': True,
        }, self.admin)
        self.assertEqual(status, 200, result)

    def admin_get(self):
        return self.server.request('GET', '/api/admin', headers=self.admin)[1]

    def create(self):
        status, order, _ = self.server.request('POST', '/api/admin/test-deliveries', {'partner': 'rider-a'}, self.admin)
        self.assertEqual(status, 200, order)
        return order

    def action(self, order, action, body=None, rider='rider-a'):
        return self.server.request('POST', f"/api/partner/orders/{order['id']}/{action}", body or {}, self.riders[rider])

    def view(self, order):
        return self.server.request('GET', '/api/admin/test-deliveries/' + order['id'], headers=self.admin)[1]

    def test_real_partner_journey_without_payments_earnings_or_customer_data(self):
        before = self.admin_get()
        order = self.create()
        self.assertTrue(order['number'].startswith('PB-TEST-'))
        self.assertEqual(order['status'], 'packed')
        self.assertIsNone(order['code'])
        self.assertEqual(self.create()['id'], order['id'])
        snapshot = self.admin_get()
        self.assertEqual(snapshot['finance'], before['finance'])
        self.assertEqual(snapshot['today'], before['today'])
        self.assertEqual(snapshot['counts'], before['counts'])
        self.assertEqual(snapshot['warehouses'], before['warehouses'])
        self.assertNotIn(order['id'], [entry['id'] for entry in snapshot['orders']])
        self.assertIn(order['id'], [entry['id'] for entry in snapshot['testDeliveries']])
        self.assertNotIn(order['id'], [entry['id'] for entry in self.server.request('GET', '/api/staff/orders', headers=self.warehouse)[1]['orders']])
        self.assertEqual(self.customer.get('/api/orders/' + order['id'])[0], 404)
        for rider, expected in [('rider-a', True), ('rider-b', False)]:
            rows = self.server.request('GET', '/api/partner/orders', headers=self.riders[rider])[1]['orders']
            self.assertEqual(order['id'] in [r['id'] for r in rows], expected)
        self.assertEqual(self.action(order, 'accept', rider='rider-b')[0], 403)
        self.assertEqual(self.action(order, 'pickup')[0], 409)
        self.server.request('POST', '/api/partner/availability', {'available': True}, self.riders['rider-a'])
        self.assertEqual(self.action(order, 'accept')[0], 200)
        self.assertEqual(self.action(order, 'pickup')[0], 200)
        code = self.view(order)['code']
        self.assertRegex(code, r'^\d{4}$')
        self.assertEqual(self.create()['status'], 'out_for_delivery')
        wrong = '0000' if code != '0000' else '1111'
        for _ in range(3):
            self.assertIn('error', self.action(order, 'deliver', {'code': wrong})[1])
        self.assertEqual(self.view(order)['status'], 'out_for_delivery')
        self.assertIsNone(self.view(order)['code'])
        self.assertEqual(self.server.request('POST', '/api/admin/orders/' + order['id'] + '/renew-code', {}, self.admin)[0], 200)
        code = self.view(order)['code']
        self.assertRegex(code, r'^\d{4}$')
        self.assertEqual(self.action(order, 'deliver', {'code': code})[:2], (200, {'saved': True}))
        self.assertEqual(self.view(order)['status'], 'delivered')
        self.assertIsNone(self.view(order)['code'])
        after = self.admin_get()
        for key in ('finance', 'today', 'counts', 'warehouses'):
            self.assertEqual(after[key], before[key], key)
        with closing_db(self.server) as db:
            for table in ('razorpay_orders', 'files', 'print_jobs', 'partner_earnings'):
                self.assertEqual(db.execute(f'SELECT count(*) FROM {table} WHERE order_id=?', (order['id'],)).fetchone()[0], 0)
            details = json.loads(db.execute('SELECT details FROM orders WHERE id=?', (order['id'],)).fetchone()[0])
            self.assertEqual(details['phone'], '')
            self.assertEqual(details['partnerPayout'], 0)
            self.assertIn(order['id'], [e['order'] for e in event_feed.fetch(db, 'partner', 'rider-a', 0)])
            self.assertNotIn(order['id'], [e['order'] for e in event_feed.fetch(db, 'partner', 'rider-b', 0)])
        self.assertNotEqual(self.create()['id'], order['id'])

    def test_admin_authorization_validation_and_cookie_origin(self):
        path = '/api/admin/test-deliveries'
        for headers in ({}, self.warehouse, self.riders['rider-a']):
            self.assertEqual(self.server.request('POST', path, {'partner': 'rider-a'}, headers)[0], 403)
        for data in ({}, [], {'partner': []}, {'partner': 'not-a-partner'}):
            self.assertEqual(self.server.request('POST', path, data, self.admin)[0], 400)
        with closing_db(self.server) as db, db:
            cookie = auth.portal_session(db, {}, BOSS, 'admin').split(';')[0]
        headers = {'Cookie': cookie, 'Origin': 'https://other.example'}
        self.assertEqual(self.server.request('POST', path, {'partner': 'rider-a'}, headers)[0], 403)
        status, order, _ = self.server.request('POST', path, {'partner': 'rider-a'}, {'Cookie': cookie})
        self.assertEqual(status, 200, order)
        for headers in ({}, self.warehouse, self.riders['rider-a'], self.customer.headers):
            self.assertEqual(self.server.request('GET', path + '/' + order['id'], headers=headers)[0], 403)
        real = self.customer.order()
        self.assertEqual(self.server.request('GET', path + '/' + real['id'], headers=self.admin)[0], 404)


if __name__ == '__main__':
    unittest.main()

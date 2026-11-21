"""Coverage boundaries and real checkout requests, without external Maps calls."""
import json
import math
import secrets
import sqlite3
import unittest
import uuid

import fulfillment
from checkout_terms import SERVICE_AREA, DeliveryQuoteError, delivery_terms, require_delivery_area, validate_terms
from server import active_checkout_terms
from test_e2e_workflow import Customer, Server, closing_db


def address_at(km=0, bearing=0):
    lat, lng = map(math.radians, (SERVICE_AREA['latitude'], SERVICE_AREA['longitude']))
    arc, heading = km / 6371, math.radians(bearing)
    destination_lat = math.asin(math.sin(lat)*math.cos(arc) + math.cos(lat)*math.sin(arc)*math.cos(heading))
    destination_lng = lng + math.atan2(math.sin(heading)*math.sin(arc)*math.cos(lat),
                                     math.cos(arc)-math.sin(lat)*math.sin(destination_lat))
    return f"Delivery address\nDelivery pin: {math.degrees(destination_lat):.12f}, {math.degrees(destination_lng):.12f}"


class DeliveryAreaTests(unittest.TestCase):
    def test_inside_boundary_and_outside_in_every_direction(self):
        for bearing in (0, 45, 90, 180, 270):
            for km in (0, 4.999, 5):
                require_delivery_area(address_at(km, bearing))
            with self.assertRaisesRegex(DeliveryQuoteError, 'outside'):
                require_delivery_area(address_at(5.001, bearing))

    def test_missing_invalid_and_misplaced_pins(self):
        for address in ('Hostel', '', None, 'Delivery pin: NaN, 80',
                        'Delivery pin: 91, 80', 'Delivery pin: 12, 181',
                        'Delivery pin: 12.822949, 80.044780\nHostel',
                        'Delivery pin: 12.822949, 80.044780 extra'):
            with self.subTest(address=address), self.assertRaises(DeliveryQuoteError):
                require_delivery_area(address)

    def test_campus_choice_and_zero_fees_do_not_bypass_coverage(self):
        terms = validate_terms({})
        for choice in ({}, {'deliveryType': 'campus', 'campusId': 'srm-ktr'}):
            self.assertEqual(delivery_terms(terms, choice, address_at())['serviceArea'], SERVICE_AREA)
            with self.assertRaisesRegex(DeliveryQuoteError, 'outside'):
                delivery_terms(terms, choice, address_at(6))

    def test_saved_or_submitted_pricing_cannot_change_coverage(self):
        default = validate_terms({'serviceArea': {'radiusMeters': 999999}})
        self.assertEqual(default['serviceArea'], SERVICE_AREA)
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            db.executescript(fulfillment.SCHEMA)
            for area in (None, {'latitude': 0, 'longitude': 0, 'radiusMeters': 999999}):
                saved = {k: v for k, v in default.items() if k != 'serviceArea'}
                if area is not None:
                    saved['serviceArea'] = area
                db.execute('INSERT INTO pricing_versions(terms, created) VALUES (?, 1)', (json.dumps(saved),))
                self.assertEqual(active_checkout_terms(db, default)['serviceArea'], SERVICE_AREA)


class DeliveryAreaAPITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server()
        cls.customer = Customer(cls.server, 'coverage@example.test')
        cls.item = {'name': 'notes.pdf', 'size': 20, 'pages': 1, 'copies': 1,
                    'colour': False, 'duplex': False, 'orientation': 'Portrait'}

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()

    def test_published_area_and_accepted_quote(self):
        self.assertEqual(self.server.request('GET', '/api/checkout')[1]['terms']['serviceArea'], SERVICE_AREA)
        status, bill, _ = self.customer.post('/api/checkout/quote', {'items': [self.item], 'address': address_at(5)})
        self.assertEqual(status, 200, bill)

    def test_quote_and_direct_order_reject_unserved_addresses_without_writes(self):
        for address in ('Hostel', 'Hostel\nDelivery pin: 999, 80', address_at(5.01)):
            for choice in ({}, {'deliveryType': 'campus', 'campusId': 'srm-ktr'}):
                with self.subTest(address=address, choice=choice):
                    data = {'items': [self.item], 'address': address, **choice}
                    self.assertEqual(self.customer.post('/api/checkout/quote', data)[0], 400)
                    ident = uuid.uuid4().hex
                    status, error, _ = self.customer.post('/api/orders', {
                        **data, 'id': ident, 'customer': 'Test Customer', 'phone': '9999999999',
                        'expectedTotal': 100, 'serviceArea': {'radiusMeters': 999999},
                    }, **{'X-Order-Key': secrets.token_hex(32)})
                    self.assertEqual(status, 400, error)
                    with closing_db(self.server) as db:
                        self.assertIsNone(db.execute('SELECT id FROM orders WHERE id=?', (ident,)).fetchone())


if __name__ == '__main__':
    unittest.main()

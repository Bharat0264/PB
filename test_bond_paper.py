import json
import sqlite3
import unittest

import fulfillment
import server
from checkout_terms import validate_terms


class BondPaperTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.db.executescript(fulfillment.SCHEMA)
        self.default = validate_terms({})

    def tearDown(self):
        self.db.close()

    def test_defaults_offer_normal_and_bond(self):
        self.assertEqual(list(self.default["paperRates"]), ["A4", "A4 Bond"])

    def test_old_saved_pricing_still_offers_bond(self):
        old = {k: v for k, v in self.default.items() if k != "paperRates"} | {"paperRates": {"A4": [175, 300, 850, 1400]}}
        self.db.execute("INSERT INTO pricing_versions(terms, created) VALUES (?, 1)", (json.dumps(old),))
        self.assertEqual(list(server.active_checkout_terms(self.db, self.default)["paperRates"]), ["A4", "A4 Bond"])

    def test_admin_bond_rates_win(self):
        saved = {k: v for k, v in self.default.items() if k != "paperRates"} | {
            "paperRates": {"A4": [175, 300, 850, 1400], "A4 Bond": [400, 700, 1500, 2500]}}
        self.db.execute("INSERT INTO pricing_versions(terms, created) VALUES (?, 1)", (json.dumps(saved),))
        self.assertEqual(server.active_checkout_terms(self.db, self.default)["paperRates"]["A4 Bond"], [400, 700, 1500, 2500])


if __name__ == "__main__":
    unittest.main()

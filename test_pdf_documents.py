import io
import unittest

from pypdf import PdfReader

import order_documents as documents

DETAILS = {"customer": "Test <b>Name</b>", "phone": "+91 98765 43210", "address": "North Hostel\nSRM",
           "items": [{"name": "a&b.pdf", "pages": 3, "copies": 2, "colour": False, "duplex": True, "binding": "glossy",
                      "subtotal": 1200, "orientation": "Portrait", "size": 10}],
           "subtotal": 1200, "bill": {"subtotal": 1200, "total": 1500, "tax": 100}}


class PdfDocumentTests(unittest.TestCase):
    """Run these after changing the Pillow or reportlab version: the invoice logo is dropped silently if Pillow cannot read it."""

    def test_the_logo_loads(self):
        self.assertIsNotNone(documents._logo_reader())

    def test_invoice_has_text_and_the_logo_image(self):
        reader = PdfReader(io.BytesIO(documents.invoice_pdf("PB-261121-TEST", DETAILS, "razorpay")))
        self.assertEqual(len(reader.pages), 1)
        self.assertIn("PB-261121-TEST", reader.pages[0].extract_text())
        self.assertTrue(any(len(page.images) for page in reader.pages))

    def test_packing_label_is_made(self):
        reader = PdfReader(io.BytesIO(documents.packing_label_pdf("PB-261121-TEST", DETAILS)))
        self.assertEqual(len(reader.pages), 1)
        self.assertIn("PB-261121-TEST", reader.pages[0].extract_text())


if __name__ == "__main__":
    unittest.main()

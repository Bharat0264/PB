import io
import secrets
import unittest
import uuid
import zipfile

import upload_types
from test_e2e_workflow import Customer, Server, make_pdf

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 40
JPG = b"\xff\xd8\xff\xe0" + b"\0" * 40
EXE = b"MZ\x90\x00\x03\x00\x00\x00" + b"\0" * 200
ADDRESS = "North Hostel, SRM campus\nDelivery pin: 12.8240, 80.0450"
DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def make_zip(entries):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return out.getvalue()


DOCX = make_zip({"[Content_Types].xml": "<Types/>", "word/document.xml": "<w:document/>"})


class ValidateUploadTests(unittest.TestCase):
    def test_real_files_of_the_four_types_pass(self):
        self.assertEqual(upload_types.validate_upload("a.pdf", make_pdf(1), "application/pdf"), "pdf")
        self.assertEqual(upload_types.validate_upload("a.docx", DOCX, DOCX_TYPE), "docx")
        self.assertEqual(upload_types.validate_upload("a.jpg", JPG, "image/jpeg"), "jpg")
        self.assertEqual(upload_types.validate_upload("A.JPEG", JPG, "image/jpeg"), "jpg")
        self.assertEqual(upload_types.validate_upload("a.png", PNG, "image/png"), "png")

    def test_browsers_that_send_no_type_still_need_matching_content(self):
        for mime in (None, "", "application/octet-stream"):
            self.assertEqual(upload_types.validate_upload("a.png", PNG, mime), "png")
            with self.assertRaises(ValueError):
                upload_types.validate_upload("a.png", EXE, mime)

    def test_exe_txt_and_exe_renamed_to_pdf_are_rejected(self):
        for name, content, mime in [("virus.exe", EXE, "application/x-msdownload"), ("notes.txt", b"hello", "text/plain"),
                                    ("virus.pdf", EXE, "application/pdf"), ("virus.pdf", EXE, None),
                                    ("virus.exe", make_pdf(1), "application/pdf"), ("a.doc", b"\xd0\xcf\x11\xe0" + b"0" * 50, "application/msword"),
                                    ("a.gif", b"GIF89a" + b"0" * 20, "image/gif"), ("noextension", make_pdf(1), "application/pdf")]:
            with self.assertRaises(ValueError, msg=name):
                upload_types.validate_upload(name, content, mime)

    def test_mime_must_belong_to_the_extension(self):
        with self.assertRaises(ValueError):
            upload_types.validate_upload("a.pdf", make_pdf(1), "image/png")
        with self.assertRaises(ValueError):
            upload_types.validate_upload("a.png", PNG, "application/pdf")

    def test_docx_must_hold_a_word_document(self):
        for content in (make_zip({"xl/workbook.xml": "x", "[Content_Types].xml": "x"}), make_zip({"readme.txt": "x"}), b"PK\x03\x04 not really a zip"):
            with self.assertRaises(ValueError):
                upload_types.validate_upload("a.docx", content, DOCX_TYPE)

    def test_zip_bomb_is_refused(self):
        bomb = make_zip({"[Content_Types].xml": "x", "word/document.xml": "0" * (upload_types.MAX_UNPACKED_DOCX + 1)})
        with self.assertRaises(ValueError):
            upload_types.validate_upload("a.docx", bomb, DOCX_TYPE)

    def test_empty_and_oversized_files_are_refused(self):
        with self.assertRaises(ValueError):
            upload_types.validate_upload("a.pdf", b"", "application/pdf")
        with self.assertRaises(ValueError):
            upload_types.validate_upload("a.pdf", b"%PDF-" + b"0" * upload_types.MAX_BYTES, "application/pdf")


class UploadEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server()
        cls.customer = Customer(cls.server, "uploader@example.test")

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()

    def place(self, name, size):
        item = {"name": name, "pages": 1, "copies": 1, "size": size, "colour": False, "duplex": False, "orientation": "Portrait"}
        status, bill, _ = self.customer.post("/api/checkout/quote", {"items": [item], "coupon": "", "address": ADDRESS})
        if status != 200:
            return status, None, None
        order_id, key = uuid.uuid4().hex, secrets.token_hex(32)
        status, result, _ = self.customer.post("/api/orders", {
            "id": order_id, "customer": "Test", "phone": "+91 98765 43210", "address": "North Hostel, SRM campus\nDelivery pin: 12.8240, 80.0450",
            "items": [item], "expectedTotal": bill["total"], "coupon": "", "notes": "", "slot": ""}, **{"X-Order-Key": key})
        return status, order_id, key

    def test_exe_txt_and_renamed_exe_cannot_be_ordered_or_uploaded(self):
        # a file name that is not an allowed type is refused when the order is created
        for name in ("virus.exe", "notes.txt"):
            status, _, _ = self.place(name, 100)
            self.assertEqual(status, 400, name)
        # an .exe renamed to .pdf gets an order, but the upload itself is refused (content is not a PDF)
        status, order_id, key = self.place("virus.pdf", len(EXE))
        self.assertEqual(status, 200)
        status, result, _ = self.customer.post(f"/api/orders/{order_id}/files/0", EXE, **{"X-Order-Key": key, "Content-Type": "application/pdf"})
        self.assertEqual(status, 415, result)
        self.assertIn("not a real PDF", result["error"])
        self.assertIn("Only PDF, DOCX, JPG and PNG", result["error"])
        # the same bytes with a wrong declared type are refused too
        status, result, _ = self.customer.post(f"/api/orders/{order_id}/files/0", EXE, **{"X-Order-Key": key, "Content-Type": "application/x-msdownload"})
        self.assertEqual(status, 415, result)

    def test_a_real_pdf_still_uploads(self):
        pdf = make_pdf(2)
        status, order_id, key = self.place("real.pdf", len(pdf))
        self.assertEqual(status, 200)
        status, result, _ = self.customer.post(f"/api/orders/{order_id}/files/0", pdf, **{"X-Order-Key": key, "Content-Type": "application/pdf"})
        self.assertEqual((status, result), (200, {"saved": True}))

    def test_page_counting_endpoint_refuses_fake_documents(self):
        for kind, body, mime in (("pdf", EXE, "application/pdf"), ("docx", EXE, DOCX_TYPE), ("pdf", b"hello world", "text/plain")):
            status, result, _ = self.customer.post(f"/api/checkout/pages?format={kind}", body, **{"Content-Type": mime})
            self.assertEqual(status, 415, (kind, result))
        status, result, _ = self.customer.post("/api/checkout/pages?format=pdf", make_pdf(3), **{"Content-Type": "application/pdf"})
        self.assertEqual((status, result), (200, {"pages": 3}))


if __name__ == "__main__":
    unittest.main()

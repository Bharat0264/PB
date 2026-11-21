"""Private print-file storage and customer order PDFs."""

import hashlib
import os
import re
from contextlib import closing
from io import BytesIO


class PrivateFiles:
    def __init__(self, bucket):
        import boto3
        from botocore.exceptions import BotoCoreError, ClientError

        self.bucket = bucket
        self.errors = (BotoCoreError, ClientError)
        self.client = boto3.client("s3", endpoint_url=os.environ.get("PRINTBEE_S3_ENDPOINT") or None)

    def put(self, order_id, position, body):
        digest = hashlib.sha256(body).hexdigest()
        key = f"printbee/orders/{order_id}/{position}/{digest}"
        self.client.put_object(Bucket=self.bucket, Key=key, Body=body, ContentType="application/octet-stream")
        return key

    def put_support(self, ticket_id, attachment_id, body):
        """Support ticket attachments live under their own prefix in the same private bucket."""
        digest = hashlib.sha256(body).hexdigest()
        key = f"printbee/support/{ticket_id}/{attachment_id}/{digest}"
        self.client.put_object(Bucket=self.bucket, Key=key, Body=body, ContentType="application/octet-stream")
        return key

    def signed_download(self, key):
        return self.client.generate_presigned_url("get_object", Params={
            "Bucket": self.bucket, "Key": key, "ResponseContentType": "application/octet-stream",
            "ResponseContentDisposition": "attachment",
        }, ExpiresIn=60)

    def read(self, key):
        with closing(self.client.get_object(Bucket=self.bucket, Key=key)["Body"]) as body:
            return body.read()

    def delete_order(self, order_id):
        """Erase the entire order prefix, including replaced uploads and S3 versions."""
        if not re.fullmatch(r'[a-f0-9]{32}', order_id):
            raise ValueError('Invalid print order ID.')
        prefix = f'printbee/orders/{order_id}/'

        def remove(objects):
            if not objects:
                return
            if any(not item['Key'].startswith(prefix) for item in objects):
                raise ValueError('Refusing deletion outside this print order.')
            result = self.client.delete_objects(Bucket=self.bucket, Delete={'Objects': objects, 'Quiet': True})
            if result.get('Errors'):
                raise OSError('Print-file deletion is incomplete.')

        try:
            for page in self.client.get_paginator('list_object_versions').paginate(Bucket=self.bucket, Prefix=prefix):
                objects = [{'Key': item['Key'], 'VersionId': item['VersionId']}
                           for item in page.get('Versions', []) + page.get('DeleteMarkers', [])]
                for start in range(0, len(objects), 1000):
                    remove(objects[start:start+1000])
        except self.errors as error:
            # Some S3-compatible stores do not implement version listing.
            code = str(getattr(error, 'response', {}).get('Error', {}).get('Code', ''))
            if code not in ('NotImplemented', 'NotImplementedException', '501', '405', 'MethodNotAllowed'):
                raise
        else:
            return
        for page in self.client.get_paginator('list_objects_v2').paginate(Bucket=self.bucket, Prefix=prefix):
            remove([{'Key': item['Key']} for item in page.get('Contents', [])])


def _logo_reader():
    """The PrintBee bee, converted to PNG for the PDF. Missing or unreadable image: no logo."""
    try:
        from pathlib import Path

        from PIL import Image
        from reportlab.lib.utils import ImageReader

        image = Image.open(Path(__file__).with_name("printbee-header-bee.webp")).convert("RGBA")
        buffer = BytesIO()
        image.save(buffer, "PNG")
        buffer.seek(0)
        return ImageReader(buffer)
    except Exception:
        return None


def _item_description(item):
    parts = [item.get("paper", "A4"), f'{item.get("pages", 0)} pages']
    if "colour" in item:
        parts.append("Colour" if item["colour"] else "Black & white")
    if item.get("duplex"):
        parts.append("double-sided")
    if item.get("binding") and item["binding"] != "none":
        parts.append(f'{item["binding"]} binding')
    return " · ".join(parts)


def invoice_pdf(number, details, mode):
    from xml.sax.saxutils import escape

    from reportlab.lib import colors
    from reportlab.lib.enums import TA_RIGHT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    honey, ink, muted, line, cream = (colors.HexColor(c) for c in ("#F5C542", "#2A2112", "#7A6A4A", "#F0E3BE", "#FFF8E8"))
    receipt = mode == "razorpay"
    title = "Receipt" if receipt else "Order summary"
    logo = _logo_reader()

    base = ParagraphStyle("base", fontName="Helvetica", fontSize=10, leading=14, textColor=ink)
    small = ParagraphStyle("small", parent=base, fontSize=8.5, leading=11, textColor=muted)
    label = ParagraphStyle("label", parent=small, fontName="Helvetica-Bold", textColor=muted, spaceAfter=2)
    strong = ParagraphStyle("strong", parent=base, fontName="Helvetica-Bold", fontSize=12, leading=16)
    right = ParagraphStyle("right", parent=base, alignment=TA_RIGHT)
    right_strong = ParagraphStyle("right_strong", parent=right, fontName="Helvetica-Bold")

    def page(canvas, doc):
        width, height = A4
        canvas.saveState()
        canvas.setFillColor(honey)
        canvas.rect(0, height - 34 * mm, width, 34 * mm, stroke=0, fill=1)
        if logo:
            canvas.drawImage(logo, 18 * mm, height - 27 * mm, width=21 * mm, height=19 * mm, mask="auto", preserveAspectRatio=True)
        canvas.setFillColor(ink)
        canvas.setFont("Helvetica-Bold", 22)
        canvas.drawString(43 * mm, height - 18 * mm, "PrintBee")
        canvas.setFont("Helvetica", 9)
        canvas.drawString(43 * mm, height - 24 * mm, "Upload. Print. Delivered.")
        canvas.setFont("Helvetica-Bold", 16)
        canvas.drawRightString(width - 18 * mm, height - 18 * mm, title.upper())
        canvas.setFont("Helvetica", 9)
        canvas.drawRightString(width - 18 * mm, height - 24 * mm, number)
        canvas.setStrokeColor(line)
        canvas.line(18 * mm, 18 * mm, width - 18 * mm, 18 * mm)
        canvas.setFillColor(muted)
        canvas.setFont("Helvetica", 8)
        canvas.drawString(18 * mm, 12 * mm, "PrintBee · Campus printing for SRM University · printbee.co.in@gmail.com")
        canvas.drawRightString(width - 18 * mm, 12 * mm, "Thank you for printing with us")
        canvas.restoreState()

    output = BytesIO()
    pdf = SimpleDocTemplate(output, pagesize=A4, title=f"PrintBee {number}", author="PrintBee",
                            leftMargin=18 * mm, rightMargin=18 * mm, topMargin=46 * mm, bottomMargin=26 * mm)
    content_width = A4[0] - 36 * mm
    rows = []

    billed = [Paragraph("BILLED TO", label), Paragraph(escape(details.get("customer", "")), strong),
              Paragraph(escape(details.get("address", "")), small)]
    if details.get("phone"):
        billed.append(Paragraph(escape(str(details["phone"])), small))
    meta = [Paragraph("ORDER", label), Paragraph(escape(number), strong),
            Paragraph("Payment received" if receipt else "Awaiting payment confirmation", small)]
    head = Table([[billed, meta]], colWidths=[content_width * 0.6, content_width * 0.4])
    head.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                              ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))
    rows += [head, Spacer(1, 10 * mm)]

    table = [[Paragraph("ITEM", label), Paragraph("COPIES", label),
              Paragraph("AMOUNT", ParagraphStyle("r", parent=label, alignment=TA_RIGHT))]]
    for item in details["items"]:
        name = Paragraph(f'<b>{escape(item["name"])}</b><br/><font size="8.5" color="#7A6A4A">{escape(_item_description(item))}</font>', base)
        table.append([name, Paragraph(str(item.get("copies", 1)), base), Paragraph(f'INR {item["subtotal"] / 100:,.2f}', right)])
    items = Table(table, colWidths=[content_width * 0.66, content_width * 0.12, content_width * 0.22], repeatRows=1)
    items.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), cream), ("LINEBELOW", (0, 0), (-1, -1), 0.5, line),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ]))
    rows += [items, Spacer(1, 6 * mm)]

    bill = details.get("bill", {"total": details["subtotal"]})
    totals = []
    for key, text in (("printing", "Printing"), ("binding", "Binding"), ("packing", "Packing"),
                      ("platform", "Platform"), ("delivery", "Delivery"), ("surge", "Surge fee"), ("discount", "Discount"),
                      ("tax", "Taxes")):
        if key in bill:
            amount = (-bill[key] if key == "discount" else bill[key]) / 100
            totals.append([Paragraph(text, base), Paragraph(f"INR {amount:,.2f}", right)])
    totals.append([Paragraph("<b>Total</b>", ParagraphStyle("t", parent=base, fontSize=12)),
                   Paragraph(f'INR {bill.get("total", details["subtotal"]) / 100:,.2f}', ParagraphStyle("tr", parent=right_strong, fontSize=12))])
    box = Table(totals, colWidths=[content_width * 0.2, content_width * 0.2], hAlign="RIGHT")
    last = len(totals) - 1
    box.setStyle(TableStyle([
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("BACKGROUND", (0, last), (-1, last), honey), ("TOPPADDING", (0, last), (-1, last), 8), ("BOTTOMPADDING", (0, last), (-1, last), 8),
    ]))
    rows.append(box)
    pdf.build(rows, onFirstPage=page, onLaterPages=page)
    return output.getvalue()


def packing_label_pdf(number, details):
    from reportlab.graphics import renderPDF
    from reportlab.graphics.barcode import createBarcodeDrawing
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer
    from reportlab.platypus.flowables import Flowable
    from xml.sax.saxutils import escape

    class OrderCode(Flowable):
        width = height = 29 * mm

        def draw(self):
            code = createBarcodeDrawing("QR", value=number, width=self.width, height=self.height)
            renderPDF.draw(code, self.canv, 0, 0)

    output = BytesIO()
    label = SimpleDocTemplate(output, pagesize=(104 * mm, 148 * mm), leftMargin=8 * mm,
                              rightMargin=8 * mm, topMargin=8 * mm, bottomMargin=8 * mm)
    styles = getSampleStyleSheet()
    label.build([
        Paragraph("PrintBee", styles["Heading1"]),
        Paragraph(escape(number), styles["Heading2"]),
        OrderCode(),
        Spacer(1, 8),
        Paragraph(escape(details["customer"]), styles["Heading3"]),
        Paragraph(escape(details["address"]), styles["BodyText"]),
        Paragraph(escape(details["phone"]), styles["BodyText"]),
    ])
    return output.getvalue()

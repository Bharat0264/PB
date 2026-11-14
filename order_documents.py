"""Private print-file storage and customer order PDFs."""

import hashlib
import os
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

    def signed_download(self, key):
        return self.client.generate_presigned_url("get_object", Params={
            "Bucket": self.bucket, "Key": key, "ResponseContentType": "application/octet-stream",
            "ResponseContentDisposition": "attachment",
        }, ExpiresIn=60)

    def read(self, key):
        with closing(self.client.get_object(Bucket=self.bucket, Key=key)["Body"]) as body:
            return body.read()


def invoice_pdf(number, details, mode):
    from xml.sax.saxutils import escape

    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

    output = BytesIO()
    pdf = SimpleDocTemplate(output, pagesize=A4, title=f"PrintBee {number}", author="PrintBee")
    styles = getSampleStyleSheet()
    rows = [
        Paragraph("PrintBee order receipt" if mode == "razorpay" else "PrintBee order summary", styles["Title"]),
        Paragraph(escape(number), styles["Heading2"]),
        Paragraph(escape(details["customer"]), styles["BodyText"]),
        Paragraph(escape(details["address"]), styles["BodyText"]),
        Spacer(1, 16),
    ]
    for item in details["items"]:
        description = f'{item["name"]} ({item.get("paper", "A4")}, {item["pages"]} pages x {item["copies"]} copies)'
        rows.append(Paragraph(escape(description) + f' — INR {item["subtotal"] / 100:.2f}', styles["BodyText"]))
    rows.append(Spacer(1, 16))
    bill = details.get("bill", {"total": details["subtotal"]})
    for key, label in (("printing", "Printing"), ("binding", "Binding"), ("packing", "Packing"),
                       ("platform", "Platform"), ("delivery", "Delivery"), ("discount", "Discount"),
                       ("tax", "Taxes"), ("total", "Total")):
        if key in bill:
            amount = (-bill[key] if key == "discount" else bill[key]) / 100
            rows.append(Paragraph(f"{label}: INR {amount:.2f}", styles["BodyText"]))
    pdf.build(rows)
    return output.getvalue()

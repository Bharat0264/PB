"""Read physical page counts for supported print files."""

from io import BytesIO
from pathlib import PurePath

from pypdf import PdfReader
from pypdf.errors import PyPdfError


def count_pages(name, content):
    suffix = PurePath(name).suffix.lower()
    if suffix == ".pdf" or content.startswith(b"%PDF-"):
        try:
            pdf = PdfReader(BytesIO(content))
            pages = len(pdf.pages)
            if pages < 1 or pages > 10000:
                raise ValueError("PDFs must contain between one and 10,000 pages.")
            return pages
        except (PyPdfError, RecursionError, TypeError, KeyError, IndexError) as error:
            raise ValueError("Use a readable, unlocked PDF.") from error
    if (content.startswith(b"\xff\xd8\xff") or content.startswith(b"\x89PNG\r\n\x1a\n")):
        return 1
    if suffix in (".png", ".jpg", ".jpeg"):
        raise ValueError("Use a readable JPG or PNG.")
    return None

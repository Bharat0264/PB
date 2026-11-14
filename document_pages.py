"""Read physical page counts for supported print files."""

import os
import shutil
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from io import BytesIO
from pathlib import PurePath

from pypdf import PdfReader
from pypdf.errors import PyPdfError


def render_docx(content):
    executable = os.environ.get("PRINTBEE_SOFFICE") or shutil.which("soffice")
    if not executable:
        return None
    with TemporaryDirectory(prefix="printbee-docx-") as directory:
        folder = Path(directory)
        source = folder / "document.docx"
        source.write_bytes(content)
        try:
            subprocess.run(
                [executable, "-env:UserInstallation=" + (folder / "profile").as_uri(),
                 "--headless", "--convert-to", "pdf", "--outdir", str(folder), str(source)],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=30, check=True,
            )
            result = folder / "document.pdf"
            if result.stat().st_size > 50 * 1024 * 1024:
                raise ValueError("The rendered document is too large.")
            return result.read_bytes()
        except (OSError, subprocess.SubprocessError) as error:
            raise ValueError("Use a readable DOCX or export it as PDF.") from error


def count_pages(name, content):
    suffix = PurePath(name).suffix.lower()
    if suffix == ".docx":
        pdf = render_docx(content)
        return count_pages("document.pdf", pdf) if pdf else None
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

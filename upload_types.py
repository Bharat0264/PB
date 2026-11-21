"""Which files PrintBee accepts for printing, checked on the server.

Only PDF, DOCX, JPG and PNG. A file must pass all three checks:
  1. the file name ends in an allowed extension,
  2. the MIME type the browser declared (when it declared one) belongs to that extension,
  3. the real content starts the way that format really starts (magic bytes; for DOCX the ZIP must hold a Word document).
The browser's checks in studio.js are only for a friendly message; this is the one that counts.
"""
import io
import zipfile
from pathlib import PurePath

MAX_BYTES = 50 * 1024 * 1024               # same limit the order pages and checkout use
MAX_UNPACKED_DOCX = 300 * 1024 * 1024      # a DOCX that unpacks to more than this is treated as a zip bomb
MESSAGE = "Only PDF, DOCX, JPG and PNG files are supported."

EXTENSIONS = {".pdf": "pdf", ".docx": "docx", ".jpg": "jpg", ".jpeg": "jpg", ".png": "png"}
MIME_TYPES = {
    "pdf": {"application/pdf"},
    "docx": {"application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
    "jpg": {"image/jpeg"},
    "png": {"image/png"},
}
# Some browsers send no type, or a generic one. That is allowed only because the content check below still has to pass.
GENERIC_MIME = {"", "application/octet-stream"}


def kind_of(name):
    """'pdf' | 'docx' | 'jpg' | 'png' for an allowed file name, else None."""
    return EXTENSIONS.get(PurePath(str(name)).suffix.lower())


def check_name(name):
    kind = kind_of(name)
    if kind is None:
        raise ValueError(MESSAGE)
    return kind


def _is_docx(content):
    if not content.startswith(b"PK\x03\x04"):
        return False
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            names = set(archive.namelist())
            if "[Content_Types].xml" not in names or "word/document.xml" not in names:
                return False
            return sum(info.file_size for info in archive.infolist()) <= MAX_UNPACKED_DOCX
    except (zipfile.BadZipFile, ValueError, OSError):
        return False


MAGIC = {
    "pdf": lambda c: b"%PDF-" in c[:1024],
    "docx": _is_docx,
    "jpg": lambda c: c.startswith(b"\xff\xd8\xff"),
    "png": lambda c: c.startswith(b"\x89PNG\r\n\x1a\n"),
}


def validate_upload(name, content, mime=None):
    """Return the file kind or raise ValueError(message) for anything that is not a real PDF, DOCX, JPG or PNG."""
    kind = check_name(name)
    if not content or len(content) > MAX_BYTES:
        raise ValueError("Files must be non-empty and no larger than 50 MB.")
    declared = (mime or "").split(";")[0].strip().lower()
    if declared not in GENERIC_MIME and declared not in MIME_TYPES[kind]:
        raise ValueError(f"The file type ({declared}) does not match its name. {MESSAGE}")
    if not MAGIC[kind](content):
        raise ValueError(f"The contents of this file are not a real {kind.upper()}. {MESSAGE}")
    return kind

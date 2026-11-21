"""Limits that keep one visitor from using up the server's threads and memory.

* The public page counter (no sign-in): one file at a time and a fair number per 10 minutes per visitor address,
  with room for a few files at once overall.
* Live-update streams: each holds a thread, so one person may keep only a few open.
"""
import threading
import time
from threading import BoundedSemaphore

DOCUMENT_READERS = BoundedSemaphore(3)

# The public page counter (no sign-in) is limited per visitor address: one file at a time, and a fair number
# per 10 minutes. The number is generous because a whole campus can share one address.
PAGE_COUNT_PER_WINDOW, PAGE_COUNT_WINDOW = 120, 600
PAGE_COUNT_BUSY, PAGE_COUNT_LOG = set(), {}
PAGE_COUNT_LOCK = threading.Lock()


def claim_page_counter(ip, now=None):
    """None when this address may count pages now, else a (status, body) refusal. Release with release_page_counter."""
    now = now if now is not None else time.time()
    with PAGE_COUNT_LOCK:
        if len(PAGE_COUNT_LOG) > 5000:                      # forget addresses that have gone quiet
            for key in [k for k, times in PAGE_COUNT_LOG.items() if not times or times[-1] < now - PAGE_COUNT_WINDOW]:
                PAGE_COUNT_LOG.pop(key, None)
        recent = [t for t in PAGE_COUNT_LOG.get(ip, ()) if t > now - PAGE_COUNT_WINDOW]
        if len(recent) >= PAGE_COUNT_PER_WINDOW:
            PAGE_COUNT_LOG[ip] = recent
            return 429, {"error": "Too many files checked from this connection. Please try again in a few minutes."}
        if ip in PAGE_COUNT_BUSY:
            return 503, {"error": "Page counting is busy. Try again."}
        PAGE_COUNT_BUSY.add(ip)
        PAGE_COUNT_LOG[ip] = recent + [now]
        return None


def release_page_counter(ip):
    with PAGE_COUNT_LOCK:
        PAGE_COUNT_BUSY.discard(ip)


# Live-update streams hold a thread each, so one person may keep only a few open (the page falls back to polling).
STREAMS_PER_PERSON, STREAMS_TOTAL = 3, 400
OPEN_STREAMS = {}
STREAM_LOCK = threading.Lock()


def take_stream_slot(person):
    with STREAM_LOCK:
        if OPEN_STREAMS.get(person, 0) >= STREAMS_PER_PERSON or sum(OPEN_STREAMS.values()) >= STREAMS_TOTAL:
            return False
        OPEN_STREAMS[person] = OPEN_STREAMS.get(person, 0) + 1
        return True


def release_stream_slot(person):
    with STREAM_LOCK:
        if OPEN_STREAMS.get(person, 0) <= 1:
            OPEN_STREAMS.pop(person, None)
        else:
            OPEN_STREAMS[person] -= 1

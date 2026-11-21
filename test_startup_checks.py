import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from test_e2e_workflow import free_port

ROOT = Path(__file__).resolve().parent


def start(*args, **env):
    folder = tempfile.mkdtemp(prefix="printbee-start-")
    clean = {k: v for k, v in os.environ.items() if not k.startswith("PRINTBEE_")}
    clean.update({"PRINTBEE_DATA_DIR": folder, **env})
    port = free_port()
    process = subprocess.Popen([sys.executable, str(ROOT / "server.py"), "--port", str(port), *args], cwd=ROOT, env=clean,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return process, port


def outcome(process, seconds=4):
    """('refused', message) if the server exits, ('running', '') if it is still up after a few seconds."""
    try:
        output, _ = process.communicate(timeout=seconds)
        return "refused", output.strip()
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate()
        return "running", ""


class StartupChecks(unittest.TestCase):
    def test_a_public_server_without_an_https_origin_refuses_to_start(self):
        for env in ({}, {"PRINTBEE_ORIGIN": "http://printbee.example"}):
            state, message = outcome(start("--host", "0.0.0.0", **env)[0])
            self.assertEqual(state, "refused", env)
            self.assertIn("PRINTBEE_ORIGIN", message)

    def test_a_public_server_with_an_https_origin_starts(self):
        state, _ = outcome(start("--host", "0.0.0.0", PRINTBEE_ORIGIN="https://printbee.example")[0])
        self.assertEqual(state, "running")

    def test_local_development_still_starts_without_an_origin_even_with_test_payments(self):
        self.assertEqual(outcome(start()[0])[0], "running")
        self.assertEqual(outcome(start(PRINTBEE_PAYMENT_MODE="test")[0])[0], "running")

    def test_test_payments_are_refused_with_a_real_origin(self):
        state, message = outcome(start(PRINTBEE_PAYMENT_MODE="test", PRINTBEE_ORIGIN="https://printbee.example")[0])
        self.assertEqual((state, "Test payments require a local origin." in message), ("refused", True))


if __name__ == "__main__":
    unittest.main()

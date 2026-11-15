"""Runs tests/proxy-harness.mjs: the Vercel /api proxy against a real server (needs Node 20+)."""
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent


@unittest.skipUnless(shutil.which("node"), "Node.js is required for the proxy test")
class VercelProxyTests(unittest.TestCase):
    def test_proxy_signs_in_every_role_and_forwards_cookies_bodies_and_the_live_feed(self):
        result = subprocess.run(["node", str(ROOT / "tests" / "proxy-harness.mjs")], cwd=ROOT,
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()

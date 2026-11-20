import re
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CUSTOMER_PAGES = ["address", "cart", "help", "index", "navigation", "orders", "pricing", "profile", "queue", "terms", "themes"]
REQUIRED = re.search(r"const REQUIRED_TOKENS = \[(.*?)\];", (ROOT / "theme-engine.js").read_text(encoding="utf-8"), re.S)


class ThemeFoundationTests(unittest.TestCase):
    def test_every_customer_page_loads_the_engine_before_hive_theme(self):
        for name in CUSTOMER_PAGES:
            html = (ROOT / f"{name}.html").read_text(encoding="utf-8")
            for asset in ("theme-registry.js", "theme-engine.js", "theme-engine.css", "theme-adapter.css"):
                self.assertIn(asset, html, f"{name}.html is missing {asset}")
            self.assertLess(html.index("theme-engine.js"), html.index("hive-theme.js"), name)
            self.assertLess(html.index("theme-registry.js"), html.index("theme-engine.js"), name)

    def test_staff_portals_are_untouched(self):
        for name in ("staff", "admin", "partner", "admin-preview"):
            self.assertNotIn("theme-engine", (ROOT / f"{name}.html").read_text(encoding="utf-8"))

    def test_server_serves_theme_files(self):
        source = (ROOT / "server.py").read_text(encoding="utf-8")
        for asset in ("/theme-registry.js", "/theme-engine.js", "/theme-engine.css", "/theme-adapter.css", "/themes.html", "/themes.js", "/themes.css"):
            self.assertIn(f'"{asset}"', source)
        self.assertIn('"/themes"', source)

    def test_default_theme_is_registered_and_keeps_existing_tokens(self):
        registry = (ROOT / "theme-registry.js").read_text(encoding="utf-8")
        self.assertIn("id: 'printbee'", registry)
        self.assertIn("default: true", registry)
        self.assertIn("tokens: null", registry)         # the default draws from the existing stylesheets

    def test_every_required_token_has_a_default_and_a_bridge_free_default_theme(self):
        css = (ROOT / "theme-engine.css").read_text(encoding="utf-8")
        for name in re.findall(r"'([a-z0-9-]+)'", REQUIRED.group(1)):
            self.assertRegex(css, r"--pb-" + re.escape(name) + r":", name)
        # the bridge must never apply to the default theme
        for selector in re.findall(r"^(:root\[data-pb-theme\][^{]*)\{", css, re.M):
            if ":not([data-pb-theme=\"printbee\"])" not in selector and "data-pb-mode-locked" not in selector:
                self.fail("bridge rule can hit the default theme: " + selector)

    def test_theme_stylesheets_use_tokens_not_literal_colours(self):
        css = re.sub(r"/\*.*?\*/", "", (ROOT / "themes.css").read_text(encoding="utf-8"), flags=re.S)
        self.assertEqual(re.findall(r"#[0-9a-fA-F]{3,8}\b|rgba?\(", css), [])

    def test_adapter_is_up_to_date(self):
        result = subprocess.run([sys.executable, str(ROOT / "tools" / "build_theme_adapter.py"), "--check"], capture_output=True)
        self.assertEqual(result.returncode, 0, "Run: python tools/build_theme_adapter.py")

    def test_docs_exist_and_explain_adding_a_theme(self):
        text = (ROOT / "THEMES.md").read_text(encoding="utf-8")
        self.assertIn("Add a new theme", text)
        self.assertIn("theme-registry.js", text)


def _luminance(hex_colour):
    channels = [int(hex_colour[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [c / 12.92 if c <= .03928 else ((c + .055) / 1.055) ** 2.4 for c in channels]
    return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2]


def _contrast(a, b):
    high, low = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (high + .05) / (low + .05)


class QuickSwitchTests(unittest.TestCase):
    def test_header_has_a_one_tap_theme_button(self):
        engine = (ROOT / "theme-engine.js").read_text(encoding="utf-8")
        css = (ROOT / "theme-engine.css").read_text(encoding="utf-8")
        self.assertIn("customer-header-actions", engine)
        self.assertIn("themes.size < 2", engine)              # no button until there is something to switch to
        self.assertIn("aria-label", engine)
        self.assertIn(".theme-quick", css)
        self.assertIn("prefers-reduced-motion", css)


class ThemeEngineSafetyTests(unittest.TestCase):
    def test_a_theme_with_missing_files_falls_back_to_printbee(self):
        engine = (ROOT / "theme-engine.js").read_text(encoding="utf-8")
        self.assertIn("link.onerror", engine)
        self.assertIn("could not load its files", engine)
        self.assertIn("set(DEFAULT_ID, {persist: false})", engine)      # the saved choice is kept, so it works after a deploy

    def test_low_power_devices_are_detected(self):
        engine = (ROOT / "theme-engine.js").read_text(encoding="utf-8")
        self.assertIn("hardwareConcurrency", engine)
        self.assertIn("saveData", engine)


class NoWildfireTests(unittest.TestCase):
    """The Wildfire theme and its 3D models were removed on request; only PrintBee remains."""

    def test_wildfire_is_gone(self):
        self.assertFalse((ROOT / "themes").exists())
        self.assertFalse((ROOT / "models").exists())
        for name in ("theme-registry.js", "Dockerfile", ".dockerignore", "server.py"):
            self.assertNotIn("wildfire", (ROOT / name).read_text(encoding="utf-8").lower(), name)
        registry = (ROOT / "theme-registry.js").read_text(encoding="utf-8")
        self.assertEqual(registry.count("id: '"), 1)                  # PrintBee is the only theme
        for text in ((ROOT / "Dockerfile").read_text(encoding="utf-8"),):
            self.assertNotIn("COPY themes", text)
            self.assertNotIn("COPY models", text)

    def test_the_buzz_bee_models_are_untouched(self):
        self.assertTrue((ROOT / "buzz-bee.glb").exists())
        self.assertTrue((ROOT / "bee_hq.glb").exists())

    def test_no_switch_button_is_offered_with_a_single_theme(self):
        self.assertIn("themes.size < 2", (ROOT / "theme-engine.js").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()

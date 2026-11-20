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
        self.assertIn(r"/themes/[a-z0-9-]+\.(css|js|woff2)", source)
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


if __name__ == "__main__":
    unittest.main()

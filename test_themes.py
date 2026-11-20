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


def _luminance(hex_colour):
    channels = [int(hex_colour[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [c / 12.92 if c <= .03928 else ((c + .055) / 1.055) ** 2.4 for c in channels]
    return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2]


def _contrast(a, b):
    high, low = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (high + .05) / (low + .05)


class WildfireThemeTests(unittest.TestCase):
    registry = (ROOT / "theme-registry.js").read_text(encoding="utf-8")

    def token(self, name):
        block = self.registry[self.registry.index("id: 'wildfire'"):]
        block = block[block.index("tokens:"):]
        return re.search(r"(?<![\w-])'?" + re.escape(name) + r"'?: '(#[0-9A-Fa-f]{6})'", block).group(1)

    def test_wildfire_is_registered_with_a_complete_dark_token_set(self):
        block = self.registry[self.registry.index("id: 'wildfire'"):]
        self.assertIn("modes: ['dark']", block)
        tokens = block[block.index("tokens:"):]
        for name in re.findall(r"'([a-z0-9-]+)'", REQUIRED.group(1)):
            self.assertRegex(tokens, r"(?<![\w-])'?" + re.escape(name) + r"'?:", name)

    def test_printbee_default_entry_is_unchanged(self):
        default = self.registry[self.registry.index("id: 'printbee'"):self.registry.index("// Wildfire:")]
        self.assertIn("default: true", default)
        self.assertIn("tokens: null", default)
        self.assertNotIn("stylesheet:", default)
        self.assertNotIn("script:", default)

    def test_wildfire_text_colours_are_readable(self):
        surface, page = self.token("surface"), self.token("page")
        self.assertGreaterEqual(_contrast(self.token("ink"), surface), 7)
        self.assertGreaterEqual(_contrast(self.token("muted"), surface), 4.5)
        self.assertGreaterEqual(_contrast(self.token("muted"), page), 4.5)
        self.assertGreaterEqual(_contrast(self.token("accent-ink"), self.token("accent")), 4.5)
        self.assertGreaterEqual(_contrast(self.token("accent-strong"), surface), 4.5)
        for status in ("success", "warning", "danger", "info"):
            self.assertGreaterEqual(_contrast(self.token(status), surface), 4.5, status)

    def test_wildfire_files_exist_and_are_scoped(self):
        css = (ROOT / "themes" / "wildfire.css").read_text(encoding="utf-8")
        self.assertTrue((ROOT / "themes" / "wildfire.js").exists())
        css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
        selectors = re.findall(r"^\s*([^\s@}/;][^{};]*)\{", css, re.M)
        self.assertGreater(len(selectors), 30)
        for selector in selectors:
            head = selector.strip()
            if head.startswith(("from", "to")) or re.match(r"^[\d.%, ]+$", head):
                continue                                    # keyframe steps
            self.assertIn('data-pb-theme="wildfire"', head, "unscoped selector: " + head[:80])

    def test_wildfire_respects_reduced_motion(self):
        css = (ROOT / "themes" / "wildfire.css").read_text(encoding="utf-8")
        script = (ROOT / "themes" / "wildfire.js").read_text(encoding="utf-8")
        self.assertIn("prefers-reduced-motion: reduce", css)
        self.assertIn("prefers-reduced-motion: no-preference", css)
        self.assertIn("prefers-reduced-motion: reduce", script)
        self.assertIn("document.hidden", script)             # pauses while the tab is hidden


class WildfireCinematicTests(unittest.TestCase):
    MODELS = ("emblem", "embers", "marker", "signpost", "crate", "press", "logs", "truck")

    def test_web_models_are_light_and_the_originals_are_not_shipped(self):
        total = 0
        for name in self.MODELS:
            path = ROOT / "models" / "wildfire" / f"{name}.glb"
            self.assertTrue(path.exists(), name)
            size = path.stat().st_size
            total += size
            self.assertLess(size, 6 * 1024 * 1024, f"{name}.glb is too heavy for the web")
        self.assertLess(total, 20 * 1024 * 1024)
        big = [p.name for p in ROOT.rglob("*.glb") if ".git" not in p.parts and p.stat().st_size > 8 * 1024 * 1024]
        self.assertEqual(big, [], "original high-resolution models must stay out of the repository")

    def test_posters_and_title_data_exist(self):
        for name in ("wf-hero-wide", "wf-hero-tall", "wf-embers", "wf-press", "wf-truck", "wf-signpost", "wf-marker", "wf-crate", "wf-logs"):
            self.assertTrue((ROOT / "themes" / "img" / f"{name}.webp").exists(), name)
        title = (ROOT / "themes" / "wildfire-title.js").read_text(encoding="utf-8")
        self.assertIn('"text":"PrintBee"', title)
        self.assertEqual(title.count('"char"'), 8)

    def test_server_serves_models_and_pictures(self):
        source = (ROOT / "server.py").read_text(encoding="utf-8")
        self.assertIn(r"/models/wildfire/[a-z0-9-]+\.glb", source)
        self.assertIn(r"/themes/img/[a-z0-9-]+\.webp", source)

    def test_hero_is_lazy_safe_and_cleans_up(self):
        hero = (ROOT / "themes" / "wildfire-hero.js").read_text(encoding="utf-8")
        home = (ROOT / "themes" / "wildfire-home.js").read_text(encoding="utf-8")
        effects = (ROOT / "themes" / "wildfire.js").read_text(encoding="utf-8")
        self.assertIn("prefers-reduced-motion: reduce", hero)
        self.assertIn("forceContextLoss", hero)                  # the WebGL context is released on destroy
        self.assertIn("document.hidden", hero)                    # no drawing while the tab is hidden
        self.assertIn("IntersectionObserver", home)
        self.assertIn("requestIdleCallback", home)                # the 3D scene is not started at page load
        self.assertIn("import('/themes/wildfire-home.js", effects)
        self.assertIn("home?.destroy()", effects)                 # switching away removes the home layer
        for module in (hero, home):
            self.assertNotIn("fetch(", module)                    # no API calls: business logic is untouched

    def test_title_is_in_front_of_the_emblem(self):
        hero = (ROOT / "themes" / "wildfire-hero.js").read_text(encoding="utf-8")
        self.assertIn("titleZ: .72", hero)
        self.assertIn("emblem.position.set(0, Math.sin(idle * .55) * .035, -.25 * (1 - em) - .05)", hero)
        self.assertIn("castShadow = true", hero)                  # the title throws its shadow on the emblem


if __name__ == "__main__":
    unittest.main()

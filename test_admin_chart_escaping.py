import re
import unittest
from pathlib import Path

SOURCE = (Path(__file__).resolve().parent / "admin-dashboard.js").read_text(encoding="utf-8")


class AdminChartEscapingTests(unittest.TestCase):
    def test_chart_legend_names_are_escaped(self):
        legend = next(line for line in SOURCE.splitlines() if 'class="legend"' in line)
        self.assertIn("escape(entry.name)", legend)
        self.assertNotIn("${entry.name}", legend)

    def test_no_chart_template_inserts_a_raw_entry_name(self):
        self.assertEqual(re.findall(r"\$\{entry\.name\}", SOURCE), [])


if __name__ == "__main__":
    unittest.main()

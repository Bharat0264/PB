import shutil
import subprocess
import unittest
from pathlib import Path


class ThemePreferencesTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for theme runtime tests')
    def test_default_and_saved_preferences_in_the_real_engine(self):
        root = Path(__file__).resolve().parent
        result = subprocess.run(['node', str(root / 'tools/test_theme_preferences.cjs')], cwd=root,
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()

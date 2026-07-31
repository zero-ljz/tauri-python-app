from __future__ import annotations

import argparse
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from scripts.init_template import initialize

ROOT = Path(__file__).resolve().parents[1]


class TemplateInitializationTests(unittest.TestCase):
    def test_initialization_updates_all_project_identity_files(self) -> None:
        relative_files = (
            "package.json",
            "README.md",
            "index.html",
            "LICENSE",
            "src-tauri/tauri.conf.json",
            "src-tauri/Cargo.toml",
            "src-tauri/Cargo.lock",
            "src-tauri/src/main.rs",
            "src/components/titlebar/AppMenu.tsx",
        )
        with tempfile.TemporaryDirectory(prefix="template-init-test-") as temp_directory:
            target_root = Path(temp_directory)
            for relative_file in relative_files:
                source = ROOT / relative_file
                target = target_root / relative_file
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)

            args = argparse.Namespace(
                name="sample-desktop-app",
                product_name="Sample Desktop App",
                identifier="com.example.sampledesktopapp",
                author="Sample Author",
                description="A sample application",
                repository="example/sample-desktop-app",
                force=False,
            )
            initialize(args, target_root)

            package = json.loads((target_root / "package.json").read_text(encoding="utf-8"))
            tauri = json.loads(
                (target_root / "src-tauri/tauri.conf.json").read_text(encoding="utf-8")
            )
            cargo = (target_root / "src-tauri/Cargo.toml").read_text(encoding="utf-8")
            lock = (target_root / "src-tauri/Cargo.lock").read_text(encoding="utf-8")
            main = (target_root / "src-tauri/src/main.rs").read_text(encoding="utf-8")

            self.assertEqual(package["name"], "sample-desktop-app")
            self.assertEqual(
                package["repository"]["url"], "https://github.com/example/sample-desktop-app.git"
            )
            self.assertEqual(tauri["productName"], "Sample Desktop App")
            self.assertEqual(tauri["identifier"], "com.example.sampledesktopapp")
            self.assertIn('name = "sample-desktop-app"', cargo)
            self.assertIn('name = "sample-desktop-app"', lock)
            self.assertIn("sample_desktop_app_lib::run()", main)


if __name__ == "__main__":
    unittest.main()

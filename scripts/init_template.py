from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NPM_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
IDENTIFIER = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$")


def rust_identifier(value: str) -> str:
    result = re.sub(r"[^A-Za-z0-9_]", "_", value)
    if not result or result[0].isdigit():
        result = f"app_{result}"
    return result


def replace_once(contents: str, pattern: str, replacement: str, label: str) -> str:
    updated, count = re.subn(pattern, replacement, contents, count=1, flags=re.MULTILINE)
    if count != 1:
        raise RuntimeError(f"Unable to update {label}")
    return updated


def initialize(args: argparse.Namespace, root: Path = ROOT) -> None:
    if not NPM_NAME.fullmatch(args.name):
        raise ValueError("--name must be a lowercase npm-compatible package name")
    if not IDENTIFIER.fullmatch(args.identifier):
        raise ValueError("--identifier must be a reverse-domain identifier")

    package_path = root / "package.json"
    package = json.loads(package_path.read_text(encoding="utf-8"))
    old_name = str(package["name"])
    if old_name != "tauri-python-app" and not args.force:
        raise RuntimeError("This template was already initialized; pass --force to reinitialize it")

    product_name = args.product_name or args.name
    package.update(
        {
            "name": args.name,
            "description": args.description,
            "author": args.author,
            "license": "MIT",
        }
    )
    if args.repository:
        package["repository"] = {
            "type": "git",
            "url": f"https://github.com/{args.repository}.git",
        }
    package_path.write_text(
        json.dumps(package, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    tauri_path = root / "src-tauri" / "tauri.conf.json"
    tauri = json.loads(tauri_path.read_text(encoding="utf-8"))
    tauri["productName"] = product_name
    tauri["identifier"] = args.identifier
    for window in tauri.get("app", {}).get("windows", []):
        if window.get("label") == "main":
            window["title"] = product_name
    tauri_path.write_text(json.dumps(tauri, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    cargo_path = root / "src-tauri" / "Cargo.toml"
    cargo = cargo_path.read_text(encoding="utf-8")
    cargo = replace_once(
        cargo, r'^name\s*=\s*"[^"]+"', f'name = "{args.name}"', "Cargo package name"
    )
    cargo = replace_once(
        cargo,
        r'^description\s*=\s*"[^"]*"',
        f"description = {json.dumps(args.description)}",
        "Cargo description",
    )
    cargo = replace_once(
        cargo,
        r"^authors\s*=\s*\[[^\]]*\]",
        f"authors = [{json.dumps(args.author)}]",
        "Cargo authors",
    )
    old_lib_match = re.search(r'(?ms)^\[lib\].*?^name\s*=\s*"([^"]+)"', cargo)
    if old_lib_match is None:
        raise RuntimeError("Unable to find Cargo library name")
    old_lib = old_lib_match.group(1)
    new_lib = rust_identifier(f"{args.name}_lib")
    cargo = replace_once(
        cargo,
        r'(?m)(^\[lib\]\s*(?:#[^\n]*\n|\s)*name\s*=\s*)"[^"]+"',
        rf'\g<1>"{new_lib}"',
        "Cargo library name",
    )
    cargo_path.write_text(cargo, encoding="utf-8", newline="\n")

    cargo_lock_path = root / "src-tauri" / "Cargo.lock"
    cargo_lock = replace_once(
        cargo_lock_path.read_text(encoding="utf-8"),
        rf'(?ms)(^\[\[package\]\]\s*^name = "){re.escape(old_name)}("\s*^version = "[^"]+")',
        rf"\g<1>{args.name}\2",
        "Cargo.lock package name",
    )
    cargo_lock_path.write_text(cargo_lock, encoding="utf-8", newline="\n")

    main_path = root / "src-tauri" / "src" / "main.rs"
    main_source = main_path.read_text(encoding="utf-8").replace(old_lib, new_lib)
    main_path.write_text(main_source, encoding="utf-8", newline="\n")

    text_replacements = {
        root / "README.md": [(old_name, args.name)],
        root / "index.html": [(old_name, product_name)],
        root / "src" / "components" / "titlebar" / "AppMenu.tsx": [(old_name, product_name)],
        root / "LICENSE": [("Template Authors", args.author)],
    }
    for path, replacements in text_replacements.items():
        contents = path.read_text(encoding="utf-8")
        for old, new in replacements:
            contents = contents.replace(old, new)
        path.write_text(contents, encoding="utf-8", newline="\n")

    print(f"Initialized template as {product_name} ({args.identifier})")
    print("Run: pnpm install && python scripts/sync_version.py --check && pnpm check")


def main() -> None:
    parser = argparse.ArgumentParser(description="Initialize this repository as a new application.")
    parser.add_argument("--name", required=True, help="Lowercase package name")
    parser.add_argument("--product-name", help="User-facing application name")
    parser.add_argument("--identifier", required=True, help="Reverse-domain bundle identifier")
    parser.add_argument("--author", required=True)
    parser.add_argument("--description", required=True)
    parser.add_argument("--repository", help="GitHub owner/repository")
    parser.add_argument("--force", action="store_true")
    initialize(parser.parse_args())


if __name__ == "__main__":
    main()

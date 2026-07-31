from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE_JSON = ROOT / "package.json"
TAURI_CONFIG = ROOT / "src-tauri" / "tauri.conf.json"
CARGO_TOML = ROOT / "src-tauri" / "Cargo.toml"
CARGO_LOCK = ROOT / "src-tauri" / "Cargo.lock"
SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")


def read_versions() -> dict[str, str]:
    package = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
    tauri = json.loads(TAURI_CONFIG.read_text(encoding="utf-8"))
    cargo = CARGO_TOML.read_text(encoding="utf-8")
    match = re.search(r"(?ms)^\[package\].*?^version\s*=\s*\"([^\"]+)\"", cargo)
    if match is None:
        raise RuntimeError("Unable to find [package].version in Cargo.toml")
    lock_match = re.search(
        rf'(?ms)^\[\[package\]\]\s*^name = "{re.escape(str(package["name"]))}"\s*^version = "([^"]+)"',
        CARGO_LOCK.read_text(encoding="utf-8"),
    )
    if lock_match is None:
        raise RuntimeError(f"Unable to find Cargo.lock entry for {package['name']}")
    return {
        "package.json": str(package["version"]),
        "tauri.conf.json": str(tauri["version"]),
        "Cargo.toml": match.group(1),
        "Cargo.lock": lock_match.group(1),
    }


def replace_cargo_version(contents: str, version: str) -> str:
    updated, count = re.subn(
        r"(?ms)(^\[package\].*?^version\s*=\s*\")[^\"]+(\")",
        rf"\g<1>{version}\2",
        contents,
        count=1,
    )
    if count != 1:
        raise RuntimeError("Unable to update Cargo.toml package version")
    return updated


def replace_lock_version(contents: str, package_name: str, version: str) -> str:
    pattern = re.compile(
        rf'(?ms)(^\[\[package\]\]\s*^name = "{re.escape(package_name)}"\s*^version = ")[^"]+(".*?)(?=^\[\[package\]\]|\Z)'
    )
    updated, count = pattern.subn(rf"\g<1>{version}\2", contents, count=1)
    if count != 1:
        raise RuntimeError(f"Unable to update Cargo.lock entry for {package_name}")
    return updated


def set_version(version: str) -> None:
    if not SEMVER.fullmatch(version):
        raise ValueError(f"Version must be SemVer: {version}")

    package = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
    package["version"] = version
    PACKAGE_JSON.write_text(
        json.dumps(package, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    tauri = json.loads(TAURI_CONFIG.read_text(encoding="utf-8"))
    tauri["version"] = version
    TAURI_CONFIG.write_text(
        json.dumps(tauri, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    cargo = replace_cargo_version(CARGO_TOML.read_text(encoding="utf-8"), version)
    CARGO_TOML.write_text(cargo, encoding="utf-8", newline="\n")
    CARGO_LOCK.write_text(
        replace_lock_version(
            CARGO_LOCK.read_text(encoding="utf-8"),
            str(package["name"]),
            version,
        ),
        encoding="utf-8",
        newline="\n",
    )


def check_versions() -> None:
    versions = read_versions()
    if len(set(versions.values())) != 1:
        details = ", ".join(f"{path}={version}" for path, version in versions.items())
        raise SystemExit(f"Application versions are inconsistent: {details}")
    print(f"Version is synchronized: {next(iter(versions.values()))}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Check or update all application versions.")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--check", action="store_true")
    action.add_argument("--set", dest="version")
    args = parser.parse_args()
    if args.version:
        set_version(args.version)
    check_versions()


if __name__ == "__main__":
    main()

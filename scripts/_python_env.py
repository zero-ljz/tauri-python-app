from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Iterable
from pathlib import Path


def venv_python(venv_dir: Path) -> Path:
    if os.name == "nt":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def local_venv_python(venv_dirs: Iterable[Path]) -> Path | None:
    for venv_dir in venv_dirs:
        python = venv_python(venv_dir)
        if python.is_file():
            return python
    return None


def reexec_with_local_venv(root: Path, guard_env: str, venv_dirs: Iterable[Path]) -> None:
    if os.environ.get(guard_env) == "1":
        return

    python = local_venv_python(venv_dirs)
    if python is None:
        return

    current = Path(sys.executable).resolve()
    if current == python.resolve():
        return

    env = os.environ.copy()
    env[guard_env] = "1"
    completed = subprocess.run([str(python), *sys.argv], cwd=root, env=env)
    raise SystemExit(completed.returncode)


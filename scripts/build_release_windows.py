#!/usr/bin/env python3
"""Build the browser-hosted and native-desktop Windows release bundles."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SPECS = (
    ROOT / "packaging" / "camoufox-pm-web.spec",
    ROOT / "packaging" / "camoufox-pm-desktop.spec",
)


def main() -> int:
    subprocess.run([sys.executable, str(ROOT / "scripts" / "build_webui.py")], check=True)
    for spec in SPECS:
        subprocess.run(
            [sys.executable, "-m", "PyInstaller", str(spec), "--noconfirm", "--clean"],
            cwd=ROOT,
            check=True,
        )
    print("Windows release bundles complete — see dist/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

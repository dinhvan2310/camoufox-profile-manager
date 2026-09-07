"""PyInstaller entry point for the native desktop application."""

from __future__ import annotations

import sys

from camoufox_pm.cli import main


if __name__ == "__main__":
    sys.argv.insert(1, "--desktop")
    main()

"""PyInstaller spec for the native Desktop executable."""

import os

from PyInstaller.utils.hooks import collect_all, collect_submodules

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))
datas = [(os.path.join(ROOT, "src", "camoufox_pm", "webui"), "camoufox_pm/webui")]
binaries = []
hiddenimports = collect_submodules("uvicorn") + collect_submodules("webview")

for _pkg in ("camoufox", "browserforge", "apify_fingerprint_datapoints", "language_tags", "ua_parser", "webview"):
    _d, _b, _h = collect_all(_pkg)
    datas += _d
    binaries += _b
    hiddenimports += _h

a = Analysis([os.path.join(SPECPATH, "launch_desktop.py")], pathex=[], binaries=binaries, datas=datas, hiddenimports=hiddenimports)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="Camoufox-Profile-Manager-Desktop", console=False)
coll = COLLECT(exe, a.binaries, a.datas, name="Camoufox-Profile-Manager-Desktop")

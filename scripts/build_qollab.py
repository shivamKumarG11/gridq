"""Package exactly what Qollab needs into dist/gridq-qollab.zip (upload via Code tab > upload archive).

Checks Qollab's limits: at most 100 files, 2 MB per file, and the top-level index.html + main.js
that make it a JS project.   python scripts/build_qollab.py"""
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INCLUDE = ["index.html", "main.js", "main.css", "README.md", "LICENSE", "results/precomputed.json"]
INCLUDE_GLOBS = ["engine/*.py", "ui/*.js"]
MAX_FILES, MAX_BYTES = 100, 2 * 1024 * 1024


def main():
    files = [ROOT / f for f in INCLUDE]
    for g in INCLUDE_GLOBS:
        files += sorted(ROOT.glob(g))
    missing = [f for f in files if not f.is_file()]
    if missing:
        sys.exit(f"missing: {missing}")
    if len(files) > MAX_FILES:
        sys.exit(f"{len(files)} files > Qollab's {MAX_FILES}")
    big = [(f, f.stat().st_size) for f in files if f.stat().st_size > MAX_BYTES]
    if big:
        sys.exit(f"over 2 MB: {big}")
    out = ROOT / "dist" / "gridq-qollab.zip"
    out.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files:
            z.write(f, f.relative_to(ROOT).as_posix())
    total = sum(f.stat().st_size for f in files)
    print(f"{out}  {len(files)} files, {total / 1024:.0f} KB uncompressed, largest {max(f.stat().st_size for f in files) / 1024:.0f} KB")
    for f in files:
        print("  ", f.relative_to(ROOT).as_posix())


if __name__ == "__main__":
    main()

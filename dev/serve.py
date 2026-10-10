"""Local development server: the same page and the same engine as on Qollab, with CPython in place of
Pyodide and Qiskit's BasicSimulator (what Qollab's built-in simulator is) as `backend`.

    python dev/serve.py [--port 8765] [--ideal]

Not part of the Qollab upload."""
import argparse
import json
import mimetypes
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import os  # noqa: E402

os.chdir(ROOT)  # the engine opens results/... relative to the project root, as on Qollab
from engine import api  # noqa: E402

THREE = "https://cdn.jsdelivr.net/npm/three@0.186.1"


def page():
    body = (ROOT / "index.html").read_text(encoding="utf-8")
    imports = {"three": f"{THREE}/build/three.module.js", "three/addons/": f"{THREE}/examples/jsm/"}
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>GridQ (dev)</title>
<link rel="stylesheet" href="/main.css"><script type="importmap">{json.dumps({"imports": imports})}</script>
</head><body style="margin:0">{body}<script type="module" src="/dev/dev.js"></script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    backend = None

    def _send(self, code, data, ctype):
        b = data.encode("utf-8") if isinstance(data, str) else data
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/":
            return self._send(200, page(), "text/html; charset=utf-8")
        f = (ROOT / path.lstrip("/")).resolve()
        if ROOT not in f.parents or not f.is_file():
            return self._send(404, "not found", "text/plain")
        ctype = "text/javascript" if f.suffix in (".js", ".mjs") else (mimetypes.guess_type(f.name)[0] or "application/octet-stream")
        self._send(200, f.read_bytes(), ctype)

    def do_POST(self):
        name = self.path.split("?")[0].removeprefix("/api/")
        fn = getattr(api, name, None)
        if not callable(fn) or name.startswith("_"):
            return self._send(404, "no such api function", "text/plain")
        try:
            kwargs = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            self._send(200, fn(self.backend, **kwargs), "application/json")
        except Exception:
            self._send(500, traceback.format_exc(), "text/plain")

    def log_message(self, fmt, *args):
        if "/api/" in self.path:
            sys.stderr.write("[dev] " + fmt % args + "\n")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--ideal", action="store_true", help="no backend: sample from the ideal statevector")
    a = ap.parse_args()
    if not a.ideal:
        from qiskit.providers.basic_provider import BasicSimulator
        Handler.backend = BasicSimulator()
    print(f"GridQ dev server on http://localhost:{a.port}  (backend: {api.pipeline.backend_name(Handler.backend)})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()

"""Writes tests/fixtures/qaoa_case.json for the JS parity test."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from engine import qaoa, qubo  # noqa: E402
from engine.dispatch import ALL_PLANS  # noqa: E402

q = qubo.build(1300.0, 130.0)
E = qubo.energies(q)
g, b = [0.8, 0.3], [0.5, 0.2]
p = qaoa.probs(E, g, b)
out = ROOT / "tests" / "fixtures" / "qaoa_case.json"
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps(dict(E=E.tolist(), gammas=g, betas=b, probs=p.tolist(), p_on=(p @ ALL_PLANS).tolist())))
print("wrote", out)

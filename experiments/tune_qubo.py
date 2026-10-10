"""Tune the QUBO's PENALTY and MARGIN once, on the benchmark day only, then freeze them in
engine/qubo.py. Score = mean over 24 hours of P(QAOA p=1 samples one of the 5 truly cheapest
feasible plans). The solar day is never used here, so it stays an out-of-sample check."""
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import qaoa, qubo  # noqa: E402
from engine.data import build_day  # noqa: E402
from engine.dispatch import cheapest, day_tables  # noqa: E402


def score(day, tab, penalty, margin, top=5):
    pt, feas = [], []
    for t in range(24):
        E = qubo.energies(qubo.build(day["net"][t], day["reserve"][t], penalty, margin))
        best = cheapest(tab[t], top)
        tr = qaoa.train(E, p=1)
        pr = qaoa.probs(E, tr["gammas"], tr["betas"])
        pt.append(pr[best].sum())
        feas.append(pr[np.isfinite(tab[t])].sum())
    return float(np.mean(pt)), float(np.mean(feas))


if __name__ == "__main__":
    day = build_day("benchmark")
    tab = day_tables(day)
    rows = []
    for margin in (0, 20, 40, 60, 90):
        for penalty in (2, 4, 6, 10, 16, 25):
            s, f = score(day, tab, penalty, margin)
            rows.append(dict(margin=margin, penalty=penalty, p_top5=round(s, 4), p_feasible=round(f, 3)))
            print(rows[-1], flush=True)
    best = max(rows, key=lambda r: r["p_top5"])
    print("best", best, "random baseline p_top5 =", 5 / 1024)
    out = Path(__file__).resolve().parents[1] / "results" / "tune_qubo.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(dict(rows=rows, best=best, random_p_top5=5 / 1024), indent=1))

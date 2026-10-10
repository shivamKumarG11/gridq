"""Functions main.js calls through `.callPromisingKwargs`. Each returns a JSON string, so the page
gets plain data and never has to unwrap Python proxies."""
import json

import numpy as np

from . import pipeline, qaoa, qubo
from .data import PUBLISHED_BEST, SCENARIOS, UNITS, build_day

PRECOMPUTED = "results/precomputed.json"  # literal path: Qollab only loads files named in code


def _load_precomputed():
    try:
        with open(PRECOMPUTED) as f:
            return json.load(f)
    except OSError:
        return None


_PRE = None


def _pre():
    global _PRE
    if _PRE is None:
        _PRE = _load_precomputed() or {}
    return _PRE


def init(backend=None):
    return json.dumps(dict(units=UNITS, scenarios=SCENARIOS, published_best=PUBLISHED_BEST,
                           precomputed=_pre(), backend=pipeline.backend_name(backend) if backend is not None else None,
                           ionq=pipeline.is_ionq(backend)))


def _exact_for(scenario, demand_shift, solar_peak, day):
    """Exact optimum: shipped for the two standard days, solved live (if SciPy's MILP is available
    in this runtime) when the sliders change the day."""
    default = SCENARIOS[scenario]["solar_peak"]
    pre = _pre().get("scenarios", {}).get(scenario)
    if pre and abs(demand_shift) < 1e-9 and (solar_peak is None or abs(solar_peak - default) < 1e-9):
        return dict(pre["exact"], source="precomputed MILP (HiGHS)")
    try:
        from . import exact
        r = exact.solve(day, time_limit=60.0)
        if r["ok"]:
            return dict(plans=r["plans"], total=r["schedule"]["total"], lower_bound=r["lower_bound"],
                        status=r["status"], segments=r["segments"], source="MILP solved live (HiGHS)")
        return dict(error=r["message"])
    except Exception as e:  # e.g. SciPy unavailable
        return dict(error=f"exact solver unavailable here: {e}")


def run(backend=None, scenario="benchmark", demand_shift=0.0, solar_peak=-1.0, p=1, shots=512, budget=64,
        seed=7, use_backend=True):
    """Run the whole day. solar_peak < 0 means the scenario's default."""
    sp = None if solar_peak is None or float(solar_peak) < 0 else float(solar_peak)
    day = build_day(scenario, float(demand_shift), sp)
    be = backend if use_backend else None
    res = pipeline.run_day(day, backend=be, p=int(p), shots=int(shots), budget=int(budget), seed=int(seed),
                           log=lambda m: print("[gridq]", m))
    from .schedule import evaluate
    ex = _exact_for(scenario, float(demand_shift), sp, day)
    if "plans" in ex:
        res["schedules"]["exact"] = dict(evaluate(ex["plans"], day), plans=ex["plans"], repairs=0,
                                         lower_bound=ex.get("lower_bound"), source=ex["source"])
    else:
        res["exact_error"] = ex.get("error")
    # Ising weights per hour, for the Quantum Lab's Hamiltonian view
    for t, h in enumerate(res["hours"]):
        q = qubo.build(day["net"][t], day["reserve"][t])
        hz, J, _ = qubo.ising(q)
        h["ising_h"] = [round(float(x), 5) for x in hz]
        h["ising_J"] = [[round(float(x), 5) for x in row] for row in J]
        h["lin"] = [round(float(x), 5) for x in q["lin"]]
    res["day"] = day
    res["scenario"] = scenario
    return json.dumps(res)


def measure_one(backend=None, demand=1400.0, reserve=140.0, gammas=None, betas=None, use_backend=True):
    """One real shot of one hour's QAOA circuit on the chosen backend."""
    q = qubo.build(float(demand), float(reserve))
    h, J, _ = qubo.ising(q)
    g = [float(x) for x in (gammas or [0.5])]
    b = [float(x) for x in (betas or [0.4])]
    qc = qaoa.circuit(h, J, g, b)
    if backend is None or not use_backend:
        p = qaoa.probs(qubo.energies(q), g, b)
        plan = int(np.random.default_rng().choice(len(p), p=p / p.sum()))
        return json.dumps(dict(plan=plan, source="ideal statevector"))
    counts = pipeline._run_counts(backend, qc, 1)
    plan = next(iter(qaoa.counts_to_plans(counts)))
    return json.dumps(dict(plan=plan, source=pipeline.backend_name(backend)))

"""Heavy experiments, run locally (CPython + Qiskit Aer), saved to results/precomputed.json, which the
app ships and loads. Everything here is reproducible: python experiments/precompute.py

E0 exact MILP for both scenarios     E1 race: best day cost vs evaluation budget, 5 seeds
E2 depth p = 1..3 and parameter transfer vs per-hour training      E3 noise: ideal vs IonQ-like models
"""
import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from engine import exact, methods, pipeline, qaoa  # noqa: E402
from engine.data import PUBLISHED_BEST, SCENARIOS, build_day  # noqa: E402
from engine.dispatch import cheapest, day_tables  # noqa: E402
from engine.schedule import evaluate, priority_list  # noqa: E402

BUDGETS = [8, 16, 32, 64, 128, 256]
SEEDS = range(5)
TOP = 5


def race(day, tables, problems):
    out = {}
    angles = {p: pipeline.train_angles(problems, day, p, transfer=True) for p in (1, 2)}
    for budget in BUDGETS:
        row = {}
        for name in ("qaoa_p1", "qaoa_p2", "annealing", "random"):
            totals = []
            for seed in SEEDS:
                rng = np.random.default_rng(1000 + seed)
                if name.startswith("qaoa"):
                    p = int(name[-1])
                    ang, info = angles[p]
                    charge = info["per_hour_charge"]
                    orders = [methods.sample_order(qaoa.probs(pb["E"], a["gammas"], a["betas"]), 4 * budget + 64, rng) for pb, a in zip(problems, ang)]
                    scorers = [methods.from_samples(o, tables[t], budget, charge) for t, o in enumerate(orders)]
                elif name == "annealing":
                    scorers = [methods.annealing(tables[t], methods.violation(day["net"][t], day["reserve"][t]), budget, rng) for t in range(24)]
                else:
                    scorers = [methods.random_search(tables[t], budget, rng) for t in range(24)]
                sch = pipeline.schedules(tables, day, {name: scorers})[name]
                totals.append(sch["total"] if sch and sch["feasible"] else None)
            ok = [x for x in totals if x is not None]
            row[name] = dict(mean=round(float(np.mean(ok)), 2) if ok else None, best=min(ok) if ok else None,
                             worst=max(ok) if ok else None, feasible_runs=len(ok), runs=len(totals))
        out[budget] = row
        print("  budget", budget, {k: v["mean"] for k, v in row.items()}, flush=True)
    return out, {p: angles[p][1] for p in angles}


def sampling_quality(tables, problems, angs):
    """Per hour: P(one of the TOP truly cheapest plans), P(feasible) under the exact QAOA state."""
    pt, pf = [], []
    for t, (pb, a) in enumerate(zip(problems, angs)):
        pr = qaoa.probs(pb["E"], a["gammas"], a["betas"])
        best = cheapest(tables[t], TOP)
        pt.append(float(pr[best].sum()))
        pf.append(float(pr[np.isfinite(tables[t])].sum()))
    return dict(p_top=round(float(np.mean(pt)), 4), p_feasible=round(float(np.mean(pf)), 4),
                per_hour_p_top=[round(x, 4) for x in pt])


def depth_study(day, tables, problems):
    res = {}
    for p in (1, 2, 3):
        for transfer in (True, False):
            ang, info = pipeline.train_angles(problems, day, p, transfer)
            q = sampling_quality(tables, problems, ang)
            res[f"p{p}_{'transfer' if transfer else 'per_hour'}"] = dict(q, training_calls=info["calls"])
            print("  depth", p, "transfer" if transfer else "per-hour", q["p_top"], q["p_feasible"], info["calls"], flush=True)
    fe = [float(np.isfinite(tables[t]).mean()) for t in range(24)]
    res["random"] = dict(p_top=round(float(np.mean([len(cheapest(tables[t], TOP)) / 1024 for t in range(24)])), 5), p_feasible=round(float(np.mean(fe)), 4))
    return res


def noise_study(day, tables, problems):
    """Aer depolarizing + readout models built from IonQ's published fidelities. Not IonQ's own
    simulator: that one runs live on Qollab when you pick an IonQ backend."""
    from qiskit import transpile
    from qiskit_aer import AerSimulator
    from qiskit_aer.noise import NoiseModel, ReadoutError, depolarizing_error

    def model(e1, e2, ro):
        nm = NoiseModel()
        nm.add_all_qubit_quantum_error(depolarizing_error(e1, 1), ["rz", "rx", "h", "sx", "x"])
        nm.add_all_qubit_quantum_error(depolarizing_error(e2, 2), ["rzz"])
        nm.add_all_qubit_readout_error(ReadoutError([[1 - ro, ro], [ro, 1 - ro]]))
        return nm

    models = {
        "ideal": None,
        # Forte: native ZZ gate, 2q fidelity ~99.6%; Aria: MS-based, an RZZ costs ~2 MS at ~99.4%
        "forte_like": model(0.0002, 0.004, 0.005),
        "aria_like": model(0.0005, 0.012, 0.006),
    }
    ang, _ = pipeline.train_angles(problems, day, 1, transfer=True)  # the depth the app runs by default
    hours = [6, int(np.argmax(day["net"])), 19]  # morning ramp, peak, evening peak
    out = {}
    for name, nm in models.items():
        sim = AerSimulator(noise_model=nm, seed_simulator=11)
        rows = []
        for t in hours:
            qc = qaoa.circuit(problems[t]["h"], problems[t]["J"], ang[t]["gammas"], ang[t]["betas"])
            counts = sim.run(transpile(qc, sim), shots=4000).result().get_counts()
            pc = qaoa.counts_to_plans(counts)
            n = sum(pc.values())
            tc = tables[t]
            best = set(cheapest(tc, TOP).tolist())
            feas = sum(c for p, c in pc.items() if np.isfinite(tc[p])) / n
            rows.append(dict(hour=t + 1, p_top=round(sum(c for p, c in pc.items() if p in best) / n, 4), p_feasible=round(feas, 4)))
        out[name] = rows
        print("  noise", name, rows, flush=True)
    out["random"] = [dict(hour=t + 1, p_top=round(len(cheapest(tables[t], TOP)) / 1024, 5), p_feasible=round(float(np.isfinite(tables[t]).mean()), 4)) for t in hours]
    return out


def main():
    t0 = time.time()
    res = dict(generated=time.strftime("%Y-%m-%d %H:%M"), published_best=PUBLISHED_BEST, budgets=BUDGETS,
               seeds=len(SEEDS), top=TOP, scenarios={})
    for key in SCENARIOS:
        print("scenario", key, flush=True)
        day = build_day(key)
        tables = day_tables(day)
        problems = pipeline.hour_problems(day)
        ex = exact.solve(day)
        print("  exact", ex["schedule"]["total"], ex["lower_bound"], flush=True)
        pl = priority_list(tables)
        sc = dict(day=day, exact=dict(plans=ex["plans"], total=ex["schedule"]["total"], lower_bound=ex["lower_bound"],
                                      status=ex["status"], segments=ex["segments"]),
                  priority=dict(plans=pl["plans"], total=evaluate(pl["plans"], day)["total"]))
        sc["race"], _ = race(day, tables, problems)
        sc["depth"] = depth_study(day, tables, problems)
        if key == "benchmark":
            sc["noise"] = noise_study(day, tables, problems)
        res["scenarios"][key] = sc
    res["seconds"] = round(time.time() - t0, 1)
    out = ROOT / "results" / "precomputed.json"
    out.write_text(json.dumps(res, separators=(",", ":")))
    print("wrote", out, out.stat().st_size, "bytes in", res["seconds"], "s")


if __name__ == "__main__":
    main()

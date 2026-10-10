"""One full day: QUBO per hour -> QAOA (trained once, angles transferred) -> samples from `backend`
-> true-cost scoring -> day stitching. Annealing and random search run under the same budget and the
same stitcher; the priority list and the exact MILP are the reference points."""
import math
import time

import numpy as np

from . import methods, qaoa, qubo
from .dispatch import INFEASIBLE, day_tables, label
from .schedule import evaluate, priority_list, stitch

IONQ_PACK_HOURS = 2  # IonQ: one job per run, no lists of circuits -> 2 hours x 10 qubits side by side


def backend_name(backend):
    if backend is None:
        return "ideal (numpy statevector)"
    name = getattr(backend, "name", None)
    return name if isinstance(name, str) and name else str(backend)


def is_ionq(backend):
    return backend is not None and "ionq" in (backend_name(backend) + str(backend)).lower()


def hour_problems(day):
    out = []
    for t in range(len(day["net"])):
        q = qubo.build(day["net"][t], day["reserve"][t])
        h, J, _ = qubo.ising(q)
        out.append(dict(q=q, E=qubo.energies(q), h=h, J=J))
    return out


def train_angles(problems, day, p, transfer=True, cvar=1.0):
    """Parameter transfer: train on the peak hour only and reuse the angles all day."""
    if transfer:
        t_train = int(np.argmax(day["net"]))
        tr = qaoa.train(problems[t_train]["E"], p=p, cvar=cvar)
        return [tr] * len(problems), dict(hour=t_train + 1, calls=tr["calls"], per_hour_charge=math.ceil(tr["calls"] / len(problems)))
    trs = [qaoa.train(pb["E"], p=p, cvar=cvar) for pb in problems]
    return trs, dict(hour=None, calls=sum(t["calls"] for t in trs), per_hour_charge=None)


def _run_counts(backend, qc, shots):
    from qiskit import transpile

    try:  # skip transpiling when the backend runs every gate natively (the built-in simulator does)
        native = set(qc.count_ops()) <= set(backend.target.operation_names)
    except Exception:
        native = False
    job = backend.run(qc if native else transpile(qc, backend), shots=int(shots))
    return job.result().get_counts()


def sample_day(problems, angles, backend, shots, rng, log):
    """Returns per-hour measurement orders and a note on where each hour's shots came from."""
    T = len(problems)
    orders, source = [None] * T, ["ideal statevector sampling"] * T
    if backend is None:
        for t in range(T):
            orders[t] = methods.sample_order(qaoa.probs(problems[t]["E"], angles[t]["gammas"], angles[t]["betas"]), shots, rng)
        return orders, source
    if is_ionq(backend):
        from qiskit import QuantumCircuit

        hours = sorted(np.argsort([-pb["q"]["target"] for pb in problems])[:IONQ_PACK_HOURS])
        wide = QuantumCircuit(10 * len(hours), 10 * len(hours))
        for k, t in enumerate(hours):
            c = qaoa.circuit(problems[t]["h"], problems[t]["J"], angles[t]["gammas"], angles[t]["betas"])
            wide.compose(c, qubits=range(10 * k, 10 * k + 10), clbits=range(10 * k, 10 * k + 10), inplace=True)
        log(f"IonQ backend: one packed {wide.num_qubits}-qubit job for hours {[t + 1 for t in hours]}")
        counts = _run_counts(backend, wide, shots)
        for k, t in enumerate(hours):
            orders[t] = methods.counts_order(qaoa.counts_to_plans(counts, offset=10 * k), rng)
            source[t] = backend_name(backend)
        for t in range(T):
            if orders[t] is None:
                orders[t] = methods.sample_order(qaoa.probs(problems[t]["E"], angles[t]["gammas"], angles[t]["betas"]), shots, rng)
        return orders, source
    for t in range(T):
        qc = qaoa.circuit(problems[t]["h"], problems[t]["J"], angles[t]["gammas"], angles[t]["betas"])
        orders[t] = methods.counts_order(qaoa.counts_to_plans(_run_counts(backend, qc, shots)), rng)
        source[t] = backend_name(backend)
        if t % 6 == 5:
            log(f"sampled hour {t + 1}/24 on {backend_name(backend)}")
    return orders, source


def propose(tables, day, problems, orders, charge, budget, rng):
    """Run the three proposal methods for every hour. Returns {method: [Scorer per hour]}."""
    out = {"qaoa": [], "annealing": [], "random": []}
    for t in range(len(tables)):
        viol = methods.violation(day["net"][t], day["reserve"][t])
        out["qaoa"].append(methods.from_samples(orders[t], tables[t], budget, charge))
        out["annealing"].append(methods.annealing(tables[t], viol, budget, rng))
        out["random"].append(methods.random_search(tables[t], budget, rng))
    return out


def schedules(tables, day, scorers):
    res = {}
    for name, per_hour in scorers.items():
        cands = []
        for t, s in enumerate(per_hour):
            viol = methods.violation(day["net"][t], day["reserve"][t])
            cands.append(s.candidates(viol))
        st = stitch(cands, tables)
        res[name] = None if st is None else dict(evaluate(st["plans"], day), repairs=st["repairs"], plans=st["plans"], fallback=st["fallback"])
    return res


def run_day(day, backend=None, p=2, shots=256, budget=32, seed=7, transfer=True, log=print):
    t0 = time.time()
    rng = np.random.default_rng(seed)
    tables = day_tables(day)
    problems = hour_problems(day)
    angles, train_info = train_angles(problems, day, p, transfer)
    log(f"QAOA p={p} trained on hour {train_info['hour']} with {train_info['calls']} circuit evaluations")
    orders, source = sample_day(problems, angles, backend, shots, rng, log)
    charge = train_info["per_hour_charge"] or math.ceil(train_info["calls"] / len(tables))
    scorers = propose(tables, day, problems, orders, charge, budget, rng)
    scheds = schedules(tables, day, scorers)
    pl = priority_list(tables)
    scheds["priority"] = dict(evaluate(pl["plans"], day), repairs=pl["repairs"], plans=pl["plans"])

    hours = []
    for t in range(len(tables)):
        tc = tables[t]
        finite = np.isfinite(tc)
        best = int(np.argmin(np.where(finite, tc, np.inf)))
        sampled = {}
        for x in orders[t]:
            sampled[int(x)] = sampled.get(int(x), 0) + 1
        top = sorted(sampled.items(), key=lambda kv: -kv[1])[:12]
        hours.append(dict(
            E=[round(float(e), 5) for e in problems[t]["E"]],
            cost=[round(float(c), 1) if c < INFEASIBLE else None for c in tc],
            best_plan=best, best_cost=round(float(tc[best]), 2),
            target=round(problems[t]["q"]["target"], 1),
            gammas=angles[t]["gammas"], betas=angles[t]["betas"],
            shots=len(orders[t]), source=source[t],
            p_best_measured=round(sampled.get(best, 0) / max(1, len(orders[t])), 4),
            top_samples=[dict(plan=pl_, label=label(pl_), count=c, cost=(round(float(tc[pl_]), 1) if tc[pl_] < INFEASIBLE else None)) for pl_, c in top],
            traces={k: [None if v >= INFEASIBLE else round(v, 1) for v in scorers[k][t].trace] for k in scorers},
        ))
    peak = int(np.argmax(day["net"]))
    try:
        circ_text = str(qaoa.circuit(problems[peak]["h"], problems[peak]["J"], angles[peak]["gammas"], angles[peak]["betas"]).draw(output="text", fold=-1))
    except Exception as e:  # drawing is cosmetic
        circ_text = f"(circuit drawing unavailable: {e})"
    return dict(
        params=dict(p=p, shots=shots, budget=budget, seed=seed, transfer=transfer, backend=backend_name(backend)),
        training=train_info, schedules=scheds, hours=hours, circuit_text=circ_text, circuit_hour=peak + 1,
        circuit_stats=_circuit_stats(problems[peak], angles[peak]), seconds=round(time.time() - t0, 2),
    )


def _circuit_stats(pb, ang):
    qc = qaoa.circuit(pb["h"], pb["J"], ang["gammas"], ang["betas"])
    ops = {k: int(v) for k, v in qc.count_ops().items()}
    return dict(qubits=qc.num_qubits, depth=qc.depth(), ops=ops, two_qubit=ops.get("rzz", 0))

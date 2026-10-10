"""Linking the hours: start-up costs, minimum up/down times, day stitching, schedule scoring.

Every method (QAOA, annealing, random search) only proposes candidate plans per hour. The same
stitcher turns those candidates into a full 24-hour schedule, so the methods are compared on the
quality of what they propose, never on different post-processing.
"""
import numpy as np

from .data import UNITS, N_UNITS
from .dispatch import INFEASIBLE, PMAX, dispatch, bits

T_UP = np.array([u["t_up"] for u in UNITS])
T_DOWN = np.array([u["t_down"] for u in UNITS])
HOT = np.array([u["hot_cost"] for u in UNITS], dtype=float)
COLD = np.array([u["cold_cost"] for u in UNITS], dtype=float)
COLD_AFTER = np.array([u["t_down"] + u["cold_hrs"] for u in UNITS])  # off longer than this = cold start
INIT = np.array([u["init_status"] for u in UNITS])
# full-load average cost $/MWh, the classic priority-list order
_FULL = np.array([(u["a"] + u["b"] * u["p_max"] + u["c"] * u["p_max"] ** 2) / u["p_max"] for u in UNITS])
PRIORITY = [int(i) for i in np.argsort(_FULL)]


def _clip_dur(dur):
    """Durations beyond what any rule looks at are equivalent; clipping them merges beam states."""
    return tuple(int(min(d, T_UP[i])) if d > 0 else int(max(d, -(COLD_AFTER[i] + 1))) for i, d in enumerate(dur))


def _must(dur):
    on = np.array([0 < d < T_UP[i] for i, d in enumerate(dur)])
    off = np.array([0 > d > -T_DOWN[i] for i, d in enumerate(dur)])
    return on, off


def _startup(dur, new_bits):
    cost = 0.0
    for i, d in enumerate(dur):
        if new_bits[i] and d < 0:
            cost += HOT[i] if -d <= COLD_AFTER[i] else COLD[i]
    return cost


def _advance(dur, new_bits):
    return tuple((d + 1 if d > 0 else 1) if b else (d - 1 if d < 0 else -1) for d, b in zip(dur, new_bits))


def repair(plan, must_on, must_off, table_t):
    """Make a proposed plan respect min up/down, then add the cheapest allowed units until it is
    feasible (or remove the most expensive ones if minimum outputs exceed demand)."""
    b = np.array(bits(plan), dtype=bool)
    b = (b | must_on) & ~must_off
    p = int(sum(1 << i for i in range(N_UNITS) if b[i]))
    for i in PRIORITY:  # cheapest first
        if table_t[p] < INFEASIBLE:
            return p, True
        if not b[i] and not must_off[i]:
            b[i] = True
            p |= 1 << i
    for i in reversed(PRIORITY):  # still infeasible: too much minimum output
        if table_t[p] < INFEASIBLE:
            break
        if b[i] and not must_on[i]:
            b[i] = False
            p &= ~(1 << i)
    return p, table_t[p] < INFEASIBLE


def stitch(candidates, tables, beam=96):
    """Beam search over the day. candidates: list of 24 lists of plan ints (best first).
    Returns the cheapest feasible schedule found. If the beam pruned every feasible path (it can, at
    a peak that needs nearly every plant while one is locked out by its minimum down time), retry
    once with "all plants on" added each hour (always feasible) and a wider beam; `fallback` says so."""
    res = _stitch(candidates, tables, beam)
    if res is not None:
        return dict(res, fallback=False)
    full = (1 << N_UNITS) - 1
    res = _stitch([list(c) + [full] for c in candidates], tables, beam * 4)
    return None if res is None else dict(res, fallback=True)


def _stitch(candidates, tables, beam):
    states = {_clip_dur(INIT): (0.0, [], 0)}  # clipped durations -> (cost, plans, repairs)
    raw = {_clip_dur(INIT): tuple(INIT)}
    for t in range(len(tables)):
        nxt, nraw = {}, {}
        for key, (cost, plans, nrep) in states.items():
            dur = raw[key]
            must_on, must_off = _must(dur)
            prev = plans[-1] if plans else sum(1 << i for i, d in enumerate(dur) if d > 0)
            tried = set()
            # each candidate as proposed, and with the previous hour's plants held on (avoids paying a
            # restart, or being locked out by a minimum down time, a few hours later)
            for c in [x for c0 in candidates[t] for x in (c0, c0 | prev)]:
                p, ok = repair(c, must_on, must_off, tables[t])
                if not ok or p in tried:
                    continue
                tried.add(p)
                nb = bits(p)
                total = cost + tables[t][p] + _startup(dur, nb)
                ndur = _advance(dur, nb)
                k = (p, _clip_dur(ndur))
                if k not in nxt or total < nxt[k][0]:
                    nxt[k] = (total, plans + [p], nrep + (p != c))
                    nraw[k] = ndur
        if not nxt:
            return None
        best = sorted(nxt.items(), key=lambda kv: kv[1][0])[:beam]
        states = {k: v for k, v in best}
        raw = {k: nraw[k] for k, _ in best}
    cost, plans, nrep = min(states.values(), key=lambda v: v[0])
    return dict(plans=plans, repairs=nrep)


def evaluate(plans, day):
    """Score a full schedule exactly and check every constraint. Returns a JSON-friendly dict."""
    dur = tuple(INIT)
    fuel_total, start_total, violations = 0.0, 0.0, []
    hours = []
    for t, p in enumerate(plans):
        nb = bits(p)
        must_on, must_off = _must(dur)
        for i in range(N_UNITS):
            if must_on[i] and not nb[i]:
                violations.append(f"h{t + 1}: G{i + 1} switched off before its minimum up time")
            if must_off[i] and nb[i]:
                violations.append(f"h{t + 1}: G{i + 1} restarted before its minimum down time")
        P, fuel, ok = dispatch([nb], day["net"][t])
        cap = float((PMAX * np.array(nb)).sum())
        if not ok[0]:
            violations.append(f"h{t + 1}: committed units cannot meet demand exactly")
        if cap < day["net"][t] + day["reserve"][t] - 1e-6:
            violations.append(f"h{t + 1}: capacity {cap:.0f} MW below demand + reserve")
        su = _startup(dur, nb)
        started = [i + 1 for i in range(N_UNITS) if nb[i] and dur[i] < 0]
        fuel_total += float(fuel[0])
        start_total += su
        hours.append(dict(plan=int(p), output=[round(float(x), 1) for x in P[0]], fuel=round(float(fuel[0]), 2),
                          startup=su, capacity=cap, started=started))
        dur = _advance(dur, nb)
    return dict(total=round(fuel_total + start_total, 2), fuel=round(fuel_total, 2), startup=round(start_total, 2),
                feasible=not violations, violations=violations[:10], hours=hours)


def priority_list(tables):
    """Classic utility heuristic: each hour, commit units in full-load-cost order until feasible,
    then let the stitcher enforce min up/down."""
    cands = []
    for t in range(len(tables)):
        p = 0
        for i in PRIORITY:
            if tables[t][p] < INFEASIBLE:
                break
            p |= 1 << i
        cands.append([p])
    return stitch(cands, tables)

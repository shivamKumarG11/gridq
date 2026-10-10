"""Exact baseline: the full, linked 24-hour unit commitment as a MILP (HiGHS via scipy.optimize.milp).

Quadratic fuel curves are replaced by K-segment secants (convex, so no extra binaries). Secants lie
above the curve, so the MILP optimum is an upper bound on the true optimum and
`MILP optimum - max secant error summed over all unit-hours` is a lower bound. The returned
schedule is re-scored with exact quadratic dispatch.
"""
import numpy as np

from .data import UNITS, N_UNITS
from .schedule import COLD, COLD_AFTER, HOT, INIT, T_DOWN, T_UP, evaluate

SEGMENTS = 20


def solve(day, segments=SEGMENTS, time_limit=120.0):
    from scipy.optimize import Bounds, LinearConstraint, milp
    from scipy.sparse import lil_array

    I, T, K = N_UNITS, len(day["net"]), segments
    pmin = np.array([u["p_min"] for u in UNITS], float)
    pmax = np.array([u["p_max"] for u in UNITS], float)
    a = np.array([u["a"] for u in UNITS], float)
    b = np.array([u["b"] for u in UNITS], float)
    c = np.array([u["c"] for u in UNITS], float)
    seg = (pmax - pmin) / K
    f = lambda i, p: a[i] + b[i] * p + c[i] * p * p
    slope = np.array([[(f(i, pmin[i] + (k + 1) * seg[i]) - f(i, pmin[i] + k * seg[i])) / seg[i] for k in range(K)] for i in range(I)])
    max_err = c * seg ** 2 / 4  # secant vs parabola, worst point of a segment

    # variable layout: u, v (start), w (stop), s (start-up $), d (segment MW)
    nU = I * T
    U = lambda i, t: i * T + t
    V = lambda i, t: nU + i * T + t
    W = lambda i, t: 2 * nU + i * T + t
    S = lambda i, t: 3 * nU + i * T + t
    D = lambda i, t, k: 4 * nU + (i * T + t) * K + k
    n = 4 * nU + nU * K

    cost = np.zeros(n)
    integ = np.zeros(n)
    lb, ub = np.zeros(n), np.full(n, np.inf)
    for i in range(I):
        for t in range(T):
            cost[U(i, t)] = f(i, pmin[i])
            cost[S(i, t)] = 1.0
            for x in (U(i, t), V(i, t), W(i, t)):
                integ[x], ub[x] = 1, 1
            for k in range(K):
                cost[D(i, t, k)] = slope[i, k]
                ub[D(i, t, k)] = seg[i]

    # history: u_tau for tau <= 0 (hour 0 = last hour before the day)
    def hist(i, tau):
        s0 = INIT[i]
        return 1 if (s0 > 0) else (0 if tau > s0 else 1)

    rows, lo, hi = [], [], []
    A = lil_array((I * T * (6 + K) + 2 * T, n))
    r = 0

    def add(coefs, l, h):
        nonlocal r
        for j, v in coefs:
            A[r, j] = A[r, j] + v
        lo.append(l), hi.append(h)
        r += 1

    for t in range(T):
        # balance and reserve
        add([(U(i, t), pmin[i]) for i in range(I)] + [(D(i, t, k), 1.0) for i in range(I) for k in range(K)],
            day["net"][t], day["net"][t])
        add([(U(i, t), pmax[i]) for i in range(I)], day["net"][t] + day["reserve"][t], np.inf)
    for i in range(I):
        for t in range(T):
            for k in range(K):  # segment only usable when on
                add([(D(i, t, k), 1.0), (U(i, t), -seg[i])], -np.inf, 0)
            # u_t - u_{t-1} = v_t - w_t
            if t == 0:
                add([(U(i, t), 1), (V(i, t), -1), (W(i, t), 1)], hist(i, 0), hist(i, 0))
            else:
                add([(U(i, t), 1), (U(i, t - 1), -1), (V(i, t), -1), (W(i, t), 1)], 0, 0)
            # min up / min down (windows reaching into the history use its known starts/stops)
            add([(V(i, k), 1) for k in range(max(0, t - T_UP[i] + 1), t + 1)] + [(U(i, t), -1)], -np.inf, 0)
            add([(W(i, k), 1) for k in range(max(0, t - T_DOWN[i] + 1), t + 1)] + [(U(i, t), 1)], -np.inf, 1)
            # start-up cost: hot always, cold if off for more than COLD_AFTER hours
            add([(S(i, t), 1), (V(i, t), -HOT[i])], 0, np.inf)
            terms, known = [(S(i, t), 1), (V(i, t), -COLD[i])], 0.0
            for kk in range(1, COLD_AFTER[i] + 2):
                tau = t - kk
                if tau >= 0:
                    terms.append((U(i, tau), COLD[i]))
                else:
                    known += COLD[i] * hist(i, tau + 1)
            add(terms, -known, np.inf)
        # initial must-on / must-off from the history
        s0 = INIT[i]
        if 0 < s0 < T_UP[i]:
            for t in range(T_UP[i] - s0):
                lb[U(i, t)] = 1
        if 0 > s0 > -T_DOWN[i]:
            for t in range(T_DOWN[i] + s0):
                ub[U(i, t)] = 0

    A = A[:r].tocsr()
    res = milp(cost, integrality=integ, bounds=Bounds(lb, ub), constraints=LinearConstraint(A, lo, hi),
               options=dict(time_limit=time_limit, mip_rel_gap=0.0, disp=False))
    if res.x is None:
        return dict(ok=False, message=str(res.message))
    x = res.x
    plans = [int(sum((1 << i) for i in range(I) if x[U(i, t)] > 0.5)) for t in range(T)]
    ev = evaluate(plans, day)
    on_hours = sum(1 for i in range(I) for t in range(T) if x[U(i, t)] > 0.5)
    err = float(sum(max_err[i] for i in range(I) for t in range(T) if x[U(i, t)] > 0.5))
    dual = float(getattr(res, "mip_dual_bound", res.fun) or res.fun)
    lower = dual - float(max_err.sum() * T)
    return dict(ok=True, plans=plans, schedule=ev, milp_objective=round(float(res.fun), 2),
                lower_bound=round(lower, 2), secant_error_max=round(err, 2), status=str(res.message),
                segments=K, on_hours=on_hours)

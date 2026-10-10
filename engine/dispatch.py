"""Economic dispatch: the exact fuel cost of an on/off plan for one hour.

A plan is an integer 0..1023; bit i is unit i+1 (G1 = bit 0). For a fixed plan, the cheapest way to
meet demand with quadratic fuel costs is the equal-incremental-cost rule (lambda iteration):
P_i = clip((lambda - b_i) / (2 c_i), Pmin_i, Pmax_i), with lambda found by bisection.
"""
import numpy as np

from .data import UNITS, N_UNITS

PMIN = np.array([u["p_min"] for u in UNITS], dtype=float)
PMAX = np.array([u["p_max"] for u in UNITS], dtype=float)
A = np.array([u["a"] for u in UNITS], dtype=float)
B = np.array([u["b"] for u in UNITS], dtype=float)
C = np.array([u["c"] for u in UNITS], dtype=float)
N_PLANS = 1 << N_UNITS
ALL_PLANS = ((np.arange(N_PLANS)[:, None] >> np.arange(N_UNITS)) & 1).astype(float)  # (1024, 10)
INFEASIBLE = float("inf")


def bits(plan):
    """Plan integer -> list of 0/1 per unit (G1 first)."""
    return [(int(plan) >> i) & 1 for i in range(N_UNITS)]


def plan_of(bit_list):
    return int(sum(int(b) << i for i, b in enumerate(bit_list)))


def label(plan):
    """'1111111100' style string, G1 first (as in the design boards)."""
    return "".join(str(b) for b in bits(plan))


def dispatch(U, demand, iters=60):
    """Vectorised dispatch. U: (M, 10) 0/1 array. Returns (P (M,10), fuel (M,), ok (M,) bool).

    ok is False when the committed units cannot produce exactly `demand` (sum Pmin > demand or
    sum Pmax < demand). Reserve is checked separately by the caller.
    """
    U = np.atleast_2d(np.asarray(U, dtype=float))
    lo_p, hi_p = U * PMIN, U * PMAX
    ok = (lo_p.sum(1) <= demand + 1e-6) & (hi_p.sum(1) >= demand - 1e-6)
    lam_lo = np.zeros(len(U))
    lam_hi = np.full(len(U), 200.0)
    for _ in range(iters):
        lam = 0.5 * (lam_lo + lam_hi)
        P = np.clip((lam[:, None] - B) / (2 * C), lo_p, hi_p)
        short = P.sum(1) < demand
        lam_lo = np.where(short, lam, lam_lo)
        lam_hi = np.where(short, lam_hi, lam)
    lam = 0.5 * (lam_lo + lam_hi)
    P = np.clip((lam[:, None] - B) / (2 * C), lo_p, hi_p)  # total output is continuous in lambda
    fuel = (U * (A + B * P + C * P * P)).sum(1)
    return P, fuel, ok


def hour_table(demand, reserve):
    """True fuel cost of every plan for one hour; inf where the plan is infeasible
    (cannot meet demand exactly, or committed capacity < demand + reserve)."""
    P, fuel, ok = dispatch(ALL_PLANS, demand)
    cap_ok = (ALL_PLANS * PMAX).sum(1) >= demand + reserve - 1e-6
    return np.where(ok & cap_ok, fuel, INFEASIBLE)


def cheapest(table, k):
    """The k cheapest feasible plans (fewer if fewer are feasible, e.g. at the peak hour)."""
    feas = np.flatnonzero(np.isfinite(table))
    return feas[np.argsort(table[feas])[:k]]


def day_tables(day):
    return np.array([hour_table(d, r) for d, r in zip(day["net"], day["reserve"])])  # (24, 1024)

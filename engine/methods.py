"""Three ways to propose plans for one hour, under the same budget.

Budget = number of distinct plans a method may score with the true cost (dispatch). Revisiting a
plan already scored is free. QAOA's training (circuit evaluations on the QUBO) is charged to its
budget as well, so it never gets free looks at the problem.
"""
import numpy as np

from .dispatch import ALL_PLANS, INFEASIBLE, N_PLANS, PMAX, PMIN
from .data import N_UNITS

TOP_K = 6  # candidates per hour handed to the stitcher, identical for every method


def violation(demand, reserve):
    """How far each plan is from feasible, in MW (0 = feasible capacity-wise)."""
    cap = ALL_PLANS @ PMAX
    floor = ALL_PLANS @ PMIN
    return np.maximum(0, demand + reserve - cap) + np.maximum(0, floor - demand)


class Scorer:
    """Counts true-cost evaluations and records the best feasible cost after each one."""

    def __init__(self, table, budget):
        self.table, self.budget = table, budget
        self.seen = {}
        self.trace = []
        self.best = INFEASIBLE

    def full(self):
        return len(self.seen) >= self.budget

    def score(self, plan):
        plan = int(plan)
        if plan in self.seen:
            return self.seen[plan]
        if self.full():
            return None
        v = float(self.table[plan])
        self.seen[plan] = v
        self.best = min(self.best, v)
        self.trace.append(self.best)
        return v

    def charge(self, n):
        """Spend budget without looking at anything (QAOA training)."""
        for _ in range(int(n)):
            if self.full():
                break
            self.seen[-1 - len(self.seen)] = INFEASIBLE
            self.trace.append(self.best)

    def candidates(self, viol, k=TOP_K):
        plans = [p for p in self.seen if p >= 0]
        plans.sort(key=lambda p: (self.seen[p] >= INFEASIBLE, self.seen[p] if self.seen[p] < INFEASIBLE else viol[p]))
        return plans[:k]


def from_samples(samples, table, budget, charge=0):
    """QAOA: score sampled plans in the order they were measured."""
    s = Scorer(table, budget)
    s.charge(charge)
    for p in samples:
        if s.full():
            break
        s.score(p)
    return s


def random_search(table, budget, rng):
    s = Scorer(table, budget)
    for p in rng.permutation(N_PLANS):
        if s.full():
            break
        s.score(p)
    return s


def annealing(table, viol, budget, rng, t0=0.3, t1=0.003):
    """Simulated annealing on the true cost with single-plant flips. Infeasible plans get the worst
    feasible cost plus a shortfall penalty, so the walk can cross them."""
    s = Scorer(table, budget)
    finite = table[np.isfinite(table)]
    worst = finite.max() if len(finite) else 1e5
    scale = finite.std() if len(finite) > 1 else 1000.0

    def energy(p):
        v = s.score(p)
        if v is None:
            v = s.seen.get(int(p))
        if v is None:
            return None
        return (v if v < INFEASIBLE else worst + 50.0 * viol[p]) / scale

    cur = int(rng.integers(N_PLANS))
    e = energy(cur)
    steps = 0
    while not s.full() and steps < 50 * budget:
        temp = t0 * (t1 / t0) ** (len(s.seen) / max(1, budget))
        nxt = cur ^ (1 << int(rng.integers(N_UNITS)))
        en = energy(nxt)
        steps += 1
        if en is None:
            break
        if en <= e or rng.random() < np.exp(-(en - e) / temp):
            cur, e = nxt, en
    return s


def sample_order(probs, shots, rng):
    """Draw `shots` i.i.d. measurements from an exact distribution (ideal simulator)."""
    p = np.asarray(probs, float)
    return list(rng.choice(N_PLANS, size=shots, p=p / p.sum()))


def counts_order(counts, rng):
    """Turn measured counts into a random measurement order."""
    seq = [p for p, c in counts.items() for _ in range(int(c))]
    return [seq[i] for i in rng.permutation(len(seq))]

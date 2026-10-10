"""Per-hour QUBO: what the circuit sees.

    C(x) = sum_i c_i x_i + lam * (sum_i p_i x_i - 1)^2

x_i = 1 means plant i runs; p_i = Pmax_i / target, target = demand + reserve + MARGIN (a squared
penalty punishes a shortfall and a surplus alike, but only a shortfall is infeasible, so the target
sits a little above the requirement). c_i = what committing plant i adds to the bill: its no-load
cost plus the premium of its minimum output over the system's marginal cost.
The QUBO is only a guide: every plan QAOA proposes is re-scored with the true cost (dispatch).
PENALTY and MARGIN were tuned once on the benchmark day (experiments/tune_qubo.py) and then frozen;
the solar day and the demand slider are out-of-sample.
"""
import numpy as np

from .dispatch import A, B, C, PMAX, PMIN, ALL_PLANS

PENALTY = 6.0
MARGIN = 60.0  # MW
B_REF = 18.0  # $/MWh, a typical system marginal cost for this fleet


def build(demand, reserve, penalty=None, margin=None):
    penalty = PENALTY if penalty is None else penalty
    margin = MARGIN if margin is None else margin
    target = demand + reserve + margin
    run_cost = A + (B - B_REF) * PMIN + C * PMIN ** 2
    lin = run_cost / (A.sum())  # keeps the cost part O(1)
    p = PMAX / target
    n = len(p)
    # expand lam * (sum p x - 1)^2 with x^2 = x
    Q = np.zeros((n, n))
    lin = lin + penalty * (p * p - 2 * p)
    for i in range(n):
        for j in range(i + 1, n):
            Q[i, j] = 2 * penalty * p[i] * p[j]
    const = penalty
    return dict(lin=lin, quad=Q, const=const, target=target)


def energies(q):
    """QUBO value of all 1024 plans (vector, index = plan integer)."""
    X = ALL_PLANS
    return X @ q["lin"] + np.einsum("ki,ij,kj->k", X, q["quad"], X) + q["const"]


def ising(q):
    """x_i = (1 - z_i)/2  ->  C = const + sum h_i z_i + sum_{i<j} J_ij z_i z_j."""
    lin, Q = q["lin"], q["quad"]
    n = len(lin)
    h = -lin / 2.0
    J = np.zeros((n, n))
    const = q["const"] + lin.sum() / 2.0
    for i in range(n):
        for j in range(i + 1, n):
            if Q[i, j]:
                J[i, j] = Q[i, j] / 4.0
                h[i] -= Q[i, j] / 4.0
                h[j] -= Q[i, j] / 4.0
                const += Q[i, j] / 4.0
    return h, J, const

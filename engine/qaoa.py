"""QAOA for one hour's QUBO.

Training uses the exact statevector (10 qubits = 1,024 amplitudes, cheap in numpy, no shots).
Sampling builds the real Qiskit circuit and runs it on the `backend` chosen in Qollab's dialog.
"""
import numpy as np

from .dispatch import N_PLANS
from .data import N_UNITS

GAMMA_MAX, BETA_MAX = 3.0, np.pi / 2


def state(E, gammas, betas):
    """|psi(gamma, beta)> = prod_l e^{-i beta_l B} e^{-i gamma_l C} |+>^n, index = plan integer."""
    n = N_UNITS
    psi = np.full(N_PLANS, 1 / np.sqrt(N_PLANS), dtype=complex)
    for g, b in zip(gammas, betas):
        psi = psi * np.exp(-1j * g * E)
        cb, sb = np.cos(b), -1j * np.sin(b)
        t = psi.reshape([2] * n)
        for ax in range(n):  # RX(2b) = cos b I - i sin b X on every qubit
            t0 = np.take(t, 0, axis=ax)
            t1 = np.take(t, 1, axis=ax)
            t = np.stack([cb * t0 + sb * t1, sb * t0 + cb * t1], axis=ax)
        psi = t.reshape(N_PLANS)
    return psi


def probs(E, gammas, betas):
    return np.abs(state(E, gammas, betas)) ** 2


def expectation(E, gammas, betas, cvar=1.0):
    p = probs(E, gammas, betas)
    if cvar >= 1.0:
        return float(p @ E)
    order = np.argsort(E)  # CVaR: mean energy of the best `cvar` fraction of the distribution
    acc, tot = 0.0, 0.0
    for k in order:
        take = min(p[k], cvar - acc)
        tot += take * E[k]
        acc += take
        if acc >= cvar - 1e-12:
            break
    return tot / cvar


def _nelder_mead(f, x0, step=0.15, iters=120, tol=1e-6):
    n = len(x0)
    pts = [np.array(x0, float)] + [np.array(x0, float) + step * np.eye(n)[i] for i in range(n)]
    vals = [f(p) for p in pts]
    calls = n + 1
    for _ in range(iters):
        order = np.argsort(vals)
        pts, vals = [pts[i] for i in order], [vals[i] for i in order]
        if abs(vals[-1] - vals[0]) < tol:
            break
        cen = np.mean(pts[:-1], axis=0)
        xr = cen + (cen - pts[-1]); fr = f(xr); calls += 1
        if fr < vals[0]:
            xe = cen + 2 * (cen - pts[-1]); fe = f(xe); calls += 1
            pts[-1], vals[-1] = (xe, fe) if fe < fr else (xr, fr)
        elif fr < vals[-2]:
            pts[-1], vals[-1] = xr, fr
        else:
            xc = cen + 0.5 * (pts[-1] - cen); fc = f(xc); calls += 1
            if fc < vals[-1]:
                pts[-1], vals[-1] = xc, fc
            else:
                for i in range(1, n + 1):
                    pts[i] = pts[0] + 0.5 * (pts[i] - pts[0]); vals[i] = f(pts[i]); calls += 1
    i = int(np.argmin(vals))
    return pts[i], vals[i], calls


def landscape(E, n=20):
    """Exact p=1 expectation on an n x n grid of (gamma, beta). Rows = beta, columns = gamma."""
    gs = np.linspace(0, GAMMA_MAX, n)
    bs = np.linspace(0, BETA_MAX, n)
    return gs, bs, np.array([[expectation(E, [g], [b]) for g in gs] for b in bs])


def train(E, p=1, cvar=1.0, grid=12):
    """p=1: coarse grid, then Nelder-Mead. p>1: layer-by-layer INTERP warm start.
    Returns angles and the number of objective (circuit) evaluations used."""
    calls = 0
    best = None
    for g in np.linspace(0.1, GAMMA_MAX, grid):
        for b in np.linspace(0.05, BETA_MAX - 0.05, grid // 2):
            v = expectation(E, [g], [b], cvar)
            calls += 1
            if best is None or v < best[0]:
                best = (v, [g], [b])
    _, gam, bet = best
    for depth in range(1, p + 1):
        if depth > 1:  # INTERP (Zhou et al. 2020): stretch the depth-1 schedule to the new depth
            xs = np.linspace(0, 1, depth)
            old = np.linspace(0, 1, depth - 1)
            gam = list(np.interp(xs, old, gam))
            bet = list(np.interp(xs, old, bet))
        x, val, c = _nelder_mead(lambda x: expectation(E, x[:depth], x[depth:], cvar), list(gam) + list(bet))
        calls += c
        gam, bet = list(x[:depth]), list(x[depth:])
    return dict(gammas=[float(g) for g in gam], betas=[float(b) for b in bet], value=float(val), calls=calls)


def circuit(h, J, gammas, betas, measure=True):
    from qiskit import QuantumCircuit

    n = len(h)
    qc = QuantumCircuit(n, n if measure else 0)
    qc.h(range(n))
    for g, b in zip(gammas, betas):
        for i in range(n):
            if h[i]:
                qc.rz(2 * g * h[i], i)
        for i in range(n):
            for j in range(i + 1, n):
                if J[i, j]:
                    qc.rzz(2 * g * J[i, j], i, j)
        qc.rx(2 * b, range(n))
    if measure:
        qc.measure(range(n), range(n))
    return qc


def counts_to_plans(counts, offset=0, width=N_UNITS):
    """Qiskit bitstrings (clbit 0 rightmost) -> {plan: count}. qubit i = plant i, so a plain
    base-2 read gives the plan integer; `offset` picks one block of a packed wide circuit."""
    out = {}
    for s, c in counts.items():
        s = s.replace(" ", "")
        v = (int(s, 2) >> offset) & ((1 << width) - 1)
        out[v] = out.get(v, 0) + int(c)
    return out

"""Engine tests:  python -m unittest discover tests   (from the project root)"""
import json
import sys
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine import methods, qaoa, qubo  # noqa: E402
from engine.data import UNITS, build_day  # noqa: E402
from engine.dispatch import ALL_PLANS, INFEASIBLE, bits, day_tables, dispatch, hour_table, label, plan_of  # noqa: E402
from engine.schedule import evaluate, priority_list, stitch  # noqa: E402


class Dispatch(unittest.TestCase):
    def test_meets_demand_and_matches_cost_formula(self):
        u = [1, 1, 1, 1, 1, 0, 0, 0, 0, 0]
        P, fuel, ok = dispatch([u], 1000.0)
        self.assertTrue(ok[0])
        self.assertAlmostEqual(P[0].sum(), 1000.0, places=6)
        manual = sum(UNITS[i]["a"] + UNITS[i]["b"] * P[0][i] + UNITS[i]["c"] * P[0][i] ** 2 for i in range(5))
        self.assertAlmostEqual(fuel[0], manual, places=6)
        on = [i for i in range(5) if UNITS[i]["p_min"] + 1e-6 < P[0][i] < UNITS[i]["p_max"] - 1e-6]
        lam = [UNITS[i]["b"] + 2 * UNITS[i]["c"] * P[0][i] for i in on]
        self.assertLess(max(lam) - min(lam), 1e-6, "unclamped units share one incremental cost")

    def test_infeasible_plans(self):
        tab = hour_table(1500.0, 150.0)
        self.assertEqual(tab[0], INFEASIBLE)  # nothing on
        self.assertEqual(tab[plan_of([1, 1, 0, 0, 0, 0, 0, 0, 0, 0])], INFEASIBLE)  # 910 MW < 1650
        self.assertLess(tab[1023], INFEASIBLE)

    def test_plan_encoding(self):
        self.assertEqual(label(plan_of([1, 1, 0, 0, 0, 0, 0, 0, 0, 1])), "1100000001")
        self.assertEqual(bits(5), [1, 0, 1, 0, 0, 0, 0, 0, 0, 0])
        self.assertTrue(np.array_equal(ALL_PLANS[6], bits(6)))


class Quantum(unittest.TestCase):
    def setUp(self):
        self.q = qubo.build(1300.0, 130.0)
        self.E = qubo.energies(self.q)

    def test_ising_equals_qubo(self):
        h, J, c = qubo.ising(self.q)
        z = 1 - 2 * ALL_PLANS
        self.assertTrue(np.allclose(c + z @ h + np.einsum("ki,ij,kj->k", z, J, z), self.E))

    def test_numpy_state_matches_qiskit(self):
        from qiskit.quantum_info import Statevector
        h, J, _ = qubo.ising(self.q)
        g, b = [0.8, 0.3], [0.5, 0.2]
        mine = qaoa.state(self.E, g, b)
        ref = Statevector(qaoa.circuit(h, J, g, b, measure=False)).data
        phase = ref[0] / mine[0]
        self.assertAlmostEqual(abs(phase), 1.0, places=9)
        self.assertTrue(np.allclose(ref, mine * phase, atol=1e-10))

    def test_bitstring_order(self):
        from qiskit import QuantumCircuit
        from qiskit.providers.basic_provider import BasicSimulator
        qc = QuantumCircuit(10, 10)
        qc.x([0, 2])  # plants G1 and G3 on
        qc.measure(range(10), range(10))
        counts = BasicSimulator().run(qc, shots=10).result().get_counts()
        self.assertEqual(qaoa.counts_to_plans(counts), {plan_of([1, 0, 1, 0, 0, 0, 0, 0, 0, 0]): 10})

    def test_training_lowers_energy(self):
        tr = qaoa.train(self.E, p=1)
        self.assertLess(tr["value"], float(self.E.mean()))


class Budget(unittest.TestCase):
    def test_training_is_charged_and_budget_respected(self):
        tab = hour_table(1000.0, 100.0)
        rng = np.random.default_rng(0)
        s = methods.from_samples(list(rng.integers(0, 1024, 500)), tab, budget=20, charge=6)
        self.assertEqual(len(s.seen), 20)
        self.assertEqual(sum(1 for p in s.seen if p >= 0), 14)
        a = methods.annealing(tab, methods.violation(1000.0, 100.0), 20, rng)
        r = methods.random_search(tab, 20, rng)
        self.assertEqual(len(a.seen), 20)
        self.assertEqual(len(r.seen), 20)


class Schedules(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.day = build_day("benchmark")
        cls.tab = day_tables(cls.day)

    def test_priority_list_is_feasible(self):
        ev = evaluate(priority_list(self.tab)["plans"], self.day)
        self.assertTrue(ev["feasible"], ev["violations"])

    def test_evaluate_catches_min_down(self):
        plans = priority_list(self.tab)["plans"]
        bad = list(plans)
        bad[1] = bad[1] & ~1  # G1 off for one hour, then back on: breaks its 8 h minimum down time
        ev = evaluate(bad, self.day)
        self.assertFalse(ev["feasible"])

    def test_stitch_repairs_bad_proposals(self):
        cands = [[0] for _ in range(24)]  # "everything off" every hour
        st = stitch(cands, self.tab)
        ev = evaluate(st["plans"], self.day)
        self.assertTrue(ev["feasible"], ev["violations"])
        self.assertGreater(st["repairs"], 0)

    def test_exact_matches_published_benchmark(self):
        from engine import exact
        r = exact.solve(self.day)
        self.assertTrue(r["ok"])
        self.assertTrue(r["schedule"]["feasible"])
        self.assertAlmostEqual(r["schedule"]["total"], 563938, delta=5)
        self.assertLessEqual(r["lower_bound"], r["schedule"]["total"])


class Api(unittest.TestCase):
    def test_run_on_basic_simulator(self):
        import os
        from engine import api
        from qiskit.providers.basic_provider import BasicSimulator
        os.chdir(ROOT)
        res = json.loads(api.run(BasicSimulator(), budget=16, shots=128))
        self.assertEqual(len(res["hours"]), 24)
        for k in ("qaoa", "annealing", "random", "priority", "exact"):
            self.assertTrue(res["schedules"][k]["feasible"], k)
            self.assertGreaterEqual(res["schedules"][k]["total"], res["schedules"]["exact"]["total"] - 1e-6)
        self.assertEqual(res["params"]["backend"], "basic_simulator")


if __name__ == "__main__":
    unittest.main()

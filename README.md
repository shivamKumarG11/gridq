# GridQ: quantum-hybrid unit commitment you can watch

**Can QAOA find good power-plant schedules under demand swings, and how does it compare with classical search at the same budget?**

GridQ plays out a day on a power grid in a 3D world. Every hour, a 10-qubit QAOA circuit (Qiskit, running on the backend you pick) proposes which of 10 power plants to switch on. Every proposal is priced exactly, the hours are stitched into a feasible 24-hour schedule, and the result is compared, under an equal evaluation budget, against simulated annealing, random search, the classic priority-list heuristic and the exact optimum.

Team **Superposition** · Qollab × IonQ Hackathon 2026 · Theme: **Quantum Impact** · MIT licence · Code: <https://github.com/shivamKumarG11/gridq>

> This effort is supported by Qollab & IonQ.

## Run it

1. Press **Run** and pick **Built-in simulator** (recommended; this is how judges run it). No settings needed.
2. The page opens on the benchmark day and runs it immediately (about 10–60 s in the browser): training, sampling 24 circuits, scoring, stitching.
3. Explore:
   - **World**: play the day (Space), scrub the hour, click a plant, switch the schedule shown (QAOA / exact / annealing / random / priority list). Amber outlines in the schedule strip are where it differs from the optimum.
   - **Superposition mode**: plant opacity and rings show P(on) for each qubit from the circuit's exact state; threads show measured correlations. **Measure one shot** collapses the world into one real sample and prices it.
   - **Quantum Lab**: QUBO → Hamiltonian → the Qiskit circuit → the exact (γ, β) energy landscape (click it) → the probability of all 1,024 plans, sorted by true cost.
   - **The race**: the evidence; precomputed sweeps over budgets, depths, parameter transfer and noise.
   - Change **scenario, demand shift, solar, depth, budget, shots** and press **Run the day** again.
4. **IonQ simulators** (Aria / Forte) also work: IonQ accepts one job per run, so the two peak hours are packed side by side into one 20-qubit circuit and sampled on IonQ; the other hours use the ideal statevector, and the page labels which is which.

## The problem

Every day, grid operators decide which plants to run in each hour of tomorrow: **unit commitment**. Each plant has a minimum and maximum output, a quadratic fuel cost, a start-up cost (hot or cold), and minimum up/down times; together they must meet demand plus a 10% spinning reserve every hour. Small improvements are worth real money and emissions, and solar makes the net demand swing harder (the "duck curve").

We use the standard **10-unit, 24-hour benchmark** (Kazarlis, Bakirtzis & Petridis 1996). Published best: **$563,938**. Our exact MILP finds **$563,937.69** with a proof that nothing is cheaper than $563,934.53; its schedule matches the published one hour by hour.

## How it works

```
for each hour:  QUBO (10 binaries) ─► QAOA circuit ─► shots on `backend`
                every distinct sampled plan ─► exact economic dispatch ─► true cost
                best 6 plans ─┐
day stitching (beam search): start-up costs, min up/down, repair ─► 24 h schedule ─► compare
```

- **QUBO per hour**: `C(x) = Σ cᵢxᵢ + λ(Σ pᵢxᵢ − 1)²`, xᵢ = plant i on; cᵢ = no-load cost + minimum-output premium; pᵢ = Pmaxᵢ / (demand + reserve + 60 MW); λ = 6. λ and the margin were tuned **once, on the benchmark day** (`experiments/tune_qubo.py`) and frozen, so the solar day is out-of-sample. The QUBO is only a guide: every sample is re-scored with the true cost, so the QUBO's approximations can only lower candidate quality, never corrupt a reported cost.
- **QAOA**: Ising form → `H`, then `RZ` + 45 `RZZ` + `RX` per layer (10 qubits, depth 21 at p = 1). Angles are trained once on the peak hour with the exact statevector and **transferred** to all 24 hours.
- **Fair race**: every method gets the same budget of true-cost evaluations per hour. QAOA's training (133 circuit evaluations at p = 1) is **charged to its budget** (6 per hour). Annealing works on the true cost; random search samples uniformly. All methods share the same dispatch, scoring and stitcher.
- **Exact baseline**: the full linked 24-hour MILP (HiGHS via SciPy), with secant linearisation of the fuel curves and a proven bound.

## Results (precomputed, `experiments/precompute.py`, 5 seeds)

Gap of the 24-hour cost to the exact optimum, mean of 5 seeds:

| Budget / hour | QAOA p=1 | QAOA p=2 | Annealing | Random | 
|---|---|---|---|---|
| **Benchmark day** (optimum $563,938; priority list +0.39%) | | | | |
| 16 | **+2.32%** | +2.74% | +4.92% | +2.63% |
| 64 | **+1.54%** | +2.11% | +2.99% | +1.88% |
| 256 | **+0.41%** | +0.70% | +0.91% | +1.04% |
| **Solar day** (optimum $491,869; priority list +1.00%) | | | | |
| 16 | **+3.58%** | +4.54% | +6.64% | +4.15% |
| 64 | **+2.07%** | +3.26% | +4.33% | +2.91% |
| 256 | **+0.54%** | +0.83% | +1.30% | +1.38% |

- **QAOA p = 1 beats annealing and random search at equal budget from 16 evaluations per hour up, on both days.**
- On the out-of-sample **solar day it also beats the classic priority-list heuristic** at 128 and 256 evaluations. On the benchmark day the heuristic stays marginally ahead (+0.39% vs +0.41%).
- **Depth & transfer** (benchmark day): p = 1 with transfer puts 5.7× random on the 5 cheapest feasible plans. Deeper circuits only help if trained per hour (p = 3: 9.6×, at 86× the training cost); transferred p = 2 angles generalise poorly.
- **Noise** (Qiskit Aer, depolarising + readout errors from IonQ's published fidelities): at the peak hour, ideal QAOA hits a top-5 plan 26× more often than random (2.55% vs 0.10%); a Forte-like model keeps 2.30%, an Aria-like model 1.82%. Across the three hours studied, IonQ-like noise costs 7–29% of the quantum signal at this size.

## Honest assessment

- **No quantum advantage is claimed.** At 10 plants a laptop checks all 1,024 plans per hour instantly, and the exact MILP solves the whole day in seconds. The race measures how QAOA *behaves* as a proposal engine, under rules that give it no free information.
- What the result does say: a shallow, transferred QAOA is a better-than-random, better-than-annealing sampler for this problem at small budgets, and the gap to optimal shrinks predictably with budget; noise at IonQ-like levels erodes but does not erase that signal.
- Not grid-operations ready: no network flows, ramp limits, outages or uncertainty. The solar day is stylised (a clear-sky curve), not measured data.

## How to extend

- **Your own grid**: edit `engine/data.py` (`UNITS`, `BENCHMARK_DEMAND`, `build_day`). Everything downstream (QUBO, circuits, dispatch, MILP, UI) adapts; the circuit uses one qubit per plant.
- **Better QAOA**: `engine/qaoa.py` has CVaR objectives and INTERP warm starts; `experiments/precompute.py` re-runs the whole evidence base in about 3 minutes.
- **Bigger fleets**: the planned next step is quantum large-neighbourhood search, QAOA on 8–16-plant windows of a 50–100-plant fleet (fits IonQ's 25–29-qubit simulators).

## Judging criteria

- **Novelty**: a full, fair, budget-matched benchmark of QAOA on a real industrial problem, wrapped in an explorable 3D world with a live "superposition mode" that shows the quantum state on the physical plants.
- **Technical execution**: verified exact baseline (matches the literature), Qiskit circuits on the chosen backend, IonQ one-job packing, statevector parity tests between numpy, Qiskit and the in-page simulator, 16 automated tests.
- **Impact**: unit commitment is solved daily by every grid operator; we show precisely where shallow QAOA stands today, and what noise costs, in dollars.
- **Documentation**: this page, the in-app Method view, inline text alternatives for every chart, and reproducible experiment scripts.

## Code layout

| Path | What |
|---|---|
| `main.js`, `index.html`, `main.css` | Qollab entry: page and bridge to Python |
| `ui/` | `app.js` controller, `world.js` (three.js world), `qsim.js` (in-page statevector), `charts.js` |
| `engine/` | `data`, `dispatch`, `qubo`, `qaoa`, `methods`, `schedule` (stitcher), `exact` (MILP), `pipeline`, `api` |
| `results/precomputed.json` | the race, depth, noise and exact results shown in the app |
| `experiments/`, `tests/`, `dev/` | local-only: experiments, tests (`python -m unittest discover tests`, `npm test`), dev server (`python dev/serve.py`) |

## Disclosures and credits

- Data: Kazarlis, Bakirtzis & Petridis, *A genetic algorithm solution to the unit commitment problem*, IEEE Trans. Power Systems 11(1), 1996, as tabulated in Rashed et al., RE&PQJ (2007). Solar profile: synthetic.
- Libraries: Qiskit, Qiskit Aer (local experiments only), NumPy, SciPy (HiGHS), three.js. QAOA INTERP initialisation: Zhou et al., PRX 10, 021067 (2020).
- All code was written during the hackathon window, with AI assistance (Claude by Anthropic). No templates or forks. Design concepts were drawn before kickoff (planning only).
- **This effort is supported by Qollab & IonQ.**

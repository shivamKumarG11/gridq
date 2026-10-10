"""Benchmark data and demand scenarios.

Plants: the 10-unit unit-commitment benchmark of Kazarlis, Bakirtzis & Petridis (IEEE Trans. Power
Systems 11(1), 1996), as tabulated in Rashed et al. (RE&PQJ 2007) and de Mars (arXiv:2212.06001).
"""
import math

# p_min/p_max MW; fuel cost a + b*P + c*P^2 $/h; t_up/t_down h; start-up costs $; init_status:
# + hours already on, - hours already off at the start of hour 1.
UNITS = [
    dict(id=1, fuel="coal", p_min=150, p_max=455, a=1000, b=16.19, c=0.00048, t_up=8, t_down=8, hot_cost=4500, cold_cost=9000, cold_hrs=5, init_status=8),
    dict(id=2, fuel="coal", p_min=150, p_max=455, a=970, b=17.26, c=0.00031, t_up=8, t_down=8, hot_cost=5000, cold_cost=10000, cold_hrs=5, init_status=8),
    dict(id=3, fuel="gas", p_min=20, p_max=130, a=700, b=16.60, c=0.00200, t_up=5, t_down=5, hot_cost=550, cold_cost=1100, cold_hrs=4, init_status=-5),
    dict(id=4, fuel="gas", p_min=20, p_max=130, a=680, b=16.50, c=0.00211, t_up=5, t_down=5, hot_cost=560, cold_cost=1120, cold_hrs=4, init_status=-5),
    dict(id=5, fuel="gas", p_min=25, p_max=162, a=450, b=19.70, c=0.00398, t_up=6, t_down=6, hot_cost=900, cold_cost=1800, cold_hrs=4, init_status=-6),
    dict(id=6, fuel="gas", p_min=20, p_max=80, a=370, b=22.26, c=0.00712, t_up=3, t_down=3, hot_cost=170, cold_cost=340, cold_hrs=2, init_status=-3),
    dict(id=7, fuel="gas", p_min=25, p_max=85, a=480, b=27.74, c=0.00079, t_up=3, t_down=3, hot_cost=260, cold_cost=520, cold_hrs=2, init_status=-3),
    dict(id=8, fuel="oil", p_min=10, p_max=55, a=660, b=25.92, c=0.00413, t_up=1, t_down=1, hot_cost=30, cold_cost=60, cold_hrs=0, init_status=-1),
    dict(id=9, fuel="oil", p_min=10, p_max=55, a=665, b=27.27, c=0.00222, t_up=1, t_down=1, hot_cost=30, cold_cost=60, cold_hrs=0, init_status=-1),
    dict(id=10, fuel="oil", p_min=10, p_max=55, a=670, b=27.79, c=0.00173, t_up=1, t_down=1, hot_cost=30, cold_cost=60, cold_hrs=0, init_status=-1),
]
N_UNITS = len(UNITS)

BENCHMARK_DEMAND = [700, 750, 850, 950, 1000, 1100, 1150, 1200, 1300, 1400, 1450, 1500,
                    1400, 1300, 1200, 1050, 1000, 1100, 1200, 1400, 1300, 1100, 900, 800]
RESERVE_FRACTION = 0.10
PUBLISHED_BEST = 563938  # Rashed et al. 2007, Table 4 (LR), 10 units, 24 h

SCENARIOS = {
    "benchmark": dict(label="Benchmark day (Kazarlis 1996)", solar_peak=0),
    "solar": dict(label="Solar day (stylised duck curve)", solar_peak=400),
}


def solar_profile(peak_mw):
    """Stylised clear-sky solar output for hours 1..24 (hour t covers t-1..t). Not measured data."""
    out = []
    for t in range(1, 25):
        h = t - 0.5
        s = math.sin(math.pi * (h - 6.0) / 13.0) if 6.0 < h < 19.0 else 0.0
        out.append(round(peak_mw * max(0.0, s) ** 1.5, 1))
    return out


def build_day(scenario="benchmark", demand_shift=0.0, solar_peak=None):
    """Net load the thermal fleet must serve each hour, and its spinning reserve (10% of net load).

    demand_shift: fractional change of gross demand (e.g. -0.1 = 10% lower).
    solar_peak: MW of solar at noon; None uses the scenario's default.
    """
    if solar_peak is None:
        solar_peak = SCENARIOS[scenario]["solar_peak"]
    gross = [d * (1.0 + demand_shift) for d in BENCHMARK_DEMAND]
    solar = solar_profile(solar_peak)
    floor = UNITS[0]["p_min"] + UNITS[1]["p_min"]  # keep at least the coal minimum on the grid
    net = [round(max(floor, g - s), 1) for g, s in zip(gross, solar)]
    reserve = [round(RESERVE_FRACTION * n, 1) for n in net]
    cap = sum(u["p_max"] for u in UNITS)
    if max(n + r for n, r in zip(net, reserve)) > cap + 1e-6:
        raise ValueError(f"demand + reserve exceeds the fleet's {cap} MW; lower the demand shift")
    return dict(gross=[round(g, 1) for g in gross], solar=solar, net=net, reserve=reserve)

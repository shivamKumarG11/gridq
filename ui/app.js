// GridQ page controller. `bridge.call(name, kwargs)` reaches engine/api.py (Pyodide on Qollab, a local
// Python server in dev) and returns parsed JSON.
import { createWorld } from './world.js';
import * as Q from './qsim.js';
import { timeline, lineChart, ramp, diverge } from './charts.js';

const $ = (id) => document.getElementById(id);
const money = (v) => (v == null ? '-' : '$' + Math.round(v).toLocaleString('en-US'));
const mw = (v) => Math.round(v).toLocaleString('en-US') + ' MW';
const pct = (v, d = 2) => (v == null ? '-' : v.toFixed(d) + ' %');
const hh = (t) => String(t + 1).padStart(2, '0') + ':00';
const SOURCES = [
  ['qaoa', 'QAOA hybrid'], ['exact', 'Exact MILP'], ['annealing', 'Sim. annealing'], ['random', 'Random search'], ['priority', 'Priority list'],
];
const NAMES = Object.fromEntries(SOURCES);
const FUEL_COL = { coal: '#6d737d', gas: '#5f8296', oil: '#94705a' };
const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const S = {
  init: null, run: null, src: 'qaoa', hour: 11, playing: false, speed: 4, timer: null,
  sel: null, superpos: false, measured: null, liveBackend: true, labHour: 11, labAngles: null, raceSc: 'benchmark',
};
let bridge, world, units;

function status(msg, err = false) { const s = $('status'); s.textContent = msg; s.classList.toggle('err', err); }
function narrate(msg) { $('narrate').textContent = msg; }
const bitsOf = Q.bitsOf;

// ---------- schedule helpers ----------
function sched(src = S.src) { return S.run && S.run.schedules[src]; }
function hourTag(t) {
  const d = S.run.day.net, i = d[t];
  if (i === Math.max(...d)) return 'daily peak';
  if (t >= 17 && t <= 21 && i >= d[t - 1]) return 'evening ramp';
  if (t <= 4) return 'night base load';
  if (t >= 5 && t <= 9) return 'morning ramp';
  return t >= 21 ? 'late evening' : 'daytime';
}
/** start-up kind per unit at hour t of a schedule (hot/cold), recomputed from the plans + history */
function startKinds(plans, t) {
  const out = {};
  units.forEach((u, i) => {
    let off = 0;
    for (let k = t - 1; k >= 0 && !((plans[k] >> i) & 1); k--) off++;
    const prevOn = t === 0 ? u.init_status > 0 : (plans[t - 1] >> i) & 1;
    if ((plans[t] >> i) & 1 && !prevOn) {
      if (off === t && u.init_status < 0) off += -u.init_status;
      out[i] = off <= u.t_down + u.cold_hrs ? ['hot', u.hot_cost] : ['cold', u.cold_cost];
    }
  });
  return out;
}

// ---------- world view ----------
function renderHour() {
  const sc = sched();
  if (!sc) return;
  const t = S.hour, day = S.run.day, hr = sc.hours[t];
  const bits = bitsOf(hr.plan);
  const kinds = startKinds(sc.plans, t);
  if (!S.measured) {
    world.setHour({
      hour: t + 1, demandFrac: day.net[t] / 1500,
      plants: units.map((u, i) => ({ on: bits[i], starting: i in kinds, frac: bits[i] ? hr.output[i] / u.p_max : 0 })),
    });
  }
  $('clock').textContent = hh(t);
  $('clock-sub').textContent = `Hour ${t + 1} of 24 · ${hourTag(t)}`;
  const need = day.net[t] + day.reserve[t];
  $('st-demand').textContent = mw(day.net[t]);
  $('st-need').textContent = mw(need);
  $('st-cap').textContent = mw(hr.capacity);
  $('st-cap').className = 'mono ' + (hr.capacity >= need - 1e-6 ? 'c-good' : 'c-amber');
  const feas = sc.hours.filter((h, k) => h.capacity >= day.net[k] + day.reserve[k] - 1e-6).length;
  $('st-feas').textContent = `${feas} / 24`;
  const nOn = bits.filter(Boolean).length, nStart = Object.keys(kinds).length;
  $('lg-run').textContent = nOn - nStart; $('lg-start').textContent = nStart; $('lg-off').textContent = 10 - nOn;
  const co = $('callout');
  if (nStart) {
    co.hidden = false;
    co.innerHTML = `<span class="c-amber">${Object.keys(kinds).map((i) => 'G' + (+i + 1)).join(' · ')} · starting this hour</span><br>` +
      Object.entries(kinds).map(([i, [k, c]]) => `G${+i + 1} ${money(c)} ${k}`).join(' · ');
  } else co.hidden = true;
  // narrative
  const prev = t > 0 ? sc.hours[t - 1] : null;
  const dd = prev ? day.net[t] - day.net[t - 1] : 0;
  const stopped = prev ? units.map((u, i) => i).filter((i) => ((prev.plan >> i) & 1) && !bits[i]) : [];
  const ex = S.run.schedules.exact;
  const diff = ex ? units.map((u, i) => i).filter((i) => ((ex.hours[t].plan >> i) & 1) !== bits[i]) : [];
  $('changed-title').textContent = `What changed at ${hh(t)}`;
  let txt = prev ? `Net demand ${dd >= 0 ? 'rises' : 'falls'} ${mw(Math.abs(dd))} (${mw(day.net[t - 1])} → ${mw(day.net[t])}). ` : `The day starts at ${mw(day.net[t])}. `;
  if (day.solar[t] > 0) txt += `Solar covers ${mw(day.solar[t])} of ${mw(day.gross[t])} gross demand. `;
  txt += nStart ? `${NAMES[S.src]} starts ${Object.keys(kinds).map((i) => 'G' + (+i + 1)).join(', ')} (start-up ${money(hr.startup)}). ` : '';
  txt += stopped.length ? `It switches off ${stopped.map((i) => 'G' + (i + 1)).join(', ')}. ` : '';
  txt += `Committed capacity ${mw(hr.capacity)} against ${mw(need)} needed; fuel this hour ${money(hr.fuel)}. `;
  if (S.src !== 'exact' && ex) txt += diff.length ? `The exact optimum differs on ${diff.map((i) => 'G' + (i + 1)).join(', ')}.` : 'Same plan as the exact optimum this hour.';
  $('changed').textContent = txt;
  // timeline + strip + plant buttons
  timeline($('tl-svg'), day, t);
  $('in-hour').value = t + 1;
  $('tl-label').textContent = `Net demand, 24 h · ${S.run.scenario === 'solar' ? 'solar day (dashed: gross demand)' : 'benchmark day'} · playhead at ${hh(t)}`;
  renderStrip();
  document.querySelectorAll('#plant-buttons button').forEach((b, i) => {
    b.classList.toggle('on', !!bits[i] && !(i in kinds)); b.classList.toggle('starting', i in kinds);
    b.setAttribute('aria-label', `G${i + 1}, ${units[i].fuel}, ${i in kinds ? 'starting' : bits[i] ? `running at ${Math.round(hr.output[i])} MW` : 'off'}`);
  });
  renderInspector();
  if (S.superpos && !S.measured) applySuperposition();
  $('sp-hour').textContent = `hour ${t + 1}`;
}

function renderStrip() {
  const sc = sched(), ex = S.run.schedules.exact, el = $('strip');
  const frag = document.createDocumentFragment();
  const cell = (cls, text) => { const d = document.createElement('div'); d.className = cls; if (text) d.textContent = text; frag.appendChild(d); return d; };
  cell('rl', '');
  for (let t = 0; t < 24; t++) cell('hl', t % 3 === 0 ? String(t + 1) : '');
  let ndiff = 0;
  units.forEach((u, i) => {
    cell('rl', 'G' + u.id);
    for (let t = 0; t < 24; t++) {
      const on = (sc.hours[t].plan >> i) & 1;
      const d = cell('c' + (t === S.hour ? ' now' : ''));
      if (on) d.style.background = FUEL_COL[u.fuel];
      if (ex && S.src !== 'exact' && ((ex.hours[t].plan >> i) & 1) !== on) { d.classList.add('diff'); ndiff++; }
    }
  });
  el.replaceChildren(frag);
  el.setAttribute('aria-label', `On/off schedule of ${NAMES[S.src]}: ${ndiff} plant-hours differ from the exact optimum.`);
  $('strip-title').textContent = `Schedule · ${NAMES[S.src]} · rows G1–G10, columns hours 1–24`;
}

function renderCosts() {
  const ex = S.run.schedules.exact;
  const rows = SOURCES.filter(([k]) => S.run.schedules[k]).map(([k, name]) => {
    const s = S.run.schedules[k];
    const gap = ex ? (s.total - ex.total) / ex.total * 100 : null;
    return `<div class="crow${k === S.src ? ' cur' : ''}${k === 'exact' ? ' exact' : ''}"><span>${name}</span><b>${money(s.total)}${k !== 'exact' && gap != null ? ` <span class="small muted">+${gap.toFixed(2)}%</span>` : ''}</b></div>`;
  });
  const q = S.run.schedules.qaoa;
  if (ex && q) rows.push(`<div class="crow gap"><span>QAOA gap to optimum</span><b>${pct((q.total - ex.total) / ex.total * 100)}</b></div>`);
  $('cost-list').innerHTML = rows.join('');
  const pr = S.run.params;
  $('cost-note').textContent = (ex ? `Exact: ${ex.source}${ex.lower_bound ? `, proven within ${money(ex.total - ex.lower_bound)} of the true optimum` : ''}. ` : `Exact optimum unavailable: ${S.run.exact_error || ''} `) +
    `Published best for the benchmark day: $563,938. This run: p = ${pr.p}, budget ${pr.budget}/hour, ${pr.shots} shots, ${S.run.seconds}s, backend ${pr.backend}. Repairs by the stitcher: QAOA ${q ? q.repairs : '-'}${q && q.fallback ? ' (needed the all-on fallback)' : ''}.`;
}

function renderInspector() {
  const el = $('inspector');
  if (S.sel == null || !S.run) { el.hidden = true; return; }
  const i = S.sel, u = units[i], sc = sched(), t = S.hour, hr = sc.hours[t];
  const on = (hr.plan >> i) & 1;
  const H = S.run.hours[t];
  const p = Q.probs(H.E, H.gammas, H.betas);
  const pon = Q.marginals(p)[i];
  const tl = sc.hours.map((h, k) => `<i class="${(h.plan >> i) & 1 ? 'on' : ''}${k === t ? ' now' : ''}"></i>`).join('');
  el.hidden = false;
  el.innerHTML = `<h2 class="eyebrow">Plant G${u.id} · ${u.fuel}</h2>
    <dl class="insp-grid"><dt>Now</dt><dd>${on ? `running, ${Math.round(hr.output[i])} MW` : 'off'}</dd>
    <dt>Range</dt><dd>${u.p_min}–${u.p_max} MW</dd><dt>Fuel cost</dt><dd>${u.a} + ${u.b}·P + ${u.c}·P² $/h</dd>
    <dt>Min up / down</dt><dd>${u.t_up} h / ${u.t_down} h</dd><dt>Start-up</dt><dd>${money(u.hot_cost)} hot · ${money(u.cold_cost)} cold</dd></dl>
    <div class="small muted">On/off over the day (${NAMES[S.src]})</div><div class="mini-tl" aria-hidden="true">${tl}</div>
    <div class="small muted">Quantum view, hour ${t + 1}: P(qubit ${i} measures ON) = <span class="mono c-power">${(pon * 100).toFixed(1)}%</span></div>
    <div class="pon" aria-hidden="true"><i style="width:${(pon * 100).toFixed(1)}%"></i></div>
    <button type="button" id="insp-lab">Open this hour in the Quantum Lab</button>`;
  $('insp-lab').onclick = () => { S.labHour = t; $('lab-hour').value = t; showView('lab'); renderLab(true); };
}

function select(i) {
  S.sel = i;
  world.setSelected(i);
  document.querySelectorAll('#plant-buttons button').forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
  renderInspector();
  if (i != null) narrate(`Selected plant G${i + 1}`);
}

function setHour(t, announce = true) {
  S.hour = Math.max(0, Math.min(23, t));
  if (S.measured) { S.measured = null; $('sp-result').textContent = ''; }
  renderHour();
  if (announce) {
    const sc = sched(), hr = sc.hours[S.hour];
    narrate(`${hh(S.hour)}: demand ${mw(S.run.day.net[S.hour])}, ${bitsOf(hr.plan).filter(Boolean).length} plants on, committed ${mw(hr.capacity)}.`);
  }
}

function play(on) {
  S.playing = on;
  $('play-icon').setAttribute('d', on ? 'M6 5h4v14H6zM14 5h4v14h-4z' : 'M7 5l12 7-12 7z');
  $('btn-play').setAttribute('aria-label', on ? 'Pause the day' : 'Play the day');
  clearInterval(S.timer);
  if (on) S.timer = setInterval(() => setHour((S.hour + 1) % 24, S.speed <= 1), 2400 / S.speed);
}

// ---------- superposition ----------
function applySuperposition() {
  const H = S.run.hours[S.hour];
  const p = Q.probs(H.E, H.gammas, H.betas);
  world.setSuperposition({ pon: Q.marginals(p), corr: Q.correlations(p) });
}

async function measureOne() {
  const t = S.hour, H = S.run.hours[t], day = S.run.day;
  let plan, source;
  try {
    const r = await bridge.call('measure_one', { demand: day.net[t], reserve: day.reserve[t], gammas: H.gammas, betas: H.betas, use_backend: S.liveBackend && !S.init.ionq });
    plan = r.plan; source = r.source;
  } catch (e) {
    plan = Q.sample(Q.probs(H.E, H.gammas, H.betas)); source = 'ideal statevector (in-page)';
  }
  S.measured = plan;
  world.setSuperposition(null);
  const bits = bitsOf(plan);
  world.setHour({ hour: t + 1, demandFrac: day.net[t] / 1500, plants: units.map((u, i) => ({ on: bits[i], starting: false, frac: bits[i] ? 0.7 : 0 })) });
  world.flash();
  const cost = H.cost[plan];
  const msg = `Shot: ${Q.labelOf(plan)} → ${cost == null ? 'infeasible (does not cover demand + reserve)' : `feasible, true cost ${money(cost)}/h` + (plan === H.best_plan ? ' (the cheapest plan!)' : ` (cheapest is ${money(H.best_cost)}/h)`)}. Source: ${source}.`;
  $('sp-result').textContent = msg;
}

function toggleSuper(on) {
  S.superpos = on; S.measured = null;
  $('btn-super').setAttribute('aria-pressed', String(on));
  $('superpanel').hidden = !on;
  $('sp-result').textContent = '';
  if (on) { play(false); applySuperposition(); narrate('Superposition mode: plant opacity shows the probability each qubit measures on.'); }
  else { world.setSuperposition(null); renderHour(); }
}

// ---------- quantum lab ----------
let landCache = { key: null, vals: null };
function renderLab(reset = false) {
  if (!S.run) return;
  const t = S.labHour, H = S.run.hours[t], day = S.run.day;
  $('lab-sub').textContent = `${t === showcaseHour(S.run) ? 'Opened on the hour where the trained circuit does best; pick any hour. ' : ''}${hh(t)} · ${mw(day.net[t])} + ${mw(day.reserve[t])} reserve · QUBO target ${mw(H.target)} · trained angles γ = [${H.gammas.map((g) => g.toFixed(3)).join(', ')}], β = [${H.betas.map((b) => b.toFixed(3)).join(', ')}]`;
  const lmax = Math.max(...H.lin.map(Math.abs));
  $('lab-lin').innerHTML = H.lin.map((v, i) => `<div class="b"><i style="height:${Math.max(3, Math.abs(v) / lmax * 80)}px;background:${v < 0 ? '#ffb347' : '#4fd1ff'}"></i><span>G${i + 1}</span></div>`).join('');
  $('lab-lin').setAttribute('aria-label', 'Linear QUBO weight per plant: ' + H.lin.map((v, i) => `G${i + 1} ${v.toFixed(3)}`).join(', '));
  const J = H.ising_J, jmax = Math.max(...J.flat().map(Math.abs));
  let jh = '<span></span>' + units.map((u) => `<span>G${u.id}</span>`).join('');
  for (let a = 0; a < 10; a++) {
    jh += `<span>G${a + 1}</span>`;
    for (let b = 0; b < 10; b++) { const v = a < b ? J[a][b] : J[b][a]; jh += `<i style="background:${a === b ? '#0e1520' : diverge(v, jmax)}"></i>`; }
  }
  $('lab-J').innerHTML = jh;
  $('lab-J').setAttribute('aria-label', `ZZ coupling matrix; strongest coupling ${jmax.toFixed(3)} between G1 and G2`);
  $('lab-circ').textContent = t + 1 === S.run.circuit_hour ? S.run.circuit_text : `(Qiskit drawing shown for the peak hour ${S.run.circuit_hour}; this hour's circuit has the same gates with its own weights.)\n\n` + S.run.circuit_text;
  const cs = S.run.circuit_stats;
  $('lab-circ-stats').textContent = `${cs.qubits} qubits · depth ${cs.depth} · ${cs.two_qubit} RZZ two-qubit gates · gates ${Object.entries(cs.ops).map(([k, v]) => `${k}×${v}`).join(', ')}`;
  const key = `${S.run.seconds}-${t}`;
  if (landCache.key !== key) landCache = { key, vals: Q.landscape(H.E, 20) };
  if (reset || !S.labAngles) {
    // open on the angles this run actually used; the cursor starts at the landscape's minimum
    let best = [0, 0], bv = Infinity;
    landCache.vals.forEach((row, r) => row.forEach((v, c) => { if (v < bv) { bv = v; best = [c, 19 - r]; } }));
    S.labAngles = { gi: best[0], bi: best[1], trained: true };
  }
  drawLand();
  drawDist();
}

function labGB() {
  if (S.labAngles.trained) { const H = S.run.hours[S.labHour]; return [H.gammas, H.betas]; }
  return [[S.labAngles.gi / 19 * Q.GAMMA_MAX], [S.labAngles.bi / 19 * Q.BETA_MAX]];
}

function drawLand() {
  const cv = $('lab-land'), ctx = cv.getContext('2d'), vals = landCache.vals;
  const flat = vals.flat(), lo = Math.min(...flat), hi = Math.max(...flat), c = cv.width / 20;
  vals.forEach((row, r) => row.forEach((v, k) => { ctx.fillStyle = ramp(1 - (v - lo) / (hi - lo)); ctx.fillRect(k * c, r * c, c + 0.5, c + 0.5); }));
  if (!S.labAngles.trained) {
    ctx.strokeStyle = '#ffb347'; ctx.lineWidth = 3;
    ctx.strokeRect(S.labAngles.gi * c + 1.5, (19 - S.labAngles.bi) * c + 1.5, c - 3, c - 3);
  }
  const [g, b] = labGB();
  $('lab-g').value = S.labAngles.gi; $('lab-b').value = S.labAngles.bi;
  $('lab-g-out').textContent = S.labAngles.trained ? `[${g.map((x) => x.toFixed(2)).join(', ')}]` : g[0].toFixed(2);
  $('lab-b-out').textContent = S.labAngles.trained ? `[${b.map((x) => x.toFixed(2)).join(', ')}]` : b[0].toFixed(2);
}

function drawDist() {
  const H = S.run.hours[S.labHour];
  const [g, b] = labGB();
  const p = Q.probs(H.E, g, b);
  const order = [...Array(1024).keys()].sort((x, y) => {
    const cx = H.cost[x], cy = H.cost[y];
    if (cx == null && cy == null) return H.E[x] - H.E[y];
    if (cx == null) return 1; if (cy == null) return -1; return cx - cy;
  });
  const max = Math.max(...p, 3 / 1024);
  const svg = $('lab-dist');
  const parts = order.map((k, x) => {
    const h = p[k] / max * 210;
    const col = H.cost[k] == null ? '#5a6b7d' : (k === H.best_plan ? '#7cf0b0' : '#4fd1ff');
    return `<rect x="${x}" y="${220 - h}" width="1" height="${h}" fill="${col}"></rect>`;
  });
  const uy = 220 - (1 / 1024) / max * 210;
  parts.push(`<line x1="0" x2="1024" y1="${uy}" y2="${uy}" stroke="#ffb347" stroke-dasharray="8 6" stroke-width="2" vector-effect="non-scaling-stroke"></line>`);
  const bi = order.indexOf(H.best_plan);
  parts.push(`<rect x="${Math.max(0, bi - 3)}" y="0" width="7" height="220" fill="#7cf0b0" opacity="0.12"></rect>`);
  svg.innerHTML = parts.join('');
  const pf = H.cost.reduce((s, c, k) => s + (c == null ? 0 : p[k]), 0);
  const nf = H.cost.filter((c) => c != null).length;
  $('lab-pbest').textContent = `${(p[H.best_plan] * 100).toFixed(2)}% (${(p[H.best_plan] * 1024).toFixed(1)}× random)`;
  $('lab-pfeas').textContent = `${(pf * 100).toFixed(1)}%`;
  $('lab-pfeas-r').textContent = `${(nf / 1024 * 100).toFixed(1)}% (${nf} plans)`;
  svg.setAttribute('aria-label', `Probability over 1,024 plans sorted by true cost. Best plan ${Q.labelOf(H.best_plan)} has probability ${(p[H.best_plan] * 100).toFixed(2)}%, against 0.10% for random guessing; ${(pf * 100).toFixed(1)}% of shots are feasible.`);
}

// ---------- race ----------
function renderRace() {
  const pre = S.init.precomputed, sc = pre && pre.scenarios && pre.scenarios[S.raceSc];
  if (!sc) { $('race-chart').textContent = 'Precomputed results not found (run experiments/precompute.py).'; return; }
  const ex = sc.exact.total, budgets = pre.budgets;
  const gap = (v) => (v == null ? null : (v - ex) / ex * 100);
  const M = [['qaoa_p1', 'QAOA p = 1', '#4fd1ff', ''], ['qaoa_p2', 'QAOA p = 2', '#a5ecff', '6 4'], ['annealing', 'Simulated annealing', '#ffb347', ''], ['random', 'Random search', '#9fb0c3', '2 4']];
  const series = M.map(([k, name, color, dash]) => ({
    name, color, dash,
    points: budgets.map((b) => [b, gap(sc.race[b][k].mean)]),
    band: budgets.map((b) => [b, gap(sc.race[b][k].best), gap(sc.race[b][k].worst)]),
  }));
  const pl = gap(sc.priority.total);
  lineChart($('race-chart'), series, {
    xLog2: true, xs: budgets, xLabel: 'True-cost evaluations per hour (log scale)', yLabel: 'Gap to optimum, %', yMin: 0,
    yFmt: (v) => v.toFixed(1) + '%', refs: [{ y: 0, label: `exact optimum ${money(ex)}`, color: '#7cf0b0' }, { y: pl, label: `priority list (1 evaluation) +${pl.toFixed(2)}%`, color: '#c5d2e0', align: 'left' }],
    label: 'Gap to the exact optimum versus evaluation budget for QAOA, annealing and random search; the table below has the numbers.',
  });
  $('race-legend').innerHTML = M.map(([, n, c]) => `<span><i style="background:${c}"></i>${n}</span>`).join('');
  // table
  let th = '<tr><th>Budget</th>' + M.map(([, n]) => `<th>${n}</th>`).join('') + '</tr>';
  budgets.forEach((b) => {
    const vals = M.map(([k]) => sc.race[b][k].mean);
    const best = Math.min(...vals.filter((v) => v != null));
    th += `<tr><td>${b}</td>` + vals.map((v) => `<td class="${v === best ? 'win' : ''}">${v == null ? 'no feasible day' : `${money(v)} <span class="muted">(+${gap(v).toFixed(2)}%)</span>`}</td>`).join('') + '</tr>';
  });
  $('race-table').innerHTML = th;
  // summary
  const at = (b, k) => gap(sc.race[b][k].mean);
  const wins = budgets.filter((b) => { const v = M.map(([k]) => sc.race[b][k].mean ?? Infinity); return v.indexOf(Math.min(...v)) === 0; });
  // smallest budget from which QAOA p=1 beats annealing and random at every larger budget
  let from = null;
  for (let k = budgets.length - 1; k >= 0; k--) {
    const r = sc.race[budgets[k]], q = r.qaoa_p1.mean ?? Infinity;
    if (q < (r.annealing.mean ?? Infinity) && q < (r.random.mean ?? Infinity)) from = budgets[k]; else break;
  }
  const beatsPL = budgets.filter((b) => (sc.race[b].qaoa_p1.mean ?? Infinity) < sc.priority.total);
  const verdict = (from ? `It beats annealing and random search at equal budget from ${from} evaluations per hour up. ` : 'It does not consistently beat annealing and random search here. ') +
    (beatsPL.length ? `On this day it also beats the classic priority-list heuristic at ${beatsPL.join(', ')} evaluations.` : 'The one-line priority-list heuristic still beats every sampler on this day: the honest state of the art at this size.');
  $('race-summary').innerHTML = `
    <div class="stat"><span>Exact optimum (MILP)</span><b class="c-good">${money(ex)}</b></div>
    <div class="stat"><span>Gap at 64 evals: QAOA p=1</span><b>${pct(at(64, 'qaoa_p1'))}</b></div>
    <div class="stat"><span>Gap at 64 evals: annealing</span><b>${pct(at(64, 'annealing'))}</b></div>
    <div class="stat"><span>Gap at 64 evals: random</span><b>${pct(at(64, 'random'))}</b></div>
    <div class="stat"><span>Priority list (classic heuristic)</span><b>${pct(pl)}</b></div>
    <p class="small">QAOA p = 1 has the lowest mean cost of the four samplers at ${wins.length} of ${budgets.length} budgets (${wins.join(', ') || 'none'}). ${verdict}</p>`;
  // depth
  const d = sc.depth;
  const rows = [['p1_transfer', 'p = 1, transfer'], ['p1_per_hour', 'p = 1, per hour'], ['p2_transfer', 'p = 2, transfer'], ['p2_per_hour', 'p = 2, per hour'], ['p3_transfer', 'p = 3, transfer'], ['p3_per_hour', 'p = 3, per hour']];
  $('depth-table').innerHTML = '<tr><th>QAOA</th><th>P(top 5)</th><th>× random</th><th>P(feasible)</th><th>training evals</th></tr>' +
    rows.map(([k, n]) => `<tr><td>${n}</td><td>${(d[k].p_top * 100).toFixed(2)}%</td><td>${(d[k].p_top / d.random.p_top).toFixed(1)}×</td><td>${(d[k].p_feasible * 100).toFixed(1)}%</td><td>${d[k].training_calls.toLocaleString('en-US')}</td></tr>`).join('') +
    `<tr><td>random guess</td><td>${(d.random.p_top * 100).toFixed(2)}%</td><td>1.0×</td><td>${(d.random.p_feasible * 100).toFixed(1)}%</td><td>0</td></tr>`;
  // noise (benchmark day only)
  const nz = pre.scenarios.benchmark.noise;
  if (nz) {
    const names = [['ideal', 'Ideal'], ['forte_like', 'Forte-like'], ['aria_like', 'Aria-like'], ['random', 'Random guess']];
    $('noise-table').innerHTML = '<tr><th>Model</th>' + nz.ideal.map((r) => `<th>h${r.hour} P(top 5)</th><th>h${r.hour} P(feasible)</th>`).join('') + '</tr>' +
      names.map(([k, n]) => `<tr><td>${n}</td>` + nz[k].map((r) => `<td>${(r.p_top * 100).toFixed(2)}%</td><td>${(r.p_feasible * 100).toFixed(1)}%</td>`).join('') + '</tr>').join('');
  }
  renderTrace();
}

function renderTrace() {
  if (!S.run) return;
  const t = +$('trace-hour').value, H = S.run.hours[t];
  const M = [['qaoa', 'QAOA', '#4fd1ff'], ['annealing', 'Annealing', '#ffb347'], ['random', 'Random', '#9fb0c3']];
  const series = M.map(([k, n, c]) => ({ name: n, color: c, noDots: true, points: H.traces[k].map((v, i) => [i + 1, v]) }));
  if (!series.some((s) => s.points.some((p) => p[1] != null))) { $('trace-chart').textContent = 'No feasible plan was found within the budget this hour.'; return; }
  lineChart($('trace-chart'), series, {
    xLabel: 'Evaluations spent (QAOA pays for training first)', yLabel: '$/h', yFmt: (v) => '$' + Math.round(v).toLocaleString('en-US'),
    xs: [1, Math.round(S.run.params.budget / 2), S.run.params.budget], refs: [{ y: H.best_cost, label: `cheapest plan ${money(H.best_cost)}`, color: '#7cf0b0' }],
    label: `Best feasible cost found per evaluation at hour ${t + 1}`,
  });
  const fin = (k) => H.traces[k].filter((v) => v != null).slice(-1)[0];
  $('trace-note').textContent = `Hour ${t + 1}, best found: QAOA ${money(fin('qaoa'))}, annealing ${money(fin('annealing'))}, random ${money(fin('random'))}; cheapest plan ${money(H.best_cost)}. QAOA's first ${S.run.training.per_hour_charge} evaluations are its share of training (${S.run.training.calls} circuit evaluations on hour ${S.run.training.hour}, spread over 24 hours). Shots came from: ${H.source}.`;
}

/** The hour where the trained circuit beats random guessing by the most (the lab opens there and says so). */
function showcaseHour(res) {
  let best = 0, bv = -1;
  res.hours.forEach((H, t) => {
    const nf = H.cost.filter((c) => c != null).length;
    if (nf < 8) return; // peak hours with a handful of feasible plans make degenerate charts
    const v = Q.probs(H.E, H.gammas, H.betas)[H.best_plan] * 1024;
    if (v > bv) { bv = v; best = t; }
  });
  return best;
}

// ---------- views & run ----------
function showView(v) {
  document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
  ['world', 'lab', 'race', 'method'].forEach((k) => { $('view-' + k).hidden = k !== v; });
  if (v === 'lab') renderLab();
  if (v === 'race') renderRace();
  if (v === 'world') world.resize();
}

function params() {
  return {
    scenario: $('in-scenario').value, demand_shift: +$('in-shift').value / 100, solar_peak: +$('in-solar').value,
    p: +$('in-p').value, budget: +$('in-budget').value, shots: +$('in-shots').value, seed: 7,
  };
}

async function runDay() {
  const btn = $('btn-run');
  btn.disabled = true; play(false);
  const pr = params();
  status(`Running the day: training QAOA (p = ${pr.p}), sampling 24 hours on ${S.liveBackend ? (S.init.backend || 'the simulator') : 'the ideal simulator'}, scoring and stitching…`);
  try {
    let res;
    try {
      res = await bridge.call('run', { ...pr, use_backend: S.liveBackend });
    } catch (e) {
      if (!S.liveBackend) throw e;
      console.log('backend run failed, falling back to the ideal simulator: ' + e);
      S.liveBackend = false;
      res = await bridge.call('run', { ...pr, use_backend: false });
      status('The selected backend accepts no more jobs in this run (IonQ allows one per run); this run used the ideal simulator.', true);
    }
    S.run = res;
    if (S.init.ionq) S.liveBackend = false; // IonQ: one job per run, already spent
    if (!$('status').classList.contains('err')) status(`Done in ${res.seconds}s · backend ${res.params.backend} · QAOA ${money(res.schedules.qaoa.total)} vs optimum ${money(res.schedules.exact ? res.schedules.exact.total : null)}.`);
    $('m-exact').textContent = res.schedules.exact ? money(res.schedules.exact.total) : '-';
    renderCosts(); renderHour();
    $('lab-hour').innerHTML = $('trace-hour').innerHTML = res.hours.map((h, t) => `<option value="${t}">${hh(t)} · ${mw(res.day.net[t])}</option>`).join('');
    S.labHour = showcaseHour(res);
    $('lab-hour').value = S.labHour; $('trace-hour').value = S.labHour;
    if (!$('view-lab').hidden) renderLab(true);
    if (!$('view-race').hidden) renderRace();
    narrate(`Run finished. QAOA schedule costs ${money(res.schedules.qaoa.total)}.`);
  } catch (e) {
    status('Run failed: ' + (e && e.message ? e.message : e), true);
    console.log(String(e && e.stack ? e.stack : e));
  } finally {
    btn.disabled = false;
  }
}

function wire() {
  document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => showView(b.dataset.view); });
  const sel = $('in-scenario');
  sel.innerHTML = Object.entries(S.init.scenarios).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  sel.onchange = () => { $('in-solar').value = S.init.scenarios[sel.value].solar_peak; $('in-solar').dispatchEvent(new Event('input')); };
  $('in-shift').oninput = () => { $('out-shift').textContent = `${$('in-shift').value}%`; };
  $('in-solar').oninput = () => { $('out-solar').textContent = `${$('in-solar').value} MW`; };
  $('btn-run').onclick = runDay;
  $('src-buttons').innerHTML = SOURCES.map(([k, n]) => `<button type="button" data-src="${k}" aria-pressed="${k === S.src}">${n}</button>`).join('');
  $('src-buttons').onclick = (e) => {
    const b = e.target.closest('button'); if (!b || !S.run || !S.run.schedules[b.dataset.src]) return;
    S.src = b.dataset.src;
    document.querySelectorAll('#src-buttons button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderCosts(); renderHour();
  };
  $('plant-buttons').innerHTML = units.map((u, i) => `<button type="button" aria-pressed="false">G${u.id}</button>`).join('');
  $('plant-buttons').querySelectorAll('button').forEach((b, i) => { b.onclick = () => select(S.sel === i ? null : i); });
  $('btn-play').onclick = () => play(!S.playing);
  document.querySelectorAll('.speed').forEach((b) => {
    b.onclick = () => {
      S.speed = +b.dataset.speed;
      document.querySelectorAll('.speed').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      if (S.playing) play(true);
    };
  });
  $('in-hour').oninput = () => setHour(+$('in-hour').value - 1);
  $('world').addEventListener('keydown', (e) => { if (e.key === ' ') { e.preventDefault(); play(!S.playing); } });
  $('cam-reset').onclick = () => world.reset();
  $('cam-fly').onclick = () => world.flyTo(S.sel ?? 0);
  $('btn-super').onclick = () => toggleSuper(!S.superpos);
  $('btn-measure').onclick = measureOne;
  $('btn-unmeasure').onclick = () => { S.measured = null; $('sp-result').textContent = ''; applySuperposition(); };
  $('lab-hour').onchange = () => { S.labHour = +$('lab-hour').value; renderLab(true); };
  const fromSliders = () => { S.labAngles = { gi: +$('lab-g').value, bi: +$('lab-b').value, trained: false }; drawLand(); drawDist(); };
  $('lab-g').oninput = fromSliders; $('lab-b').oninput = fromSliders;
  $('lab-land').onclick = (e) => {
    const r = e.target.getBoundingClientRect();
    const gi = Math.min(19, Math.floor((e.clientX - r.left) / r.width * 20)), bi = 19 - Math.min(19, Math.floor((e.clientY - r.top) / r.height * 20));
    S.labAngles = { gi, bi, trained: false }; drawLand(); drawDist();
  };
  $('lab-trained').onclick = () => { S.labAngles = { ...S.labAngles, trained: true }; drawLand(); drawDist(); };
  document.querySelectorAll('.race-sc').forEach((b) => {
    b.onclick = () => { S.raceSc = b.dataset.sc; document.querySelectorAll('.race-sc').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); renderRace(); };
  });
  $('trace-hour').onchange = renderTrace;
  const ion = S.init.ionq;
  $('backend-note').textContent = S.init.backend
    ? `Backend: ${S.init.backend}. ${ion ? 'IonQ takes one job per run: the first run packs the two peak hours into one 20-qubit circuit; later runs use the ideal simulator.' : 'Every hour is sampled on it.'}`
    : 'Backend: ideal statevector (local development).';
}

export async function start(b) {
  bridge = b;
  status('Loading the engine (Python + Qiskit in your browser)…');
  S.init = await bridge.call('init', {});
  units = S.init.units;
  world = createWorld($('world'), units, { onSelect: (i) => select(i), reducedMotion: reduced });
  wire();
  status('Engine ready. Running the benchmark day…');
  await runDay();
}

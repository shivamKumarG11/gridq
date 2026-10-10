// Small SVG chart helpers (no chart library: nothing to fetch, every chart has a text twin).
const NS = 'http://www.w3.org/2000/svg';

export function svgEl(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

/** Timeline area: net load (filled), gross demand (dashed when solar is present), playhead. */
export function timeline(svg, day, hour) {
  svg.replaceChildren();
  const W = 1000, H = 70, max = Math.max(...day.gross) * 1.05;
  const x = (t) => (t + 0.5) / 24 * W, y = (v) => H - v / max * (H - 6);
  const pts = day.net.map((v, t) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`);
  svgEl('path', { d: `M0,${H} L${pts.join(' L')} L${W},${H} Z`, fill: '#12324a' }, svg);
  svgEl('path', { d: `M${pts.join(' L')}`, fill: 'none', stroke: '#4fd1ff', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }, svg);
  if (day.solar.some((s) => s > 0)) {
    const g = day.gross.map((v, t) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`);
    svgEl('path', { d: `M${g.join(' L')}`, fill: 'none', stroke: '#ffb347', 'stroke-width': 1.5, 'stroke-dasharray': '5 4', 'vector-effect': 'non-scaling-stroke' }, svg);
  }
  svgEl('line', { x1: x(hour), x2: x(hour), y1: 0, y2: H, stroke: '#ffb347', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }, svg);
}

/**
 * Line chart. series: [{name, color, points: [[x, y]...], band?: [[x, lo, hi]...], dash?}].
 * opts: {xs (tick values), xLog2, yFmt, xFmt, xLabel, yLabel, refs: [{y, label, color}]}
 */
export function lineChart(el, series, opts = {}) {
  const W = 640, H = 300, L = 62, R = 16, T = 16, B = 44;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.label || 'chart' });
  const all = series.flatMap((s) => [...s.points.map((p) => p[1]), ...(s.band || []).flatMap((b) => [b[1], b[2]])]).filter((v) => v != null);
  (opts.refs || []).forEach((r) => all.push(r.y));
  let lo = Math.min(...all), hi = Math.max(...all);
  if (opts.yMin != null) lo = Math.min(lo, opts.yMin);
  const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
  const xv = series.flatMap((s) => s.points.map((p) => p[0]));
  const fx = opts.xLog2 ? Math.log2 : (v) => v;
  const x0 = fx(Math.min(...xv)), x1 = fx(Math.max(...xv));
  const X = (v) => L + (fx(v) - x0) / ((x1 - x0) || 1) * (W - L - R);
  const Y = (v) => T + (hi - v) / (hi - lo) * (H - T - B);
  const yf = opts.yFmt || ((v) => v.toFixed(1));
  for (let k = 0; k <= 4; k++) {
    const v = lo + (hi - lo) * k / 4;
    svgEl('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: '#1d2937' }, svg);
    svgEl('text', { x: L - 8, y: Y(v) + 4, fill: '#9fb0c3', 'font-size': 11, 'text-anchor': 'end', 'font-family': 'IBM Plex Mono, monospace' }, svg).textContent = yf(v);
  }
  (opts.xs || [...new Set(xv)]).forEach((v) => {
    svgEl('text', { x: X(v), y: H - B + 18, fill: '#9fb0c3', 'font-size': 11, 'text-anchor': 'middle', 'font-family': 'IBM Plex Mono, monospace' }, svg).textContent = opts.xFmt ? opts.xFmt(v) : v;
  });
  if (opts.xLabel) svgEl('text', { x: (L + W - R) / 2, y: H - 6, fill: '#c5d2e0', 'font-size': 12, 'text-anchor': 'middle' }, svg).textContent = opts.xLabel;
  if (opts.yLabel) {
    const t = svgEl('text', { x: 14, y: (T + H - B) / 2, fill: '#c5d2e0', 'font-size': 12, 'text-anchor': 'middle', transform: `rotate(-90 14 ${(T + H - B) / 2})` }, svg);
    t.textContent = opts.yLabel;
  }
  (opts.refs || []).forEach((r) => {
    svgEl('line', { x1: L, x2: W - R, y1: Y(r.y), y2: Y(r.y), stroke: r.color, 'stroke-dasharray': '6 4', 'stroke-width': 1.5 }, svg);
    const left = r.align === 'left';
    svgEl('text', { x: left ? L + 6 : W - R - 4, y: Y(r.y) - 5, fill: r.color, 'font-size': 11, 'text-anchor': left ? 'start' : 'end' }, svg).textContent = r.label;
  });
  series.forEach((s) => {
    if (s.band) {
      const up = s.band.filter((b) => b[1] != null).map((b) => `${X(b[0])},${Y(b[2])}`);
      const dn = s.band.filter((b) => b[1] != null).map((b) => `${X(b[0])},${Y(b[1])}`).reverse();
      if (up.length > 1) svgEl('path', { d: `M${up.join(' L')} L${dn.join(' L')} Z`, fill: s.color, opacity: 0.12 }, svg);
    }
    const pts = s.points.filter((p) => p[1] != null);
    if (!pts.length) return;
    svgEl('path', { d: `M${pts.map((p) => `${X(p[0])},${Y(p[1])}`).join(' L')}`, fill: 'none', stroke: s.color, 'stroke-width': s.width || 2.5, 'stroke-dasharray': s.dash || '' }, svg);
    if (!s.noDots) pts.forEach((p) => svgEl('circle', { cx: X(p[0]), cy: Y(p[1]), r: 3.5, fill: s.color }, svg));
  });
  el.replaceChildren(svg);
  return svg;
}

/** Sequential colour for heatmaps: dark slate (high cost) -> power cyan (low cost). */
export function ramp(t) {
  t = Math.max(0, Math.min(1, t));
  const r = Math.round(26 + t * (79 - 26)), g = Math.round(37 + t * (209 - 37)), b = Math.round(50 + t * (255 - 50));
  return `rgb(${r},${g},${b})`;
}

/** Diverging colour for J weights / correlations. */
export function diverge(v, max) {
  const t = Math.max(-1, Math.min(1, v / (max || 1)));
  return t >= 0 ? `hsl(195, 90%, ${12 + 50 * t}%)` : `hsl(35, 95%, ${12 + 50 * -t}%)`;
}

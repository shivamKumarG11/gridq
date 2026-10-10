// The in-page simulator (ui/qsim.js) must agree with engine/qaoa.py, which is itself tested against
// Qiskit's Statevector. Fixture: python tests/make_fixture.py
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Q from '../ui/qsim.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/qaoa_case.json', import.meta.url)));

test('probabilities match the Python statevector', () => {
  const p = Q.probs(fx.E, fx.gammas, fx.betas);
  let worst = 0;
  for (let k = 0; k < Q.PLANS; k++) worst = Math.max(worst, Math.abs(p[k] - fx.probs[k]));
  assert.ok(worst < 1e-12, `max |diff| ${worst}`);
});

test('marginals and correlations are consistent', () => {
  const p = Q.probs(fx.E, fx.gammas, fx.betas);
  const on = Q.marginals(p);
  on.forEach((v, i) => assert.ok(Math.abs(v - fx.p_on[i]) < 1e-12));
  const c = Q.correlations(p);
  assert.equal(c.length, 45);
  c.forEach(({ c: v }) => assert.ok(v >= -1 - 1e-12 && v <= 1 + 1e-12));
});

test('plan labels put G1 first', () => {
  assert.equal(Q.labelOf(0b1000000011), '1100000001');
});

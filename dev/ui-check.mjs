// Drives the dev page in headless Edge: waits for the first run, visits every view, clicks through the
// main interactions, collects console errors and saves screenshots to dev/shots/.
//   node dev/ui-check.mjs [http://localhost:8765]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:8765';
const W = +(process.env.W ?? 1440), H = +(process.env.H ?? 1000);
mkdirSync('dev/shots', { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGE ERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });
const t0 = Date.now();
await page.goto(BASE);
await page.waitForFunction(() => /Done in|failed/.test(document.getElementById('status').textContent), null, { timeout: 180000 });
console.log('status:', await page.locator('#status').innerText(), `(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
console.log('costs:', (await page.locator('#cost-list').innerText()).replace(/\n/g, ' | '));
await page.waitForTimeout(1500);
const tag = W < 900 ? '-mobile' : '';
await page.screenshot({ path: `dev/shots/1-world${tag}.png`, fullPage: true });
if (W >= 900) {
  await page.locator('#in-hour').fill('20');
  await page.locator('#plant-buttons button').nth(5).click();
  await page.waitForTimeout(1200);
  console.log('changed:', await page.locator('#changed').innerText());
  await page.screenshot({ path: 'dev/shots/2-world-h20-selected.png' });
  await page.getByRole('button', { name: 'Superposition mode' }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'dev/shots/3-superposition.png' });
  await page.getByRole('button', { name: 'Measure one shot' }).click();
  await page.waitForFunction(() => document.getElementById('sp-result').textContent.length > 0, null, { timeout: 30000 });
  console.log('shot:', await page.locator('#sp-result').innerText());
  await page.getByRole('button', { name: 'Superposition mode' }).click();
  await page.getByRole('button', { name: 'Exact MILP' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Quantum Lab', exact: true }).click();
  await page.waitForTimeout(1500);
  console.log('lab:', await page.locator('#lab-pbest').innerText(), '| feasible', await page.locator('#lab-pfeas').innerText());
  await page.screenshot({ path: 'dev/shots/4-lab.png', fullPage: true });
  await page.getByRole('button', { name: 'The race', exact: true }).click();
  await page.waitForTimeout(800);
  console.log('race:', (await page.locator('#race-summary').innerText()).replace(/\n/g, ' | '));
  await page.screenshot({ path: 'dev/shots/5-race.png', fullPage: true });
  await page.getByRole('button', { name: 'Method', exact: true }).click();
  await page.screenshot({ path: 'dev/shots/6-method.png', fullPage: true });
}
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();

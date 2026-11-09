// Browser regression for chair interaction. Start npm run dev first.
// LAB_URL overrides the standalone server (default http://127.0.0.1:5173).
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findChromium, playwright } from './env.mjs';
async function verifySeating(page) {
  const checks = [];
  const check = (ok, label, detail) => {
    if (!ok) throw new Error(`${label}: ${JSON.stringify(detail)}`);
    checks.push(label);
  };
  await page.getByTestId('station-sample-prep').click({ timeout: 60000 });
  await page.waitForFunction(() => window.__lab?.ready && document.querySelector('[data-testid=seat-toggle]'), null, { timeout: 60000 });
  const state = () => page.evaluate(() => {
    const w = window.__lab;
    return { seated: w.seated, mode: w.mode, player: w.player.toArray(), yaw: w.yaw, action: w.debugInfo().seatAction };
  });
  const standing = await state();
  check(!standing.seated && standing.action === 'sit', 'Nearby chair offers sitting', standing);
  await page.getByTestId('seat-toggle').click();
  const seated = await state();
  check(seated.seated && seated.player[1] < standing.player[1], 'Button seats player at a lower viewpoint', seated);
  await page.getByTestId('seat-toggle').filter({ hasText: 'Stand up' }).waitFor({ timeout: 60000 });
  await page.screenshot({ path: 'output/playwright/seated-desktop.png' });
  await page.keyboard.down('w');
  await page.waitForTimeout(350);
  await page.keyboard.up('w');
  await page.locator('canvas.lab-canvas').dispatchEvent('wheel', { deltaY: -100 });
  const still = await state();
  check(JSON.stringify(still.player) === JSON.stringify(seated.player), 'Walking and scrolling keep the seated player in place', still);
  await page.locator('canvas.lab-canvas').dispatchEvent('pointerdown', { clientX: 400, clientY: 350 });
  await page.locator('canvas.lab-canvas').dispatchEvent('pointermove', { movementX: 10, movementY: 0 });
  await page.locator('canvas.lab-canvas').dispatchEvent('pointerup', { clientX: 420, clientY: 350 });
  check((await state()).yaw !== seated.yaw && (await state()).seated, 'Looking remains available while seated', await state());
  await page.keyboard.press('Space');
  const stood = await state();
  check(!stood.seated && stood.player[1] === standing.player[1] && Math.hypot(stood.player[0] - standing.player[0], stood.player[2] - standing.player[2]) < 0.1, 'Space restores safe standing position and calibrated height', stood);
  await page.keyboard.press('e');
  check((await state()).seated, 'E seats the player', await state());
  await page.keyboard.press('e');
  check(!(await state()).seated, 'E stands the player up', await state());
  await page.getByTestId('seat-toggle').click();
  await page.getByRole('button', { name: 'Free fly', exact: true }).click();
  check(!(await state()).seated && (await state()).mode === 'free', 'Switching to fly clears seated state', await state());
  await page.getByTestId('seat-toggle').waitFor({ state: 'hidden', timeout: 60000 });
  check(await page.getByTestId('seat-toggle').count() === 0, 'Sitting control is hidden in fly mode');
  await page.getByRole('button', { name: 'Walk POV', exact: true }).click();
  const reachability = await page.evaluate(() => {
    const w = window.__lab;
    return w.lab.ctx.seats.map((seat, index) => {
      let result = null;
      for (let i = 0; i < 16 && !result; i++) {
        const angle = seat.yaw + i * Math.PI / 8;
        const p = seat.position.clone();
        p.x += Math.sin(angle) * 0.8;
        p.z += Math.cos(angle) * 0.8;
        p.y = 1.4;
        w.nav.resolve(p, w.lab.doors);
        w.setView(p, { x: seat.position.x, y: 0.8, z: seat.position.z });
        if (w.sitDown(seat)) {
          const position = w.player.toArray();
          const facing = Math.abs(Math.sin(w.yaw - seat.yaw)) < 0.001;
          w.standUp();
          result = { position, facing, stood: !w.seated, height: w.player.y };
        }
      }
      return { index, zone: seat.zone, chair: seat.position.toArray(), result };
    });
  });
  check(reachability.length === 35 && reachability.every(s => s.result?.facing && s.result?.stood && s.result?.height === 1.4), 'All 35 chairs support sitting and standing, including generated desks', reachability.filter(s => !s.result));
  await page.evaluate(() => {
    const w = window.__lab;
    w.setView({ x: -1.62, y: 1.4, z: -0.55 }, { x: -1.65, y: 0.7, z: -0.98 });
  });
  const chairPoint = await page.evaluate(() => {
    const w = window.__lab;
    const p = w.lab.ctx.seats[0].position.clone();
    p.y = 0.7;
    p.project(w.camera);
    const r = w.renderer.domElement.getBoundingClientRect();
    return { x: r.x + (p.x + 1) * r.width / 2, y: r.y + (1 - p.y) * r.height / 2 };
  });
  await page.mouse.click(chairPoint.x, chairPoint.y);
  check((await state()).seated, 'Clicking the chair seats the player', await state());
  await page.keyboard.press('e');
  await page.evaluate(() => {
    const w = window.__lab;
    w.setView({ x: -3.05, y: 1.4, z: 0.12 }, { x: 4.3, y: 1.28, z: 0 });
  });
  await page.getByTestId('seat-toggle').waitFor({ state: 'hidden', timeout: 60000 });
  check(await page.getByTestId('seat-toggle').count() === 0, 'Sitting control is hidden away from chairs');
  const blocked = await page.evaluate(() => {
    const w = window.__lab;
    const seat = w.lab.ctx.seats[0];
    const acrossBench = seat.position.clone();
    acrossBench.z = -1.6;
    acrossBench.y = 1.4;
    w.setView(acrossBench, seat.position);
    // setView now finds a clear spawn; deliberately restore the obstructed
    // fixture here to exercise the interaction's own path guard.
    w.player.copy(acrossBench);
    return w.sitDown(seat);
  });
  check(!blocked, 'Sitting cannot cross an obstructing bench');
  await page.evaluate(() => {
    const w = window.__lab;
    w.setView({ x: -1.62, y: 1.4, z: -0.55 }, { x: -1.65, y: 0.9, z: -1.3 });
  });
  await page.getByTestId('seat-toggle').click();
  await page.setViewportSize({ width: 760, height: 820 });
  await page.screenshot({ path: 'output/playwright/seated-compact.png' });
  const layout = await page.getByTestId('seat-toggle').evaluate(el => {
    const r = el.getBoundingClientRect();
    const target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { visible: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, receivesPointer: target === el || el.contains(target) };
  });
  check(layout.visible && layout.receivesPointer, 'Compact seated control is visible and clickable', layout);
  await page.setViewportSize({ width: 1280, height: 720 });
  return { checks, reachability, layout };
}

const out = resolve('output/playwright');
mkdirSync(out, { recursive: true });
const { chromium } = playwright();
const browser = await chromium.launch({ executablePath: findChromium() });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.LAB_URL ?? 'http://127.0.0.1:5173', { waitUntil: 'domcontentloaded' });
  const report = await verifySeating(page);
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  writeFileSync(resolve(out, 'seating-report.json'), JSON.stringify({ ...report, errors }, null, 2));
  console.log(`PASS: ${report.checks.length} seating checks; ${report.reachability.length} chairs. Report: output/playwright/seating-report.json`);
} finally {
  await browser.close();
}

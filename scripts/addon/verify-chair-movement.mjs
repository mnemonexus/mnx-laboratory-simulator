// Start the standalone dev server first; LAB_URL overrides its URL.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { findChromium, playwright } from './env.mjs'

mkdirSync('output/playwright', { recursive: true })
const { chromium } = playwright()
const browser = await chromium.launch({ executablePath: findChromium() })
const checks = []
const check = (value, label) => { assert.ok(value, label); checks.push(label) }
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.setDefaultTimeout(60000)
  await page.goto(process.env.LAB_URL ?? 'http://127.0.0.1:5173', { waitUntil: 'domcontentloaded' })
  await page.getByTestId('station-sample-prep').click()
  await page.getByTestId('chair-actions').waitFor()
  const snapshot = () => page.evaluate(() => {
    const w = window.__lab, s = w.lab.ctx.seats[0]
    // each chair is a part of its room's rigid batches (one per material)
    const meshPosition = s.instances.map(({ mesh, index }) => {
      const matrix = new (w.camera.matrix.constructor)()
      mesh.getMatrixAt(index, matrix)
      return Array.from(matrix.elements.slice(12, 15))
    })
    return { position: s.position.toArray(), offset: s.offset, collider: { ...s.collider }, player: w.player.toArray(), seated: w.seated, meshPosition, action: w.debugInfo().seatAction }
  })
  const before = await snapshot()
  const probeBefore = await page.evaluate(() => {
    const w = window.__lab, p = w.lab.ctx.seats[0].home.clone()
    p.z += 0.3
    const q = p.clone(); w.nav.resolve(q, w.lab.doors)
    return p.distanceTo(q)
  })
  await page.getByTestId('chair-actions').click()
  check(await page.getByTestId('chair-push-in').isVisible() && await page.getByTestId('chair-pull-out').isVisible(), 'Movement actions are disclosed in the chair menu')
  await page.screenshot({ path: 'output/playwright/chair-menu-desktop.png' })
  await page.getByTestId('chair-push-in').click()
  const tucked = await snapshot()
  check(tucked.offset > before.offset && tucked.offset < 0.3, 'Tucking stops at the bench edge before the back clips through it')
  check(tucked.meshPosition.every(p => p.every((v, i) => Math.abs(v - tucked.position[i]) < 0.0001)), 'All chair material and shadow instances move with the seat')
  check(Math.abs((tucked.collider.minZ + tucked.collider.maxZ) / 2 - tucked.position[2]) < 0.0001, 'Walking collider follows the chair')
  const probeAfter = await page.evaluate(() => {
    const w = window.__lab, p = w.lab.ctx.seats[0].home.clone()
    p.z += 0.3
    const q = p.clone(); w.nav.resolve(q, w.lab.doors)
    return p.distanceTo(q)
  })
  check(probeBefore > 0.1 && probeAfter < 0.001, 'Tucking clears the old obstruction from the aisle')
  await page.getByTestId('seat-toggle').filter({ hasText: 'Pull out' }).waitFor()
  await page.getByTestId('seat-toggle').click()
  const pulled = await snapshot()
  check(pulled.offset < 0 && pulled.player[2] > before.player[2], 'Pulling out retrieves the chair and makes room for the standing player')
  await page.getByTestId('seat-toggle').filter({ hasText: 'Sit down' }).waitFor()
  await page.getByTestId('seat-toggle').click()
  const sitting = await snapshot()
  await page.getByTestId('chair-actions').click()
  await page.getByTestId('chair-push-in').click()
  const seatedTucked = await snapshot()
  check(seatedTucked.seated && seatedTucked.offset > sitting.offset && seatedTucked.player[1] === sitting.player[1]
    && Math.abs(seatedTucked.player[2] - seatedTucked.position[2]) < 0.001, 'Seated movement carries the player at the same eye height')
  await page.getByTestId('chair-actions').click()
  check(await page.getByTestId('chair-push-in').count() === 0, 'Blocked movement is hidden at the travel limit')
  await page.getByTestId('chair-pull-out').click()
  await page.keyboard.press('e')
  check(!(await snapshot()).seated, 'Standing still works after moving the occupied chair')
  const allChairs = await page.evaluate(async () => {
    const w = window.__lab
    const result = []
    for (const [index, seat] of w.lab.ctx.seats.entries()) {
      const start = performance.now()
      const inside = w.chairMover.move(seat, 'in')
      const tucked = seat.offset
      const outside = w.chairMover.move(seat, 'out')
      const pulled = seat.offset
      const valid = seat.instances.every(({ mesh, index }) => {
        const matrix = new (w.camera.matrix.constructor)()
        mesh.getMatrixAt(index, matrix)
        const e = matrix.elements
        return Math.abs(e[12] - seat.position.x) < 0.0001 && Math.abs(e[14] - seat.position.z) < 0.0001
      })
      result.push({ index, zone: seat.zone, inside, outside, tucked, pulled, valid, ms: performance.now() - start })
    }
    return result
  })
  check(allChairs.length === 35 && allChairs.every(s => s.valid && (s.inside || s.outside)), 'All 35 chairs move where space permits and keep their instances aligned')
  check(allChairs.filter(s => s.zone === 'C10').every(s => s.tucked > 0.35 && s.outside && s.pulled < s.tucked - 0.15), 'Every generated desk chair can tuck in and pull out between the legs')
  await page.getByTestId('station-plate-reader').click()
  await page.getByTestId('station-sample-prep').click()
  await page.getByTestId('chair-actions').waitFor()
  const returned = await page.evaluate(() => {
    const w = window.__lab
    return { offset: w.lab.ctx.seats[0].offset, clear: w.nav.isClear(w.player, w.lab.doors) }
  })
  check(returned.offset === allChairs[0].pulled && returned.clear, 'Station changes preserve furniture and place the player clear of moved chairs')
  await page.evaluate(() => {
    const w = window.__lab
    w.setView({ x: -1.62, y: 1.4, z: 0.1 }, { x: -1.65, y: 0.8, z: -0.5 })
  })
  await page.setViewportSize({ width: 760, height: 820 })
  await page.getByTestId('chair-actions').click()
  await page.screenshot({ path: 'output/playwright/chair-menu-compact.png' })
  const layout = await page.getByTestId('chair-push-in').evaluate(el => {
    const r = el.getBoundingClientRect(), at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return { inViewport: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, clickable: at === el || el.contains(at) }
  })
  check(layout.inViewport && layout.clickable, 'Compact movement menu is visible and clickable')
  await page.keyboard.press('Escape')
  check(await page.getByTestId('chair-push-in').count() === 0, 'Escape dismisses the movement disclosure')
  check(errors.length === 0, 'No uncaught browser errors')
  writeFileSync('output/playwright/chair-movement-report.json', JSON.stringify({ checks, before, tucked, pulled, allChairs, layout, errors }, null, 2))
  console.log(`PASS: ${checks.length} chair movement checks across ${allChairs.length} chairs.`)
} finally {
  await browser.close()
}

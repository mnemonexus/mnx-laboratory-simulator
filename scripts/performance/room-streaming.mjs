// Memory with every room resident: the lab prepares all rooms behind the loading
// screen, so walking between them uploads nothing. Visits rooms on Low and records
// GPU geometry/texture counts and the preparation time.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { findChromium, playwright, GPU_ARGS, findGpuChromium } from '../addon/env.mjs'
const { chromium } = playwright()
const browser = await chromium.launch({ executablePath: findGpuChromium(), args: GPU_ARGS })
const errors = [], rooms = []
let prepared = null
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  page.setDefaultTimeout(240000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto(process.env.LAB_URL ?? 'http://localhost:5173')
  await page.getByTestId('station-station-selector').click()
  await page.waitForFunction(() => window.__lab?.ready)
  await page.getByRole('button', { name: 'Graphics settings' }).first().dispatchEvent('click')
  await page.locator('[data-preset=low]').dispatchEvent('click')
  await page.getByRole('button', { name: 'Graphics settings' }).first().dispatchEvent('click')
  await page.waitForFunction(() => window.__lab?.ready && window.__lab.settings.detail === 'reduced')
  prepared = await page.evaluate(() => ({ prepareMs: window.__lab.prepareMs, log: window.__lab.debugInfo().bakeLog }))
  for (const zone of ['main', 'cold', 'post', 'C01', 'X05', 'C02', 'X02', 'C07', 'BI04', 'main']) {
    const started = performance.now()
    await page.evaluate(async id => {
      const { ZONES } = await import('/src/three/lab/layout.ts')
      const p = ZONES[id].probe, w = window.__lab
      w.setMode('walk'); w.setView({ x: p[0], y: 1.4, z: p[2] }, { x: p[0] + 1, y: 1.3, z: p[2] })
    }, zone)
    await page.waitForFunction(id => window.__lab.currentZone === id, zone)
    await page.waitForTimeout(300)
    const result = await page.evaluate(() => {
      const w = window.__lab
      return { failed: w.failed, probes: w.debugInfo().probes, geometryBytes: w.renderer.info.memory.attributesSize, geometryCount: w.renderer.info.memory.geometries, textures: w.renderer.info.memory.textures, events: w.debugInfo().bakeLog.length }
    })
    assert.equal(result.failed, false)
    rooms.push({ zone, entryMs: performance.now() - started, ...result })
    console.log(JSON.stringify(rooms.at(-1)))
  }
  assert.ok(rooms.every(r => r.events === rooms[0].events), 'No bake or probe work happens after the world is ready')
  assert.equal(errors.length, 0, errors.join('; '))
} finally {
  mkdirSync('output/performance', { recursive: true })
  writeFileSync('output/performance/room-streaming.json', JSON.stringify({ prepared, rooms, errors, limitation: 'Every room is built, lit, probed and compiled before the world is ready; attributeBytes counts GPU geometry, not total VRAM.' }, null, 2))
  await browser.close()
}

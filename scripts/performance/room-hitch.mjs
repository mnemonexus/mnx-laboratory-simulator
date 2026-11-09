// Room-transition hitch benchmark: walks through every doorway in walk mode and
// records the worst frames while crossing. Never opens the real app-data bridge.
//   node scripts/performance/room-hitch.mjs [--label name] [--presets low,high] [--doors id,id] [--headed]
// Needs the dev server (LAB_URL, default http://localhost:5173). Run it on its own:
// concurrent GPU work on this machine distorts frame times.
import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { findChromium, playwright, GPU_ARGS, findGpuChromium } from '../addon/env.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1] }
const label = option('label', 'hitch-latest')
if (!/^[\w-]+$/.test(label)) throw new Error('Use a simple label')
const presets = option('presets', 'low,high').split(',')
const onlyDoors = option('doors', '')
const HITCH_MS = 25
const out = resolve('output/performance', label)
mkdirSync(out, { recursive: true })
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim()
const report = {
  schema: 'lab-room-hitch/1', createdAt: new Date().toISOString(),
  source: { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain').split('\n').length },
  configuration: { presets, viewport: { width: 1440, height: 960 }, hitchMs: HITCH_MS, url: process.env.LAB_URL ?? 'http://localhost:5173' },
  limitations: ['rAF intervals include GPU stalls but are quantised to the display refresh.', 'The first pass through a door is the one that matters; doors are walked once per preset, in facility order.'],
  results: [], errors: [],
}
const save = () => writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2))
const { chromium } = playwright()
const browser = await chromium.launch({ executablePath: findGpuChromium(), args: GPU_ARGS, headless: !args.includes('--headed') })
try {
  const page = await browser.newPage({ viewport: report.configuration.viewport, deviceScaleFactor: 1 })
  page.setDefaultTimeout(240000)
  page.on('pageerror', e => report.errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error' || args.includes('--verbose')) console.log(`[page ${m.type()}] ${m.text()}`) })
  const opened = performance.now()
  await page.goto(report.configuration.url, { waitUntil: 'domcontentloaded' })
  await page.getByTestId('station-sample-prep').click()
  await page.waitForFunction(() => window.__lab?.ready)
  report.launchToReadyMs = performance.now() - opened
  console.log(`launch to ready: ${Math.round(report.launchToReadyMs)} ms`)
  for (const preset of presets) {
    const started = performance.now()
    // The look-capture surface can sit over the HUD; dispatch the clicks directly.
    await page.getByRole('button', { name: 'Graphics settings' }).first().dispatchEvent('click', {}, { timeout: 20000 })
    await page.locator(`[data-preset=${preset}]`).dispatchEvent('click', {}, { timeout: 20000 })
    await page.getByRole('button', { name: 'Graphics settings' }).first().dispatchEvent('click', {}, { timeout: 20000 })
    console.log(`${preset}: preset chosen, waiting for the world`)
    await page.waitForFunction(p => window.__lab?.ready && !window.__lab.disposed && window.__lab.settings.lighting === p, preset)
    const readyMs = performance.now() - started
    console.log(`${preset}: ready after ${Math.round(readyMs)} ms`)
    await page.evaluate(() => { const w = window.__lab; w.setLive({ ...w.settings, fpsCap: 0, minDynamicScale: 1 }); w.dynScale = 1; w.resize() })
    // let the station's opening camera move finish before taking over the view
    await page.waitForTimeout(3000)
    const doors = await page.evaluate(only => {
      const w = window.__lab, keep = only ? new Set(only.split(',')) : null
      return w.lab.doors.filter(d => d.def.propped === undefined || d.def.kind === 'opening')
        .map(d => ({ id: d.def.id, a: d.def.a, b: d.def.b, center: d.def.center, normal: d.def.normal, oneWay: !!d.def.oneWay }))
        .filter((d, i, all) => all.findIndex(o => o.id === d.id) === i && (!keep || keep.has(d.id)))
    }, onlyDoors)
    console.log(`${preset}: ${doors.length} doors`)
    const transitions = []
    for (const door of doors) {
      const result = await page.evaluate(async d => {
        const w = window.__lab
        const frames = n => new Promise(r => { let i = 0; const step = () => (++i >= n ? r() : requestAnimationFrame(step)); requestAnimationFrame(step) })
        // Start 1.7 u before the doorway on side a (one-way doors only open from a).
        const start = { x: d.center[0] - d.normal[0] * 1.7, y: 1.4, z: d.center[1] - d.normal[1] * 1.7 }
        const end = { x: d.center[0] + d.normal[0] * 1.7, y: 1.4, z: d.center[1] + d.normal[1] * 1.7 }
        w.setMode('walk')
        w.setView(start, { x: end.x, y: 1.35, z: end.z })
        const stop = w.addFrameHook(() => { w.requestRender(); return false })
        const log0 = w.debugInfo().bakeLog.length
        try {
          console.log(`door ${d.id}: settling`)
          await frames(90)
          console.log(`door ${d.id}: walking from ${w.currentZone}`)
          const from = w.currentZone
          w.startPerformanceCapture(6000)
          w.pressed.add('w')
          const t0 = performance.now()
          while (performance.now() - t0 < 3400) {
            await frames(1)
            const dx = w.player.x - end.x, dz = w.player.z - end.z
            if (dx * dx + dz * dz < 0.04) break
          }
          w.pressed.delete('w')
          await frames(45)
          const capture = w.endPerformanceCapture()
          const intervals = []
          // rows follow FRAME_COLUMNS: [timestampMs, rafIntervalMs, frameCpuMs, drawCpuMs, …]
          for (const row of capture?.rows ?? []) if (row[1] > 0) intervals.push(row[1])
          return { reached: w.currentZone, from, intervals, summary: capture?.summary ?? null, events: w.debugInfo().bakeLog.slice(log0), failed: w.failed }
        } finally { w.pressed.delete('w'); stop(); w.endPerformanceCapture() }
      }, door)
      const sorted = result.intervals.slice().sort((a, b) => a - b)
      const pct = p => sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null
      const entry = { door: door.id, a: door.a, b: door.b, from: result.from, reached: result.reached, crossed: result.reached === door.b,
        frames: sorted.length, medianMs: pct(0.5), p99Ms: pct(0.99), maxMs: sorted.at(-1) ?? null,
        hitches: result.intervals.filter(v => v > HITCH_MS).length, events: result.events }
      transitions.push(entry)
      console.log(`${preset} ${door.id} ${door.a}->${door.b}: max ${entry.maxMs?.toFixed(1)} ms, p99 ${entry.p99Ms?.toFixed(1)}, hitches ${entry.hitches}${entry.crossed ? '' : ' (did not cross)'}${entry.events.length ? `, events: ${entry.events.join(' | ')}` : ''}`)
      if (result.failed) throw new Error(`World failed at ${door.id}`)
    }
    const worst = transitions.reduce((m, t) => Math.max(m, t.maxMs ?? 0), 0)
    const hitchy = transitions.filter(t => t.hitches > 0).length
    report.results.push({ preset, readyMs, worstMs: worst, transitionsWithHitches: hitchy, doors: transitions.length, notCrossed: transitions.filter(t => !t.crossed).map(t => t.door), transitions })
    save()
    console.log(`${preset}: ready ${Math.round(readyMs)} ms, worst ${worst.toFixed(1)} ms, ${hitchy}/${transitions.length} transitions with frames > ${HITCH_MS} ms`)
  }
  if (report.errors.length) throw new Error(report.errors.join('; '))
} finally { save(); await browser.close() }
console.log(`Report: ${resolve(out, 'report.json')}`)

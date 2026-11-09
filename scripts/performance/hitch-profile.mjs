// Profiles walking through chosen doorways: worst frames (CPU vs GPU-bound),
// and the functions with the most self time while walking.
//   node scripts/performance/hitch-profile.mjs [--doors post,d-hub-c02] [--preset high]
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { findGpuChromium, playwright, GPU_ARGS } from '../addon/env.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1] }
const doors = option('doors', 'post,d-hub-c02').split(',')
const preset = option('preset', 'high')
const out = resolve('output/performance/hitch-profile')
mkdirSync(out, { recursive: true })
const { chromium } = playwright()
const browser = await chromium.launch({ executablePath: findGpuChromium(), args: GPU_ARGS })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  page.setDefaultTimeout(300000)
  page.on('pageerror', e => console.log(`[page error] ${e.message.slice(0, 300)}`))
  page.on('console', m => { if (m.type() === 'error') console.log(`[console error] ${m.text().slice(0, 300)}`) })
  await page.goto(process.env.LAB_URL ?? 'http://localhost:5173', { waitUntil: 'domcontentloaded' })
  await page.getByTestId('station-sample-prep').click()
  await page.waitForFunction(() => window.__lab?.ready)
  if (await page.evaluate(() => window.__lab.settings.lighting) !== preset) {
    await page.getByRole('button', { name: 'Graphics settings' }).first().dispatchEvent('click')
    await page.locator(`[data-preset=${preset}]`).dispatchEvent('click')
    await page.getByRole('button', { name: 'Graphics settings' }).first().dispatchEvent('click')
    await page.waitForFunction(p => window.__lab?.ready && !window.__lab.disposed && window.__lab.settings.lighting === p, preset)
  }
  await page.evaluate(() => { const w = window.__lab; w.setLive({ ...w.settings, fpsCap: 0, minDynamicScale: 1 }); w.dynScale = 1; w.resize() })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  for (const id of doors) {
    const door = await page.evaluate(id => { const d = window.__lab.lab.doors.find(r => r.def.id === id)?.def; return d && { center: d.center, normal: d.normal } }, id)
    if (!door) { console.log(`no door ${id}`); continue }
    await page.evaluate(d => {
      const w = window.__lab
      w.setMode('walk')
      w.setView({ x: d.center[0] - d.normal[0] * 1.7, y: 1.4, z: d.center[1] - d.normal[1] * 1.7 }, { x: d.center[0] + d.normal[0] * 1.7, y: 1.35, z: d.center[1] + d.normal[1] * 1.7 })
      window.__hitchStop = w.addFrameHook(() => { w.requestRender(); return false })
    }, door)
    await page.waitForTimeout(1500)
    await cdp.send('Profiler.start')
    const frames = await page.evaluate(async d => {
      const w = window.__lab
      const end = { x: d.center[0] + d.normal[0] * 1.7, z: d.center[1] + d.normal[1] * 1.7 }
      w.startPerformanceCapture(4000)
      w.pressed.add('w')
      const t0 = performance.now()
      while (performance.now() - t0 < 3400) {
        await new Promise(requestAnimationFrame)
        if ((w.player.x - end.x) ** 2 + (w.player.z - end.z) ** 2 < 0.04) break
      }
      w.pressed.delete('w')
      for (let i = 0; i < 30; i++) await new Promise(requestAnimationFrame)
      const capture = w.endPerformanceCapture()
      window.__hitchStop()
      // rows: [timestampMs, rafIntervalMs, frameCpuMs, drawCpuMs, renderIntervalMs, drawCalls, triangles]
      return capture.rows.filter(r => r[1] > 20).map(r => ({ at: Math.round(r[0] - t0), interval: r[1], cpu: r[2], draw: r[3], calls: r[5] }))
    }, door)
    const { profile } = await cdp.send('Profiler.stop')
    writeFileSync(resolve(out, `${id}.cpuprofile`), JSON.stringify(profile))
    const nodes = new Map(profile.nodes.map(n => [n.id, n]))
    const self = new Map()
    for (let i = 0; i < profile.samples.length; i++) {
      const f = nodes.get(profile.samples[i]).callFrame
      const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`
      self.set(key, (self.get(key) ?? 0) + profile.timeDeltas[i] / 1000)
    }
    const top = [...self.entries()].filter(([k]) => !/^\((idle|program|garbage collector)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 18)
    console.log(`\n${id}: slow frames (interval, cpu, draw ms): ${frames.map(f => `${f.at}ms ${f.interval.toFixed(0)}/${f.cpu.toFixed(1)}/${f.draw.toFixed(1)}`).join('  ')}`)
    console.log(top.map(([k, v]) => `  ${v.toFixed(1).padStart(7)} ms  ${k}`).join('\n'))
    const gc = [...self.entries()].filter(([k]) => /garbage|program/.test(k)).map(([k, v]) => `${k} ${v.toFixed(0)}ms`).join(', ')
    console.log(`  (${gc})`)
  }
} finally { await browser.close() }

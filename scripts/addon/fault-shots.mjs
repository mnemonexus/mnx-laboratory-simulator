// Fixed viewpoints of the faults the owner reported on 2026-10-27 (contact
// shadows, cabinet fronts, an opened drawer, door glass, windows, worktops,
// blocky light), rendered on the real GPU into output/look/<label>/fault-*.png.
//   node scripts/addon/fault-shots.mjs --label <name> [--preset high] [--views a,b]
// Needs the dev server (LAB_URL, default http://localhost:5173).
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { findGpuChromium, playwright, GPU_ARGS } from './env.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1] }
const label = option('label', 'faults')
if (!/^[\w-]+$/.test(label)) throw new Error('Use a simple label')
const preset = option('preset', 'high')

// eye/focus in scene units; `chair` frames the first main-room chair from above,
// `drawer` opens the drawer nearest the focus first.
const VIEWS = {
  chair: { zone: 'main', chair: true },
  cabinets: { zone: 'main', eye: [0.3, 1.3, -0.1], focus: [0.3, 0.5, 1.8] },
  drawer: { zone: 'main', eye: [0.3, 1.3, -0.1], focus: [0.3, 0.5, 1.8], openDrawer: true },
  door: { zone: 'main', eye: [-2.9, 1.4, -0.65], focus: [-4.4, 1.35, -0.65] },
  coldWindow: { zone: 'cold', eye: [3.0, 1.45, -3.6], focus: [3.1, 1.6, -6.2] },
  commons: { zone: 'X05', eye: [2.6, 1.45, 5.0], focus: [4.78, 1.55, 1.96] },
  worktops: { zone: 'BI01', eye: [8.4, 1.5, 7.6], focus: [8.0, 0.85, 3.0] },
  mainWindow: { zone: 'main', eye: [2.4, 1.45, 0.4], focus: [4.3, 1.6, 0] },
  coldBench: { zone: 'cold', eye: [0.75, 1.45, -2.35], focus: [3.4, 1.0, -5.6] },
  target: { zone: 'main', eye: [2.8, 1.4, 0.7], focus: [-4.4, 1.27, 0.7], fov: 47.4 },
}
const views = option('views', Object.keys(VIEWS).join(',')).split(',')
const out = resolve('output/look', label)
mkdirSync(out, { recursive: true })

const { chromium } = playwright()
const browser = await chromium.launch({ executablePath: findGpuChromium(), args: GPU_ARGS })
try {
  const page = await browser.newPage({ viewport: { width: 1672, height: 941 }, deviceScaleFactor: 1 })
  page.setDefaultTimeout(300000)
  page.on('pageerror', e => console.log(`[page error] ${e.message.slice(0, 300)}`))
  await page.goto(process.env.LAB_URL ?? 'http://localhost:5173', { waitUntil: 'domcontentloaded' })
  await page.getByTestId('station-sample-prep').click()
  await page.waitForFunction(() => window.__lab?.ready)
  // only the 3D view: hide the station's panels and the HUD over the canvas
  await page.addStyleTag({ content: 'body * { visibility: hidden !important } canvas.lab-canvas { visibility: visible !important }' })
  if (await page.evaluate(() => window.__lab.settings.lighting) !== preset) {
    await page.getByRole('button', { name: 'Graphics settings' }).first().dispatchEvent('click')
    await page.locator(`[data-preset=${preset}]`).dispatchEvent('click')
    await page.getByRole('button', { name: 'Graphics settings' }).first().dispatchEvent('click')
    await page.waitForFunction(p => window.__lab?.ready && !window.__lab.disposed && window.__lab.settings.lighting === p, preset)
  }
  // the station's opening camera move must not fight the shots
  await page.waitForTimeout(3000)
  for (const name of views) {
    const v = VIEWS[name]
    if (!v) throw new Error(`Unknown view ${name}`)
    await page.evaluate(async v => {
      const w = window.__lab
      for (const part of w.lab.storage) { part.open = false; part.amount = 0 }
      let { eye, focus } = v
      if (v.chair) {
        const seat = w.lab.ctx.seats.find(s => s.zone === v.zone)
        const p = seat.position, f = [Math.sin(seat.yaw), Math.cos(seat.yaw)]
        eye = [p.x - f[0] * 0.9 + f[1] * 0.5, 1.55, p.z - f[1] * 0.9 - f[0] * 0.5]
        focus = [p.x, 0.25, p.z]
      }
      if (v.openDrawer) {
        const drawers = w.lab.storage.filter(s => s.zone === v.zone && s.kind === 'drawer')
        const c = s => { const b = s.bounds.clone().applyMatrix4(s.frame); return [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2] }
        drawers.sort((a, b) => { const ca = c(a), cb = c(b); return Math.hypot(ca[0] - focus[0], ca[2] - focus[2]) - Math.hypot(cb[0] - focus[0], cb[2] - focus[2]) || cb[1] - ca[1] })
        if (drawers[0]) drawers[0].open = true
      }
      w.setMode(v.free ? 'free' : 'walk')
      if (v.fov) { w.camera.fov = v.fov; w.camera.updateProjectionMatrix() }
      w.setView({ x: eye[0], y: eye[1], z: eye[2] }, { x: focus[0], y: focus[1], z: focus[2] })
      w.setLive({ ...w.settings, minDynamicScale: 1 }); w.dynScale = 1; w.resize()
      const stop = w.addFrameHook(() => { w.requestRender(); return false })
      // drawers animate open; refinement settles over ~32 still frames
      for (let i = 0; i < 90; i++) await new Promise(requestAnimationFrame)
      stop()
      for (let i = 0; i < 40; i++) await new Promise(requestAnimationFrame)
    }, v)
    const file = resolve(out, `fault-${name}.png`)
    await page.locator('canvas.lab-canvas').screenshot({ path: file })
    console.log(`fault-${name}.png`)
  }
} finally { await browser.close() }
console.log(`Shots: ${out}`)

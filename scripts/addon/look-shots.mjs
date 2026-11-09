// Look comparison: renders fixed viewpoints at each graphics preset and compares
// the main room (east end, looking west) against the target render. Start `npm run dev` first.
//   npm run look:shots -- --label before [--presets high,medium] [--views home,post] [--analyse]
// --analyse re-measures the shots already saved under the label instead of rendering.
// LAB_URL overrides the dev server (default http://127.0.0.1:5173). Shots land in
// output/look/<label>/<preset>-<view>.png; the report in output/look/<label>/report.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { findChromium, playwright, GPU_ARGS, findGpuChromium } from './env.mjs'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const label = arg('label', 'latest')
const presets = arg('presets', 'low,medium,high,ultra').split(',')
const TARGET = resolve('docs/master-plan/look/target-main-east-west.png')
// The target re-renders a 2168×1127 screenshot, zoomed to 16:9: its door is 9 %
// of the width against 6.6 % in the screenshot. That puts the camera ~7.2 units
// from the door, 1.35 left of it, with a ~47° vertical FOV.
const COMPARE = 'target'
const W = 1672
const H = 941

// `zone` views without an eye are framed down the room's long axis.
const ALL_VIEWS = {
  target: { zone: 'main', eye: [2.8, 1.4, 0.7], focus: [-4.4, 1.27, 0.7], fov: 47.4 },
  home: { zone: 'main', eye: [-3.05, 1.4, 0.12], focus: [4.3, 1.28, 0] },
  overview: { zone: 'main', eye: [3.15, 1.4, 0.05], focus: [-4.3, 1.18, -0.15] },
  post: { zone: 'post' },
  cold: { zone: 'cold' },
  hall: { zone: 'hall' },
  hub: { zone: 'C01' },
}
const views = arg('views', Object.keys(ALL_VIEWS).join(',')).split(',')
const analyseOnly = args.includes('--analyse')
// --eval "<js>" runs in the page (with `w` = the lab world) before each shot, for experiments
const evalJs = arg('eval', '')

// Grid cells (20 × 12) of each surface band in the target's framing.
const BANDS = {
  ceiling: { rows: [0, 1], cols: [5, 14] },
  uppers: { rows: [2, 6], cols: [0, 4] },
  wall: { rows: [3, 5], cols: [8, 9] },
  // open floor between the chairs in both framings
  floor: { rows: [9, 10], cols: [10, 11] },
}

function lumaGrid(page, dataUrl) {
  return page.evaluate(async (src) => {
    const img = new Image()
    img.src = src
    await img.decode()
    const c = document.createElement('canvas')
    c.width = 400
    c.height = 225
    const g = c.getContext('2d')
    g.drawImage(img, 0, 0, c.width, c.height)
    const d = g.getImageData(0, 0, c.width, c.height).data
    const cw = c.width / 20
    const ch = c.height / 12
    const grid = []
    for (let j = 0; j < 12; j++) {
      const row = []
      for (let i = 0; i < 20; i++) {
        let s = 0
        let n = 0
        for (let y = Math.floor(j * ch); y < Math.floor((j + 1) * ch); y++) {
          for (let x = Math.floor(i * cw); x < Math.floor((i + 1) * cw); x++) {
            const k = (y * c.width + x) * 4
            s += 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2]
            n++
          }
        }
        row.push(Math.round(s / n))
      }
      grid.push(row)
    }
    return grid
  }, dataUrl)
}

function bandMeans(grid) {
  const out = {}
  for (const [name, b] of Object.entries(BANDS)) {
    let s = 0
    let n = 0
    for (let j = b.rows[0]; j <= b.rows[1]; j++) for (let i = b.cols[0]; i <= b.cols[1]; i++) {
      s += grid[j][i]
      n++
    }
    out[name] = Math.round(s / n)
  }
  return out
}

async function choosePreset(page, preset) {
  await page.getByRole('button', { name: 'Graphics settings' }).click({ timeout: 300000 })
  await page.locator(`[data-preset=${preset}]`).click({ timeout: 300000 })
  await page.keyboard.press('Escape')
  await page.waitForFunction(
    (p) => {
      const w = window.__lab
      return w?.ready && !w.disposed && w.settings.lighting === p && w.debugInfo().bake.main === 'final'
    },
    preset,
    { timeout: 300000 },
  )
  // TAA would blend in frames from the previous camera pose; shots measure without it
  await page.evaluate(() => window.__lab.setLive({ ...window.__lab.settings, refine: false }))
}

async function shoot(page, view) {
  const v = ALL_VIEWS[view]
  await page.evaluate(async (v) => {
    const w = window.__lab
    let { eye, focus } = v
    if (!eye) {
      const { ZONES, zoneBounds } = await import('/src/three/lab/layout.ts')
      const b = zoneBounds(ZONES[v.zone])
      const cx = (b.minX + b.maxX) / 2
      const cz = (b.minZ + b.maxZ) / 2
      const alongX = b.maxX - b.minX >= b.maxZ - b.minZ
      eye = alongX ? [b.minX + 0.6, 1.4, cz] : [cx, 1.4, b.maxZ - 0.6]
      focus = alongX ? [b.maxX, 1.2, cz] : [cx, 1.2, b.minZ]
    }
    w.setMode('walk')
    w.setView({ x: eye[0], y: eye[1], z: eye[2] }, { x: focus[0], y: focus[1], z: focus[2] })
  }, v)
  await page.waitForFunction(
    (zone) => {
      const w = window.__lab
      // every room is lit and has its probe once the world is ready
      return w.ready && w.debugInfo().bake[zone] === 'final'
    },
    v.zone,
    { timeout: 300000 },
  )
  await page.waitForTimeout(500)
  const { png, pose } = await page.evaluate(({ v, js }) => {
    const w = window.__lab
    // re-apply the view: station views may move the camera once the world settles
    let { eye, focus } = v
    if (!eye) [eye, focus] = [w.player.toArray(), null]
    if (focus) w.setView({ x: eye[0], y: eye[1], z: eye[2] }, { x: focus[0], y: focus[1], z: focus[2] })
    const fov = w.camera.fov
    if (v.fov) {
      w.camera.fov = v.fov
      w.camera.updateProjectionMatrix()
    }
    if (js) new Function('w', js)(w)
    w.dynScale = 1
    w.resize()
    // TAA blends in frames from earlier camera poses; measure a plain frame
    if (w.taa) {
      w.taa.enabled = false
      w.taa.accumulateIndex = -1
      if (w.renderPass) w.renderPass.enabled = true
    }
    w.draw(0)
    const png = w.renderer.domElement.toDataURL('image/png')
    const { drawCalls: calls, triangles } = w.renderer.info.render
    const pose = { mode: w.mode, eye: w.player.toArray().map((n) => +n.toFixed(2)), fov: w.camera.fov, calls, triangles }
    w.camera.fov = fov
    w.camera.updateProjectionMatrix()
    return { png, pose }
  }, { v, js: evalJs })
  console.log(`  ${view}: ${JSON.stringify(pose)}`)
  return { png, pose }
}

const out = resolve('output/look', label)
mkdirSync(out, { recursive: true })
const reportPath = resolve(out, 'report.json')
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : { label, presets: {}, target: null }
const { chromium } = playwright()
const browser = await chromium.launch({ executablePath: findGpuChromium(), args: GPU_ARGS })
try {
  const page = await browser.newPage({ viewport: { width: W, height: H + 120 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(process.env.LAB_URL ?? 'http://127.0.0.1:5173', { waitUntil: 'domcontentloaded' })
  const target = `data:image/png;base64,${readFileSync(TARGET).toString('base64')}`
  report.target = { bands: bandMeans(await lumaGrid(page, target)) }
  const compare = async (preset, png) => {
    const grid = await lumaGrid(page, png)
    const bands = bandMeans(grid)
    const diff = Object.fromEntries(Object.entries(bands).map(([k, v]) => [k, v - report.target.bands[k]]))
    console.log(`${preset.padEnd(7)} ${COMPARE} bands ${JSON.stringify(bands)}  vs target ${JSON.stringify(diff)}`)
    return { view: COMPARE, bands, diff, grid }
  }

  if (analyseOnly) {
    // re-measure shots already on disk
    for (const preset of presets) {
      const file = resolve(out, `${preset}-${COMPARE}.png`)
      if (!existsSync(file)) continue
      const entry = report.presets[preset] ?? { views: {} }
      entry.compare = await compare(preset, `data:image/png;base64,${readFileSync(file).toString('base64')}`)
      report.presets[preset] = entry
    }
  } else {
    await page.getByTestId('station-station-selector').click({ timeout: 60000 })
    await page.waitForFunction(() => window.__lab?.ready, null, { timeout: 120000 })
    // Size the page so the canvas itself is W × H.
    const rect = await page.locator('canvas.lab-canvas').boundingBox()
    await page.setViewportSize({ width: W + (W - Math.round(rect.width)), height: H + 120 + (H - Math.round(rect.height)) })
    for (const preset of presets) {
      await choosePreset(page, preset)
      const entry = { views: {} }
      for (const view of views) {
        const { png, pose } = await shoot(page, view)
        writeFileSync(resolve(out, `${preset}-${view}.png`), Buffer.from(png.split(',')[1], 'base64'))
        if (view === COMPARE) entry.compare = await compare(preset, png)
        entry.views[view] = { file: `${preset}-${view}.png`, calls: pose.calls, triangles: pose.triangles }
      }
      // final-pass bake time per room, from the world's bake log ("final main (812ms)")
      entry.bakeMs = await page.evaluate(() =>
        Object.fromEntries(
          window.__lab
            .debugInfo()
            .bakeLog.map((l) => /final (\S+) \((\d+)ms\)/.exec(l))
            .filter(Boolean)
            .map((m) => [m[1], +m[2]]),
        ),
      )
      report.presets[preset] = entry
      writeFileSync(reportPath, JSON.stringify(report, null, 2))
    }
  }
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`)
  console.log(`target  ${COMPARE} bands ${JSON.stringify(report.target.bands)}`)
  console.log(`Shots and report: output/look/${label}/`)
} finally {
  await browser.close()
}

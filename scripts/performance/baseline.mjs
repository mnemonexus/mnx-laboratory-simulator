// Reproducible development baseline; never opens the real app-data bridge.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpus, platform, release, totalmem } from 'node:os'
import { resolve } from 'node:path'
import { findChromium, playwright, GPU_ARGS, findGpuChromium } from '../addon/env.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1] }
const label = option('label', 'latest')
if (!/^[\w-]+$/.test(label)) throw new Error('Use a simple label containing letters, numbers, hyphens or underscores')
const seconds = Number(option('seconds', '10'))
if (!Number.isFinite(seconds) || seconds < 1 || seconds > 120) throw new Error('--seconds must be 1..120')
const presets = option('presets', 'low,high').split(',')
if (presets.some(p => !['low', 'medium', 'high', 'ultra'].includes(p))) throw new Error('Unknown preset')
const device = option('device', 'desktop')
const devices = { desktop: { width: 1440, height: 960 }, phone: { width: 390, height: 844 }, tablet: { width: 1024, height: 768 } }
if (!devices[device]) throw new Error('Unknown device profile')
const scenes = {
  stocked: { zone: 'main', eye: [-3.05, 1.4, 0.12], focus: [4.3, 1.28, 0] },
  glass: { zone: 'main', eye: [2.8, 1.4, 0.7], focus: [-4.4, 1.27, 0.7] },
  cold: { zone: 'cold' }, corridor: { zone: 'C01' }, post: { zone: 'post' },
}
const views = option('views', Object.keys(scenes).join(',')).split(',')
if (views.some(v => !scenes[v])) throw new Error('Unknown scene')
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim()
const files = git('ls-files', '-co', '--exclude-standard').split(/\r?\n/).filter(Boolean).sort()
const hash = createHash('sha256')
for (const file of files) { hash.update(file); hash.update(readFileSync(file)) }
const out = resolve('output/performance', label)
mkdirSync(out, { recursive: true })
const report = {
  schema: 'lab-performance-baseline/1', createdAt: new Date().toISOString(),
  source: { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain'), workingTreeSha256: hash.digest('hex') },
  machine: { platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCores: cpus().length, ramBytes: totalmem() },
  configuration: { device, viewport: devices[device], presets, seconds, views, url: process.env.LAB_URL ?? 'http://localhost:5173', emulationOnly: device !== 'desktop', mode: 'development', fixedQuality: true },
  limitations: ['CPU submission time is not GPU time.', 'No science executes in these render workloads; use science.mjs separately.', 'Resource counts are not VRAM bytes.', 'Emulation does not establish mobile compatibility.', 'Continuous rendering is forced; idle energy use is a separate workload.'],
  results: [], errors: [],
}
const { chromium } = playwright()
const browser = await chromium.launch({ executablePath: findGpuChromium(), args: GPU_ARGS, headless: !args.includes('--headed') })
const save = () => writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2))
try {
  const page = await browser.newPage({ viewport: devices[device], deviceScaleFactor: 1, hasTouch: device !== 'desktop' })
  page.setDefaultTimeout(180000)
  page.on('pageerror', e => report.errors.push(e.message))
  const started = performance.now()
  await page.goto(report.configuration.url, { waitUntil: 'domcontentloaded' })
  if (device === 'phone') await page.getByTestId('station-select').selectOption('sample-prep')
  else await page.getByTestId('station-sample-prep').click()
  await page.waitForFunction(() => window.__lab?.ready)
  report.launchToReadyMs = performance.now() - started
  report.browser = await page.evaluate(() => {
    const w = window.__lab, context = w.renderer.getContext()
    const gl = typeof context?.getParameter === 'function' ? context : null
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    return { userAgent: navigator.userAgent, secure: isSecureContext, webgpuExposed: !!navigator.gpu,
      renderer: gl ? gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : 'WebGPU',
      backend: w.renderer.backend?.constructor.name,
      webglVersion: gl?.getParameter(gl.VERSION) ?? null, browserVersion: navigator.userAgent, crossOriginIsolated }
  })
  for (const preset of presets) {
    await page.getByRole('button', { name: 'Graphics settings' }).first().click()
    await page.locator(`[data-preset=${preset}]`).click()
    await page.keyboard.press('Escape')
    await page.waitForFunction(p => window.__lab?.ready && !window.__lab.disposed && window.__lab.settings.lighting === p, preset)
    await page.evaluate(() => { const w = window.__lab; w.setLive({ ...w.settings, fpsCap: 0, refine: false, minDynamicScale: 1 }); w.dynScale = 1; w.resize() })
    for (const view of views) {
      const entered = performance.now()
      await page.evaluate(async v => {
        const w = window.__lab
        let { eye, focus } = v
        if (!eye) {
          const { ZONES, zoneBounds } = await import('/src/three/lab/layout.ts')
          const b = zoneBounds(ZONES[v.zone]), cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2
          const x = b.maxX - b.minX >= b.maxZ - b.minZ
          eye = x ? [b.minX + 0.6, 1.4, cz] : [cx, 1.4, b.maxZ - 0.6]
          focus = x ? [b.maxX, 1.2, cz] : [cx, 1.2, b.minZ]
        }
        w.setMode('walk'); w.setView({ x: eye[0], y: eye[1], z: eye[2] }, { x: focus[0], y: focus[1], z: focus[2] })
      }, scenes[view])
      await page.waitForFunction(z => { const w = window.__lab; return w.ready && w.debugInfo().bake[z] === 'final' }, scenes[view].zone)
      const entryReadyMs = performance.now() - entered
      await page.waitForTimeout(1000)
      const evidence = await page.evaluate(async duration => {
        const w = window.__lab
        const stop = w.addFrameHook(() => { w.requestRender(); return false })
        const memory = () => performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize } : null
        const before = memory()
        try {
          // Warm the newly visible materials/pipeline before measuring steady state.
          for (let i = 0; i < 60; i++) await new Promise(requestAnimationFrame)
          w.startPerformanceCapture(Math.min(60000, Math.ceil(duration * 500)))
          await new Promise(r => setTimeout(r, duration * 1000))
          const capture = w.endPerformanceCapture()
          let meshes = 0, transparentMeshes = 0, instancedMeshes = 0
          w.scene.traverse(o => { if (o.isMesh) { meshes++; if (o.isInstancedMesh) instancedMeshes++; const ms = Array.isArray(o.material) ? o.material : [o.material]; if (ms.some(m => m.transparent || m.transmission > 0)) transparentMeshes++ } })
          return { capture, settings: w.settings, pose: { eye: w.player.toArray(), yaw: w.yaw, pitch: w.pitch },
            canvas: { width: w.renderer.domElement.width, height: w.renderer.domElement.height, pixelRatio: w.renderer.getPixelRatio() },
            scene: { meshes, transparentMeshes, instancedMeshes, ...w.renderer.info.memory, probes: w.debugInfo().probes },
            heap: { before, after: memory() }, failed: w.failed, disposed: w.disposed }
        } finally { stop(); w.endPerformanceCapture() }
      }, seconds)
      const screenshot = `${preset}-${view}.png`
      await page.locator('canvas.lab-canvas').screenshot({ path: resolve(out, screenshot) })
      report.results.push({ preset, view, entryReadyMs, screenshot, ...evidence })
      save()
      console.log(`${preset}/${view}: ${JSON.stringify(evidence.capture.summary)}`)
      if (evidence.failed || evidence.disposed || evidence.capture.truncated || evidence.capture.renderedFrames < 30) throw new Error(`Invalid capture: ${preset}/${view}`)
    }
  }
  if (report.errors.length) throw new Error(report.errors.join('; '))
} finally { save(); await browser.close() }
console.log(`Report: ${resolve(out, 'report.json')}`)

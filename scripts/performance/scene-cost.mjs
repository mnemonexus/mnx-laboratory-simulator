// Development startup CPU profile and one fully warmed draw's submission census.
// Instrumentation stays in this harness; it is not shipped with the simulator.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { findChromium, playwright, GPU_ARGS, findGpuChromium } from '../addon/env.mjs'

const label = process.argv[2] ?? 'latest'
if (!/^[a-z0-9-]+$/i.test(label)) throw new Error('Use a simple profile label')
const out = resolve('output/performance', `scene-cost-${label}`)
const source = createHash('sha256')
for (const file of ['src/three/lab/build.ts', 'src/three/lab/kit.ts', 'src/three/lab/exactGeometry.ts', 'src/three/lab/surfaces.ts', 'src/three/textures.ts', 'src/three/texturePixels.ts']) source.update(file).update(readFileSync(file))
const sourceSha256 = source.digest('hex')
mkdirSync(out, { recursive: true })
const { chromium } = playwright()
const browser = await chromium.launch({ executablePath: findGpuChromium(), args: GPU_ARGS })
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  page.setDefaultTimeout(180000)
  page.on('pageerror', error => errors.push(error.message))
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 })
  await cdp.send('Profiler.start')
  const started = performance.now()
  await page.goto(process.env.LAB_URL ?? 'http://localhost:5173')
  await page.getByTestId('station-sample-prep').click()
  await page.waitForFunction(() => window.__lab?.ready)
  const launchToReadyMs = performance.now() - started
  const { profile } = await cdp.send('Profiler.stop')
  writeFileSync(resolve(out, 'startup.cpuprofile'), JSON.stringify(profile))
  const nodes = new Map(profile.nodes.map(node => [node.id, node]))
  const parents = new Map()
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id)
  const times = new Map()
  for (let i = 0; i < profile.samples.length; i++) {
    const leaf = profile.samples[i], ms = profile.timeDeltas[i] / 1000
    let id = leaf
    const visited = new Set()
    while (id !== undefined) {
      const frame = nodes.get(id).callFrame
      const key = `${frame.functionName}|${frame.url}`
      let row = times.get(key)
      if (!row) times.set(key, row = { name: frame.functionName, url: frame.url, selfMs: 0, inclusiveMs: 0 })
      if (!visited.has(key)) row.inclusiveMs += ms
      visited.add(key)
      if (id === leaf) row.selfMs += ms
      id = parents.get(id)
    }
  }
  await page.getByRole('button', { name: 'Graphics settings' }).first().click()
  await page.locator('[data-preset=low]').click()
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => window.__lab?.ready && window.__lab.settings.lighting === 'low')
  await page.waitForFunction(() => window.__lab.ready && window.__lab.debugInfo().bake.main === 'final')
  await page.waitForTimeout(1000)
  const census = await page.evaluate(async () => {
    const w = window.__lab, backend = w.renderer.backend, original = backend.draw
    const draws = new Map()
    backend.draw = function(object, info) {
      const mesh = object.object, material = object.material
      const path = []; let parent = mesh
      while (parent && parent !== w.scene) { path.unshift(parent.name || parent.type); parent = parent.parent }
      const key = `${path.join('/')}|${material.uuid}`
      let row = draws.get(key)
      if (!row) draws.set(key, row = { object: path.join('/'), material: material.name || material.type, transparent: material.transparent, side: material.side, doublePass: material.transparent && material.side === 2 && !material.forceSinglePass, calls: 0 })
      row.calls++
      return original.call(this, object, info)
    }
    try {
      // Capture a real animation frame. A manual second draw in the same
      // frame may reuse a cached scene pass and count only its screen quad.
      await new Promise(resolve => requestAnimationFrame(() => {
        draws.clear(); w.requestRender()
        requestAnimationFrame(resolve)
      }))
    } finally { backend.draw = original }
    let attributeBytes = 0, geometryCount = 0, vertices = 0
    const seen = new Set()
    w.scene.traverse(object => {
      const g = object.geometry
      if (!g || seen.has(g)) return
      seen.add(g); geometryCount++
      vertices += g.getAttribute('position')?.count ?? 0
      for (const attribute of Object.values(g.attributes)) attributeBytes += attribute.array?.byteLength ?? 0
      attributeBytes += g.index?.array.byteLength ?? 0
    })
    return { backend: backend.constructor.name, calls: w.renderer.info.render.drawCalls, probes: w.debugInfo().probes, geometryCount, vertices, attributeBytes, draws: [...draws.values()].sort((a, b) => b.calls - a.calls), debug: w.debugInfo() }
  })
  const report = { createdAt: new Date().toISOString(), sourceSha256, launchToReadyMs, errors, topSelf: [...times.values()].sort((a, b) => b.selfMs - a.selfMs).slice(0, 40), topInclusive: [...times.values()].sort((a, b) => b.inclusiveMs - a.inclusiveMs).slice(0, 40), census, limitations: ['Development startup sampling includes application/render setup and waiting; inclusive rows overlap.', 'Backend draw-object entries can contain multiple BatchedMesh GPU draws; use renderer.info and baseline captures for draw-call totals.', 'Concurrent machine load can change timings; geometry byte counts are deterministic for this scene.'] }
  writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ launchToReadyMs, calls: census.calls, attributeBytes: census.attributeBytes, probes: census.probes, topSelf: report.topSelf.slice(0, 10) }, null, 2))
  if (errors.length) throw new Error(errors.join('; '))
} finally { await browser.close() }

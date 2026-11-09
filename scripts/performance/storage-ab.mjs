// Same-world A/B: reconstruct the preceding per-room BatchedMesh from the
// current rigid batches' rest geometry, retaining identical materials/lightmaps.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { findChromium, playwright, GPU_ARGS, findGpuChromium } from '../addon/env.mjs'
const browser = await playwright().chromium.launch({ executablePath: findGpuChromium(), args: GPU_ARGS })
const out = 'output/performance/storage-ab'
mkdirSync(out, { recursive: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  const errors = [], results = []
  page.on('pageerror', error => errors.push(error.message))
  page.setDefaultTimeout(180000)
  await page.goto(process.env.LAB_URL ?? 'http://localhost:5173')
  await page.getByTestId('station-sample-prep').click()
  await page.waitForFunction(() => window.__lab?.ready)
  await page.evaluate(async () => {
    const THREE = await import('/node_modules/.vite/deps/three.js')
    const { RigidMeshBatch } = await import('/src/three/lab/rigidMeshBatch.ts')
    const w = window.__lab, originals = [], replacements = [], wholeRoom = []
    for (const zone of Object.values(w.lab.zones)) {
      const groups = new Map()
      for (const mesh of zone.children.filter(o => o.userData.rigidBatch)) {
        originals.push(mesh)
        const items = groups.get(mesh.material) ?? []
        const indices = mesh.geometry.index.array
        let cursor = 0
        for (const part of mesh.parts) {
          const geometry = new THREE.BufferGeometry()
          for (const [name, attr] of Object.entries(mesh.geometry.attributes)) {
            if (name === 'position') geometry.setAttribute(name, part.position.clone())
            else if (name === 'normal') geometry.setAttribute(name, part.normal.clone())
            else geometry.setAttribute(name, new THREE.BufferAttribute(attr.array.slice(part.first * attr.itemSize, (part.first + part.position.count) * attr.itemSize), attr.itemSize, attr.normalized))
          }
          const start = cursor
          while (cursor < indices.length && indices[cursor] >= part.first && indices[cursor] < part.first + part.position.count) cursor++
          geometry.setIndex(Array.from(indices.slice(start, cursor), i => i - part.first))
          items.push({ geometry, matrix: part.matrix, source: mesh })
        }
        if (cursor !== indices.length) throw new Error('A/B rest-geometry layout changed')
        groups.set(mesh.material, items)
      }
      for (const [material, items] of groups) {
        const whole = new RigidMeshBatch(items, material)
        whole.name = 'diagnostic:whole-room-storage'; whole.visible = false
        whole.castShadow = items[0].source.castShadow; whole.receiveShadow = items[0].source.receiveShadow
        whole.renderOrder = items[0].source.renderOrder; zone.add(whole); wholeRoom.push(whole)
        const mesh = new THREE.BatchedMesh(items.length, items.reduce((n, i) => n + i.geometry.getAttribute('position').count, 0), items.reduce((n, i) => n + i.geometry.index.count, 0), material)
        mesh.name = 'diagnostic:previous-storage'; mesh.matrixAutoUpdate = false
        mesh.castShadow = items[0].source.castShadow; mesh.receiveShadow = items[0].source.receiveShadow
        mesh.renderOrder = items[0].source.renderOrder; mesh.visible = false
        for (const item of items) { mesh.setMatrixAt(mesh.addInstance(mesh.addGeometry(item.geometry)), item.matrix); item.geometry.dispose() }
        mesh.computeBoundingSphere(); zone.add(mesh); replacements.push(mesh)
      }
    }
    window.__storageAB = { originals, replacements, wholeRoom }
    w.scene.updateMatrixWorld(true)
  })
  {
    // Keep the actual initial profile fixed: changing a preset rebuilds the
    // world and would discard the reconstructed comparison meshes.
    await page.evaluate(() => {
      const w = window.__lab
      w.setLive({ ...w.settings, refine: false, minDynamicScale: 1 }); w.dynScale = 1; w.resize()
      w.setMode('walk'); w.setView({ x: 2.8, y: 1.4, z: 0.7 }, { x: -4.4, y: 1.27, z: 0.7 })
    })
    await page.waitForFunction(() => { const w = window.__lab; return w.ready && w.debugInfo().bake.main === 'final' })
    for (let repetition = 0; repetition < 3; repetition++) for (const mode of repetition % 2 ? ['room', 'merged', 'previous'] : ['previous', 'merged', 'room']) {
      const capture = await page.evaluate(async mode => {
        const w = window.__lab, { originals, replacements, wholeRoom } = window.__storageAB
        originals.forEach(m => { m.visible = mode === 'merged' }); replacements.forEach(m => { m.visible = mode === 'previous' })
        wholeRoom.forEach(m => { m.visible = mode === 'room' })
        const stop = w.addFrameHook(() => { w.requestRender(); return false })
        try {
          for (let i = 0; i < 120; i++) await new Promise(requestAnimationFrame)
          w.startPerformanceCapture(2000)
          await new Promise(resolve => setTimeout(resolve, 3000))
          const capture = w.endPerformanceCapture(), gpuSamplesMs = []
          const backend = w.renderer.backend
          if (backend.device?.features.has('timestamp-query')) {
            backend.trackTimestamp = true
            try {
              for (let i = 0; i < 65; i++) {
                const call = w.renderer.info.render.calls
                while (w.renderer.info.render.calls === call) await new Promise(requestAnimationFrame)
                const ms = await w.renderer.resolveTimestampsAsync('render')
                if (i >= 5 && typeof ms === 'number' && Number.isFinite(ms)) gpuSamplesMs.push(ms)
              }
            } finally { backend.trackTimestamp = false }
          }
          return { capture, gpuSamplesMs, settings: w.settings }
        } finally { stop(); w.endPerformanceCapture() }
      }, mode)
      assert.ok(capture.capture.renderedFrames > 30)
      results.push({ repetition, mode, ...capture })
      if (repetition === 0) await page.locator('canvas.lab-canvas').screenshot({ path: `${out}/${mode}.png` })
      console.log(mode, repetition, JSON.stringify({ cpu: capture.capture.summary.drawCpuMs, gpuMedian: capture.gpuSamplesMs.length ? [...capture.gpuSamplesMs].sort((a,b)=>a-b)[Math.floor(capture.gpuSamplesMs.length/2)] : null }))
    }
  }
  assert.equal(errors.length, 0)
  writeFileSync(`${out}/report.json`, JSON.stringify({ results, errors, scope: 'Three alternating same-world glass-view captures per representation, fixed actual initial graphics settings/materials. All representations are resident. CPU captures precede separate render-pass GPU timestamp queries where supported; these exclude non-render GPU work. Not total memory or physical mobile evidence.' }, null, 2))
} finally { await browser.close() }

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { findChromium, playwright, GPU_ARGS, findGpuChromium } from '../addon/env.mjs'
const label = process.argv[2] ?? 'latest'
if (!/^[a-z0-9-]+$/i.test(label)) throw new Error('Use a simple label')
const browser = await playwright().chromium.launch({ executablePath: findGpuChromium(), args: GPU_ARGS })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.setDefaultTimeout(120000)
  await page.goto(process.env.LAB_URL ?? 'http://localhost:5173')
  await page.getByTestId('station-sample-prep').click()
  await page.waitForFunction(() => window.__lab?.ready && !window.__lab.disposed)
  const result = await page.evaluate(async () => {
    const { updateStorage } = await import('/src/three/lab/storage.ts')
    const w = window.__lab, parts = w.lab.storage.filter(p => p.zone === 'main')
    const rows = []
    for (const count of [1, parts.length]) {
      const selected = parts.slice(0, count), samples = []
      for (let run = 0; run < 11; run++) {
        const started = performance.now()
        for (const open of [true, false]) {
          selected.forEach(part => { part.open = open })
          for (let step = 0; step < 12; step++) updateStorage(selected, 1 / 30)
        }
        if (run >= 2) samples.push(performance.now() - started)
      }
      rows.push({ parts: count, samplesMs: samples, framesPerCycle: 24, settled: selected.every(part => part.amount === 0) })
    }
    const started = performance.now()
    for (let i = 0; i < 1000; i++) updateStorage(parts, 1 / 60)
    w.requestRender()
    const meshes = [...new Set(parts.flatMap(p => p.instances.map(i => i.mesh)))]
    const staticBytes = meshes.reduce((total, mesh) => total + Object.values(mesh.geometry.attributes).reduce((sum, a) => sum + a.array.byteLength, 0) + (mesh.geometry.index?.array.byteLength ?? 0), 0)
    const idle1000UpdatesMs = performance.now() - started
    const cpuRestPoseBytes = meshes.reduce((sum, mesh) => sum + (mesh.parts ?? []).reduce((total, part) => total + part.position.array.byteLength + (part.normal?.array.byteLength ?? 0), 0), 0)
    const facilityMeshes = [...new Set(w.lab.storage.flatMap(p => p.instances.map(i => i.mesh)))]
    const facilityCpuRestPoseBytes = facilityMeshes.reduce((sum, mesh) => sum + (mesh.parts ?? []).reduce((total, part) => total + part.position.array.byteLength + (part.normal?.array.byteLength ?? 0), 0), 0)
    return { rows, idle1000UpdatesMs, meshTypes: meshes.map(m => m.constructor.name), graphicsAttributeAndIndexBytes: staticBytes, cpuRestPoseBytes, facilityCpuRestPoseBytes }
  })
  assert.equal(errors.length, 0)
  assert.ok(result.rows.every(row => row.settled))
  mkdirSync('output/performance', { recursive: true })
  writeFileSync(`output/performance/storage-motion-${label}.json`, JSON.stringify({ ...result, errors, limitation: 'Synchronous CPU update cycles, including bounds, on one desktop. GPU rendering/upload and physical mobile cost require separate measurements.' }, null, 2))
  console.log(JSON.stringify(result.rows.map(row => ({ parts: row.parts, medianCycleMs: [...row.samplesMs].sort((a,b)=>a-b)[4], frames: row.framesPerCycle }))))
} finally { await browser.close() }

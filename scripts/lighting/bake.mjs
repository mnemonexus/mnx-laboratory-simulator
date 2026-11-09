// Offline lighting bake: every room's lightmap and irradiance volume, at the
// shipped sampling, into assets/lighting/bake.bin (gzip) for the pack and
// public/assets/lighting/bake.bin for the dev server and standalone build.
//
//   npm run bake              bake rooms whose inputs changed (or --all)
//   npm run bake -- --check   fail if the shipped bake no longer matches a room
//
// The bake inputs come from the add-on's own builders, run in a headless page on
// a private Vite server (no external dev server, no GPU); the baking itself runs
// on every CPU core with Node worker threads, with the add-on's baker (bake.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { gunzipSync, gzipSync } from 'node:zlib'
import { findChromium, playwright, project } from '../addon/env.mjs'
import { BAKED_LIGHTING_PATH, decodeBakedLighting, encodeBakedLighting } from '../../src/three/lab/bakedLighting.ts'

const args = process.argv.slice(2)
const check = args.includes('--check')
const all = args.includes('--all')
const OUT = [join(project, BAKED_LIGHTING_PATH), join(project, 'public', BAKED_LIGHTING_PATH)]
const started = performance.now()

// 1. the jobs, exactly as the add-on builds them (both detail levels)
const { createServer } = await import('vite')
const server = await createServer({ root: project, logLevel: 'error', server: { port: 0, strictPort: false, hmr: false } })
await server.listen()
const url = server.resolvedUrls.local[0]
const { chromium } = playwright()
const browser = await chromium.launch({ executablePath: findChromium() })
let jobs
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(300000)
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  jobs = await page.evaluate(async () => {
    const { buildLab } = await import('/src/three/lab/build.ts')
    const { bakeJob } = await import('/src/three/lab/bakeRunner.ts')
    const { inputFingerprint } = await import('/src/three/lab/bakedLighting.ts')
    const { ZONE_IDS } = await import('/src/three/lab/layout.ts')
    const out = []
    for (const detail of ['full', 'reduced']) {
      const lab = buildLab({ textures: 'low', lighting: 'high', detail })
      for (const zone of ZONE_IDS) {
        const job = bakeJob(lab, zone, 'offline')
        const plain = { ...job, boxes: Array.from(job.boxes), planes: Array.from(job.planes), quads: job.quads ? Array.from(job.quads) : undefined, boxAlbedo: job.boxAlbedo ? Array.from(job.boxAlbedo) : undefined }
        out.push({ zone, fingerprint: inputFingerprint(job), job: plain })
      }
      lab.dispose()
    }
    return out
  })
} finally {
  await browser.close()
  await server.close()
}
const unique = new Map()
for (const j of jobs) unique.set(`${j.zone}|${j.fingerprint}`, j)
console.log(`${unique.size} room bakes (${jobs.length / 2} rooms × 2 detail levels, shared where identical)`)

// 2. what the shipped bake already covers
const unpack = (file) => { const b = gunzipSync(readFileSync(file)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }
const existing = existsSync(OUT[0]) ? decodeBakedLighting(unpack(OUT[0])) : new Map()
const missing = [...unique.keys()].filter((key) => !existing.has(key))
if (check) {
  if (missing.length) {
    console.error(`The shipped bake is stale for ${missing.length} room(s): ${missing.map((k) => k.split('|')[0]).join(', ')}. Run "npm run bake".`)
    process.exit(1)
  }
  console.log('assets/lighting/bake.bin matches every room.')
  process.exit(0)
}

// 3. bake what is missing, across every core
const todo = [...unique.entries()].filter(([key]) => all || !existing.has(key))
const results = new Map([...existing].filter(([key]) => unique.has(key)))
if (todo.length) {
  const size = Math.max(1, Math.min(todo.length, cpus().length - 1))
  console.log(`baking ${todo.length} room(s) on ${size} worker thread(s)…`)
  const queue = [...todo]
  let done = 0
  await Promise.all(Array.from({ length: size }, async () => {
    const worker = new Worker(new URL('./bake-worker.mjs', import.meta.url))
    try {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [key, { zone, fingerprint, job }] = next
        const t0 = performance.now()
        const r = await new Promise((resolve, reject) => {
          worker.once('message', resolve)
          worker.once('error', reject)
          worker.postMessage(job)
        })
        results.set(key, { zone, fingerprint, atlasW: job.atlasW, atlasH: job.atlasH, atlas: r.atlas, volume: r.volume ? { spec: job.volume, data: r.volume } : undefined })
        console.log(`  ${String(++done).padStart(3)}/${todo.length} ${zone.padEnd(6)} ${Math.round(performance.now() - t0)} ms`)
      }
    } finally { await worker.terminate() }
  }))
} else console.log('every room is already baked; use --all to rebake')

// 4. write the asset for the pack and for public/ (dev server, standalone)
const raw = encodeBakedLighting([...results.values()].sort((a, b) => (a.zone + a.fingerprint).localeCompare(b.zone + b.fingerprint)))
const packed = gzipSync(raw, { level: 9 })
for (const path of OUT) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, packed)
}
console.log(`wrote ${BAKED_LIGHTING_PATH}: ${(raw.length / 1048576).toFixed(1)} MB raw, ${(packed.length / 1048576).toFixed(1)} MB compressed, in ${Math.round((performance.now() - started) / 1000)} s`)

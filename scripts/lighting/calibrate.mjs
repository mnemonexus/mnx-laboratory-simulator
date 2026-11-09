// Ceiling-light calibration: scales each room's ceiling fittings (troffers and
// downlights) so the light on what a visitor sees (floor 0.4, walls 0.4, ceiling
// 0.2, baked means) is its level (`ambient` in the facility rooms) × the main
// lab's, the room calibrated to the look target. Matching floors alone left the
// corridors' walls and ceilings dim: labs bounce light off white casework.
// Writes src/three/lab/roomLight.gen.ts; run `npm run bake` after.
//
//   npm run light:calibrate
//
// Each room bakes twice at the runtime sampling, with and without its ceiling
// lights. Light is linear in emitter power, so one pass solves the scale.
import { writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { findChromium, playwright, project } from '../addon/env.mjs'
import { fromRgb9e5 } from '../../src/three/lab/bake.ts'

const REFERENCE = 'main'
const OUT = join(project, 'src/three/lab/roomLight.gen.ts')
const started = performance.now()

// 1. every room's bake job at the runtime sampling, as the add-on builds it
const { createServer } = await import('vite')
const server = await createServer({ root: project, logLevel: 'error', server: { port: 0, strictPort: false, hmr: false } })
await server.listen()
const browser = await playwright().chromium.launch({ executablePath: findChromium() })
let rooms
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(300000)
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'domcontentloaded' })
  rooms = await page.evaluate(async () => {
    const { buildLab } = await import('/src/three/lab/build.ts')
    const { bakeJob } = await import('/src/three/lab/bakeRunner.ts')
    const { ZONES, ZONE_IDS } = await import('/src/three/lab/layout.ts')
    const { CEILING_LIGHT } = await import('/src/three/lab/roomLight.gen.ts')
    const lab = buildLab({ textures: 'low', lighting: 'high', detail: 'full' })
    const out = ZONE_IDS.map((zone) => {
      const job = bakeJob(lab, zone, 'runtime')
      const plain = { ...job, volume: undefined, boxes: Array.from(job.boxes), planes: Array.from(job.planes), quads: job.quads ? Array.from(job.quads) : undefined, boxAlbedo: job.boxAlbedo ? Array.from(job.boxAlbedo) : undefined }
      return { zone, level: ZONES[zone].ambient ?? 1, ceiling: ZONES[zone].ceiling, scale: CEILING_LIGHT[zone] ?? 1, job: plain }
    })
    lab.dispose()
    return out
  })
} finally {
  await browser.close()
  await server.close()
}

// 2. bake with and without the ceiling fittings (anything emitting from the ceiling)
const fromCeiling = (e, ceiling) => (e.kind === 'rect' ? e.c[1] : e.p[1]) > ceiling - 0.1
const tasks = rooms.flatMap((r) => [
  { room: r, part: 'all', job: r.job },
  { room: r, part: 'rest', job: { ...r.job, emitters: r.job.emitters.filter((e) => !fromCeiling(e, r.ceiling)) } },
])
const SURROUND = { floor: 0.4, wall: 0.4, ceiling: 0.2 }
const surroundLight = (job, atlas, ceiling) => {
  const acc = { floor: [0, 0], wall: [0, 0], ceiling: [0, 0] }
  for (const i of job.islands) {
    const kind = i.n[1] > 0.9 && Math.abs(i.origin[1]) < 0.05 ? 'floor'
      : i.n[1] < -0.9 && i.origin[1] > ceiling - 0.3 ? 'ceiling'
      : Math.abs(i.n[1]) < 0.1 && i.origin[1] < 0.3 && (i.hM ?? i.h * job.texel) > 1.5 ? 'wall' : null
    if (!kind) continue
    for (let y = 0; y < i.h; y++) for (let x = 0; x < i.w; x++) {
      const v = atlas[(i.y + y) * job.atlasW + i.x + x]
      if (!v) continue
      const [r, g, b] = fromRgb9e5(v)
      acc[kind][0] += 0.2126 * r + 0.7152 * g + 0.0722 * b
      acc[kind][1]++
    }
  }
  const mean = (k) => (acc[k][1] ? acc[k][0] / acc[k][1] : 0)
  return Object.entries(SURROUND).reduce((sum, [k, w]) => sum + w * mean(k), 0)
}
const size = Math.max(1, Math.min(tasks.length, cpus().length - 1))
console.log(`baking ${rooms.length} rooms twice on ${size} worker thread(s)…`)
const measured = new Map()
const queue = [...tasks]
await Promise.all(Array.from({ length: size }, async () => {
  const worker = new Worker(new URL('./bake-worker.mjs', import.meta.url))
  try {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const r = await new Promise((resolve, reject) => {
        worker.once('message', resolve)
        worker.once('error', reject)
        worker.postMessage(next.job)
      })
      const m = measured.get(next.room.zone) ?? {}
      m[next.part] = surroundLight(next.job, r.atlas, next.room.ceiling)
      measured.set(next.room.zone, m)
    }
  } finally { await worker.terminate() }
}))

// 3. solve each room's scale: level × reference = rest + scale × (ceiling light per unit scale)
const ref = rooms.find((r) => r.zone === REFERENCE)
const target = measured.get(REFERENCE).all / ref.level
const table = {}
const rows = []
for (const r of rooms) {
  const { all, rest } = measured.get(r.zone)
  const perUnit = (all - rest) / r.scale
  let scale = r.zone === REFERENCE || perUnit <= 0 ? r.scale : (r.level * target - rest) / perUnit
  scale = Math.round(Math.min(2.5, Math.max(0.35, scale)) * 1000) / 1000
  if (Math.abs(scale - 1) > 0.005) table[r.zone] = scale
  rows.push({ zone: r.zone, level: r.level, seen: +all.toFixed(3), fromCeiling: +((all - rest) / all).toFixed(2), scale, after: +(rest + scale * perUnit).toFixed(3) })
}
console.table(rows)
const body = Object.entries(table).map(([zone, k]) => `  ${/^\w+$/.test(zone) ? zone : JSON.stringify(zone)}: ${k},`).join('\n')
writeFileSync(OUT, `// Generated by \`npm run light:calibrate\` (scripts/lighting/calibrate.mjs). Do not edit.
// Each room's ceiling-light output relative to the shared fittings, so its mean
// baked light on floor, walls and ceiling meets its level (\`ambient\`) × the main lab's.
import type { ZoneId } from './layout'

export const CEILING_LIGHT: Partial<Record<ZoneId, number>> = {${body ? `\n${body}\n` : ''}}
`)
console.log(`wrote src/three/lab/roomLight.gen.ts (${Object.keys(table).length} rooms scaled) in ${Math.round((performance.now() - started) / 1000)} s. Now run "npm run bake".`)

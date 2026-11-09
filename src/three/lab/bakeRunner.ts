// Runs lightmap bakes off the main thread and applies the results.
// Workers are classic workers from a blob: URL (the only kind the MnemoNexus
// sandbox allows), compiled ahead by scripts/addon/worker.mjs. A small pool bakes
// rooms in parallel behind the loading screen. If a worker cannot start or
// fails, its jobs run on the main thread between frames.
import * as THREE from 'three'
import { BAKE_WORKER_SOURCE } from './bake.worker.gen'
import { BAKE_SAMPLING, VOLUME_CELL } from '../quality'
import { runBake, type BakeJob, type BakeResult, type BakeVolumeSpec, type V3 } from './bake'
import type { LabBuild } from './build'
import { inputFingerprint } from './bakedLighting'
import { LAYOUT_VERSION, ZONES, roomPaint, zoneBounds, type ZoneId } from './layout'

const resultCache = new Map<string, BakeResult>()
const BAKE_CACHE_BYTES = 64 * 1024 * 1024
function cacheResult(key: string, result: BakeResult) {
  resultCache.delete(key)
  resultCache.set(key, result)
  let bytes = [...resultCache.values()].reduce((total, value) => total + value.atlas.byteLength, 0)
  while (bytes > BAKE_CACHE_BYTES && resultCache.size > 1) {
    const oldest = resultCache.keys().next().value!
    bytes -= resultCache.get(oldest)!.atlas.byteLength
    resultCache.delete(oldest)
  }
}

// Fill for light beyond the first bounce (which the baker gathers itself).
// Kept well below the troffers' direct light so walls and fronts fall off with
// distance from the panels instead of reading flat.
const AMBIENT: { up: V3; side: V3; down: V3 } = {
  up: [0.28, 0.28, 0.28],
  side: [0.24, 0.24, 0.24],
  down: [0.53, 0.53, 0.53],
}

/** Diffuse albedos the first bounce reflects (linear, before texture detail); walls for the labs' taupe. */
const BOUNCE = { wallAlbedo: 0.45, floorAlbedo: 0.55, ceilingAlbedo: 0.78 }
const LAB_PAINT = new THREE.Color('#b0aaa1')

/** The bounce for a room's own paint: lighter walls light its ceiling and floor more. */
function bounceFor(zone: ZoneId) {
  const paint = new THREE.Color(roomPaint(ZONES[zone]))
  const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
  return { ...BOUNCE, wallAlbedo: +(BOUNCE.wallAlbedo * lum(paint) / lum(LAB_PAINT)).toFixed(3) }
}

/** The room's irradiance-volume grid: its bounding box, floor to ceiling, in cubic cells. */
export function volumeSpec(zone: ZoneId, cell: number): BakeVolumeSpec {
  const z = ZONES[zone]
  const b = zoneBounds(z)
  return {
    origin: [b.minX + cell / 2, cell / 2, b.minZ + cell / 2],
    nx: Math.max(1, Math.ceil((b.maxX - b.minX) / cell)),
    ny: Math.max(1, Math.ceil(z.ceiling / cell)),
    nz: Math.max(1, Math.ceil((b.maxZ - b.minZ) / cell)),
    cell,
    poly: z.floor.flat(),
  }
}

/** A room's bake inputs, sampled for the shipped bake or for a fallback at load. */
export function bakeJob(lab: LabBuild, zone: ZoneId, sampling: keyof typeof BAKE_SAMPLING): BakeJob {
  const q = BAKE_SAMPLING[sampling]
  const shell = lab.shells[zone]
  return {
    id: zone,
    texel: lab.texel,
    atlasW: shell.atlasW,
    atlasH: shell.atlasH,
    islands: shell.islands,
    // walls are exact quads (openings left open), never stepped boxes
    boxes: new Float32Array(lab.ctx.occluders[zone]),
    quads: shell.wallQuads,
    planes: shell.planes,
    emitters: lab.ctx.emitters[zone],
    aoRays: q.aoRays,
    aoDist: 0.75,
    aoStrength: 0.88,
    samples: q.lightSamples,
    supersample: q.supersample,
    bounce: bounceFor(zone),
    ambient: AMBIENT,
    volume: volumeSpec(zone, VOLUME_CELL),
  }
}

/** The inputs and the sampling, so an edited room never reuses a stale bake. */
function cacheKey(job: BakeJob) {
  return `${inputFingerprint(job)}|${job.aoRays}|${job.samples}|${job.supersample ?? 1}`
}

interface Pending {
  job: BakeJob
  done: (r: BakeResult) => void
  fail: (err: unknown) => void
}

/** Bake on the main thread, a frame later so the page keeps painting. */
function bakeHere({ job, done, fail }: Pending) {
  setTimeout(() => {
    try {
      done(runBake(job))
    } catch (err) {
      fail(err)
    }
  }, 16)
}

interface Slot { worker: Worker; busy: Pending | null }

export class BakeRunner {
  private slots: Slot[] = []
  private workerUrl: string | null = null
  private queue: Pending[] = []
  private disposed = false

  constructor(size = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1))) {
    try {
      this.workerUrl = URL.createObjectURL(new Blob([BAKE_WORKER_SOURCE], { type: 'text/javascript' }))
      for (let i = 0; i < size; i++) {
        const slot: Slot = { worker: new Worker(this.workerUrl, { name: `lab-bake-${i}` }), busy: null }
        slot.worker.onmessage = (e: MessageEvent<BakeResult>) => {
          const p = slot.busy
          slot.busy = null
          p?.done(e.data)
          this.pump()
        }
        slot.worker.onerror = (e) => {
          // Handled here: an unhandled worker error reaches the page, and inside
          // MnemoNexus any uncaught error ends the run.
          e.preventDefault()
          this.retire(slot)
        }
        this.slots.push(slot)
      }
    } catch {
      for (const slot of [...this.slots]) this.retire(slot)
    }
  }

  get workers() { return this.slots.length }

  /** Drop a failed worker; its job (and the queue, if no worker is left) runs here. */
  private retire(slot: Slot) {
    slot.worker.terminate()
    this.slots = this.slots.filter((s) => s !== slot)
    if (slot.busy) bakeHere(slot.busy)
    slot.busy = null
    if (!this.slots.length) this.queue.splice(0).forEach(bakeHere)
  }

  private pump() {
    if (this.disposed) return
    if (!this.slots.length) { this.queue.splice(0).forEach(bakeHere); return }
    for (const slot of this.slots) {
      if (slot.busy) continue
      const next = this.queue.shift()
      if (!next) return
      slot.busy = next
      slot.worker.postMessage(next.job)
    }
  }

  /** Bake one job (results are cached per layout, quality and inputs). */
  run(job: BakeJob): Promise<BakeResult> {
    const key = `${LAYOUT_VERSION}|${job.id}|${cacheKey(job)}`
    const hit = resultCache.get(key)
    if (hit) { resultCache.delete(key); resultCache.set(key, hit); return Promise.resolve(hit) }
    return new Promise<BakeResult>((resolve, reject) => {
      if (this.disposed) return
      const done = (r: BakeResult) => {
        cacheResult(key, r)
        resolve(r)
      }
      this.queue.push({ job, done, fail: reject })
      this.pump()
    })
  }

  dispose() {
    this.disposed = true
    for (const slot of this.slots) slot.worker.terminate()
    this.slots = []
    this.queue = []
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl)
    this.workerUrl = null
  }
}

/** Upload a bake result into the room's shell materials (shared-exponent RGB, 4 bytes a texel). */
export function applyBake(lab: LabBuild, zone: ZoneId, r: BakeResult) {
  const shell = lab.shells[zone]
  const tex = new THREE.DataTexture(r.atlas, shell.atlasW, shell.atlasH, THREE.RGBFormat, THREE.UnsignedInt5999Type)
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearFilter
  tex.generateMipmaps = false
  tex.channel = 1
  tex.needsUpdate = true
  const mats = lab.shellMats[zone]
  const old = mats.wall.lightMap
  mats.setLightmap(tex)
  if (old && old.image && (old.image as { width: number }).width > 1) old.dispose()
}

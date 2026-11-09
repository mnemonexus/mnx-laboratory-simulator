// Pre-baked lighting shipped with the add-on (assets/lighting/bake.bin), so the
// loading screen uploads light instead of computing it. `npm run bake` writes
// the asset; the world applies a room's entry when its fingerprint matches the
// room it built, and bakes only stale rooms itself (a layout changed since).
//
// No three.js or DOM dependency: the Node bake tool imports this file too.
import type { BakeJob, BakeVolumeSpec } from './bake'

/** The asset's path inside the pack (and under public/ for the standalone build). */
export const BAKED_LIGHTING_PATH = 'assets/lighting/bake.bin'
const MAGIC = 0x314c424c // 'LBL1'

export interface BakedRoom {
  zone: string
  /** inputFingerprint of the job it was baked from */
  fingerprint: string
  atlasW: number
  atlasH: number
  /** RGB9E5, atlasW × atlasH */
  atlas: Uint32Array
  volume?: { spec: BakeVolumeSpec; data: Uint32Array }
}

interface HeaderRoom {
  zone: string
  fingerprint: string
  atlasW: number
  atlasH: number
  atlas: [number, number]
  volume?: { spec: BakeVolumeSpec; data: [number, number] }
}

/**
 * A hash of everything that shapes a room's light (geometry, surfaces, lights,
 * atlas layout and volume grid), but not the sample counts: an offline bake
 * matches a room however finely it was sampled.
 */
export function inputFingerprint(job: BakeJob) {
  let a = 0x811c9dc5 | 0
  let b = 0x01000193 | 0
  const mix = (v: number) => {
    a = Math.imul(a ^ v, 0x01000193)
    b = Math.imul(b ^ v, 0x5bd1e995) ^ (b >>> 13)
  }
  const num = (v: number) => mix(Math.round(v * 10000) | 0)
  const nums = (vs: ArrayLike<number>) => {
    mix(vs.length)
    for (let i = 0; i < vs.length; i++) num(vs[i])
  }
  num(job.texel)
  mix(job.atlasW)
  mix(job.atlasH)
  for (const isl of job.islands) {
    nums([isl.x, isl.y, isl.w, isl.h, isl.wM ?? -1, isl.hM ?? -1, ...isl.origin, ...isl.u, ...isl.v, ...isl.n])
    if (isl.poly) nums(isl.poly)
  }
  nums(job.boxes)
  if (job.boxAlbedo) nums(job.boxAlbedo)
  nums(job.planes)
  if (job.quads) nums(job.quads)
  const text = JSON.stringify([job.emitters, job.ambient, job.aoDist, job.aoStrength, job.bounce ?? null, job.volume ?? null])
  for (let i = 0; i < text.length; i++) mix(text.charCodeAt(i))
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')
}

/** Rooms → one uncompressed buffer (magic, header length, JSON header, then 32-bit data). */
export function encodeBakedLighting(rooms: BakedRoom[]) {
  const words: Uint32Array[] = []
  let offset = 0
  const place = (data: Uint32Array): [number, number] => {
    words.push(data)
    const at: [number, number] = [offset, data.length]
    offset += data.length
    return at
  }
  const header: HeaderRoom[] = rooms.map((r) => ({
    zone: r.zone,
    fingerprint: r.fingerprint,
    atlasW: r.atlasW,
    atlasH: r.atlasH,
    atlas: place(r.atlas),
    volume: r.volume ? { spec: r.volume.spec, data: place(r.volume.data) } : undefined,
  }))
  const json = new TextEncoder().encode(JSON.stringify({ version: 1, rooms: header }))
  const headerBytes = Math.ceil(json.length / 4) * 4
  const out = new Uint8Array(8 + headerBytes + offset * 4)
  const view = new DataView(out.buffer)
  view.setUint32(0, MAGIC, true)
  view.setUint32(4, json.length, true)
  out.set(json, 8)
  let at = 8 + headerBytes
  for (const w of words) {
    out.set(new Uint8Array(w.buffer, w.byteOffset, w.byteLength), at)
    at += w.byteLength
  }
  return out
}

/** The inverse of encodeBakedLighting; entries keyed `zone|fingerprint`. */
export function decodeBakedLighting(buffer: ArrayBuffer) {
  const view = new DataView(buffer)
  if (buffer.byteLength < 8 || view.getUint32(0, true) !== MAGIC) throw new Error('Not a baked-lighting asset')
  const length = view.getUint32(4, true)
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, length))) as { version: number; rooms: HeaderRoom[] }
  const base = 8 + Math.ceil(length / 4) * 4
  const words = (at: [number, number]) => new Uint32Array(buffer, base + at[0] * 4, at[1])
  const rooms = new Map<string, BakedRoom>()
  for (const r of header.rooms) {
    rooms.set(`${r.zone}|${r.fingerprint}`, {
      zone: r.zone,
      fingerprint: r.fingerprint,
      atlasW: r.atlasW,
      atlasH: r.atlasH,
      atlas: words(r.atlas),
      volume: r.volume ? { spec: r.volume.spec, data: words(r.volume.data) } : undefined,
    })
  }
  return rooms
}

let source: (() => Promise<ArrayBuffer | null>) | null = null

/** The host supplies the (gzip-compressed) asset; without one the lab bakes at load. */
export function provideBakedLighting(read: () => Promise<ArrayBuffer | null>) {
  source = read
}

/** Read, decompress and decode the shipped bake; an empty map when absent or unreadable. */
export async function loadBakedLighting(): Promise<Map<string, BakedRoom>> {
  if (!source) return new Map()
  try {
    const compressed = await source()
    if (!compressed) return new Map()
    // a stream, never a fetch: blob and data URLs are off limits in the sandbox
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))
    return decodeBakedLighting(await new Response(stream).arrayBuffer())
  } catch (error) {
    console.warn('Baked lighting unavailable; the lab will bake at load:', error)
    return new Map()
  }
}

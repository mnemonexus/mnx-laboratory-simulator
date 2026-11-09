// Lightmap and irradiance-volume baker (runs in a worker, or offline under Node;
// no three.js dependency).
//
// The lab is made of boxes inside rooms, which makes an exact, cheap ray caster
// possible: rays walk a 2-D grid of box buckets and test the room's walls as
// exact quads (openings left open) and its floor and ceiling as planes. For
// every lightmap texel it gathers
//   • direct light from area emitters (troffers, strips, windows) and small
//     spot emitters, sampled at stratified, per-texel rotated points, from
//     several jittered positions inside the texel — soft, unstepped shadows;
//   • one diffuse bounce: cosine-weighted rays whose hits are lit by next-event
//     estimation and scaled by that surface's albedo, plus a small ambient fill
//     for the further bounces, weighted by how open the texel is.
// Texels whose every sample lies inside a solid box are left out and filled by
// dilation, so contacts never darken their neighbours. The same estimator
// fills an irradiance volume (an ambient cube per cell) that lights moving and
// non-architectural objects consistently with the walls around them.

export type V3 = [number, number, number]

export interface BakeIsland {
  /** atlas pixel rectangle */
  x: number
  y: number
  w: number
  h: number
  origin: V3
  u: V3
  v: V3
  n: V3
  /** face size in metres along u and v (samples never leave the face) */
  wM?: number
  hM?: number
  /** xz polygon (flattened) — texels outside are filled by dilation */
  poly?: number[]
}

export type BakeEmitter =
  | { kind: 'rect'; c: V3; a: V3; b: V3; n: V3; L: V3 }
  | { kind: 'spot'; p: V3; d: V3; exp: number; I: V3; range: number }

export interface BakeVolumeSpec {
  /** world-space corner of cell (0, 0, 0)'s centre */
  origin: V3
  /** cell counts */
  nx: number
  ny: number
  nz: number
  cell: number
  /** room floor polygon (xz, flattened): cells outside it are filled from inside ones */
  poly?: number[]
}

export interface BakeJob {
  id: string
  texel: number
  atlasW: number
  atlasH: number
  islands: BakeIsland[]
  /** 6 floats per box: min xyz, max xyz */
  boxes: Float32Array
  /** albedo of each box (one per box; default 0.6) for the bounce */
  boxAlbedo?: Float32Array
  /** 4 floats per plane: n xyz, d — inside when n·p + d ≥ 0 (floor and ceiling) */
  planes: Float32Array
  /** wall pieces, 12 floats each: origin xyz, u xyz (full length), v xyz (full height), inward n xyz */
  quads?: Float32Array
  emitters: BakeEmitter[]
  /** cosine rays per texel for occlusion and the bounce */
  aoRays: number
  /** occlusion distance for the ambient fill */
  aoDist: number
  aoStrength: number
  /** stratified samples per area emitter, per axis */
  samples: number
  /** jittered sample positions per texel, per axis (1 = texel centre only) */
  supersample?: number
  /** first-bounce gather; without it only the ambient fill stands in for bounced light */
  bounce?: { wallAlbedo: number; floorAlbedo: number; ceilingAlbedo: number }
  ambient: { up: V3; side: V3; down: V3 }
  volume?: BakeVolumeSpec
}

export interface BakeResult {
  id: string
  /** shared-exponent RGB (RGB9E5), atlasW × atlasH */
  atlas: Uint32Array
  /** ambient cube per cell: 6 RGB9E5 values (+x, −x, +y, −y, +z, −z) laid out as six z-stacked blocks */
  volume?: Uint32Array
  timing: { texels: number; texelMs: number; cells?: number }
}

// ── shared-exponent RGB ────────────────────────────────────────────────────
// Bits 0–8 red, 9–17 green, 18–26 blue, 27–31 exponent: WebGPU's rgb9e5ufloat
// and WebGL 2's RGB9_E5 / UNSIGNED_INT_5_9_9_9_REV.
const RGB9E5_MAX = (511 / 512) * 65536
export function rgb9e5(r: number, g: number, b: number) {
  r = r > 0 ? Math.min(r, RGB9E5_MAX) : 0
  g = g > 0 ? Math.min(g, RGB9E5_MAX) : 0
  b = b > 0 ? Math.min(b, RGB9E5_MAX) : 0
  const m = Math.max(r, g, b)
  if (m <= 0) return 0
  let e = Math.max(-16, Math.floor(Math.log2(m))) + 16
  let scale = Math.pow(2, e - 24)
  if (Math.floor(m / scale + 0.5) === 512) {
    e++
    scale *= 2
  }
  const rm = Math.floor(r / scale + 0.5)
  const gm = Math.floor(g / scale + 0.5)
  const bm = Math.floor(b / scale + 0.5)
  return ((e << 27) | (bm << 18) | (gm << 9) | rm) >>> 0
}

export function fromRgb9e5(v: number): V3 {
  const scale = Math.pow(2, (v >>> 27) - 24)
  return [(v & 511) * scale, ((v >>> 9) & 511) * scale, ((v >>> 18) & 511) * scale]
}

// ── deterministic sampling ─────────────────────────────────────────────────
function hash(a: number, b: number, c: number) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(c + 0x165667b1, 0x27d4eb2f)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  h = Math.imul(h, 0x297a2d39)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

// ── acceleration grid ──────────────────────────────────────────────────────
class Grid {
  boxes: Float32Array
  count: number
  x0: number
  z0: number
  nx: number
  nz: number
  cs: number
  cells: Int32Array[]
  stamp: Uint32Array
  tick = 1
  /** face hit by the last cast: 0..5 = −x, +x, −y, +y, −z, +z; box index */
  hitFace = -1
  hitBox = -1

  constructor(boxes: Float32Array, cs = 0.5) {
    this.boxes = boxes
    this.count = boxes.length / 6
    let minX = Infinity
    let minZ = Infinity
    let maxX = -Infinity
    let maxZ = -Infinity
    for (let i = 0; i < this.count; i++) {
      minX = Math.min(minX, boxes[i * 6])
      minZ = Math.min(minZ, boxes[i * 6 + 2])
      maxX = Math.max(maxX, boxes[i * 6 + 3])
      maxZ = Math.max(maxZ, boxes[i * 6 + 5])
    }
    if (!this.count) {
      minX = minZ = 0
      maxX = maxZ = 1
    }
    this.cs = cs
    this.x0 = minX - 0.01
    this.z0 = minZ - 0.01
    this.nx = Math.max(1, Math.ceil((maxX - this.x0) / cs) + 1)
    this.nz = Math.max(1, Math.ceil((maxZ - this.z0) / cs) + 1)
    const lists: number[][] = Array.from({ length: this.nx * this.nz }, () => [])
    for (let i = 0; i < this.count; i++) {
      const cx0 = Math.max(0, Math.floor((boxes[i * 6] - this.x0) / cs))
      const cx1 = Math.min(this.nx - 1, Math.floor((boxes[i * 6 + 3] - this.x0) / cs))
      const cz0 = Math.max(0, Math.floor((boxes[i * 6 + 2] - this.z0) / cs))
      const cz1 = Math.min(this.nz - 1, Math.floor((boxes[i * 6 + 5] - this.z0) / cs))
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) lists[cz * this.nx + cx].push(i)
    }
    this.cells = lists.map((l) => Int32Array.from(l))
    this.stamp = new Uint32Array(this.count)
  }

  /** Is the point inside any box? */
  inside(x: number, y: number, z: number) {
    if (!this.count) return false
    const cx = Math.floor((x - this.x0) / this.cs)
    const cz = Math.floor((z - this.z0) / this.cs)
    if (cx < 0 || cz < 0 || cx >= this.nx || cz >= this.nz) return false
    const b = this.boxes
    for (const i of this.cells[cz * this.nx + cx]) {
      const o = i * 6
      if (x > b[o] && x < b[o + 3] && y > b[o + 1] && y < b[o + 4] && z > b[o + 2] && z < b[o + 5]) return true
    }
    return false
  }

  /** Nearest box hit distance in (0, tmax), or Infinity; `any` stops at the first hit. */
  cast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmax: number, any: boolean) {
    this.hitFace = -1
    this.hitBox = -1
    if (!this.count) return Infinity
    const b = this.boxes
    const cs = this.cs
    const tick = ++this.tick
    if (tick > 0xfffffff0) {
      this.stamp.fill(0)
      this.tick = 1
    }
    const idx = 1 / (dx || 1e-12)
    const idy = 1 / (dy || 1e-12)
    const idz = 1 / (dz || 1e-12)
    // clip the ray to the grid's xz extent
    let t0 = 0
    let t1 = tmax
    const gx1 = this.x0 + this.nx * cs
    const gz1 = this.z0 + this.nz * cs
    {
      let ta = (this.x0 - ox) * idx
      let tb = (gx1 - ox) * idx
      if (ta > tb) [ta, tb] = [tb, ta]
      t0 = Math.max(t0, ta)
      t1 = Math.min(t1, tb)
      ta = (this.z0 - oz) * idz
      tb = (gz1 - oz) * idz
      if (ta > tb) [ta, tb] = [tb, ta]
      t0 = Math.max(t0, ta)
      t1 = Math.min(t1, tb)
      if (t0 > t1) return Infinity
    }
    const sx = ox + dx * t0
    const sz = oz + dz * t0
    let cx = Math.min(this.nx - 1, Math.max(0, Math.floor((sx - this.x0) / cs)))
    let cz = Math.min(this.nz - 1, Math.max(0, Math.floor((sz - this.z0) / cs)))
    const stepX = dx > 0 ? 1 : -1
    const stepZ = dz > 0 ? 1 : -1
    let tMaxX = Math.abs(dx) < 1e-12 ? Infinity : (this.x0 + (cx + (dx > 0 ? 1 : 0)) * cs - ox) * idx
    let tMaxZ = Math.abs(dz) < 1e-12 ? Infinity : (this.z0 + (cz + (dz > 0 ? 1 : 0)) * cs - oz) * idz
    const tDX = Math.abs(dx) < 1e-12 ? Infinity : cs * Math.abs(idx)
    const tDZ = Math.abs(dz) < 1e-12 ? Infinity : cs * Math.abs(idz)
    let best = Infinity
    for (;;) {
      const list = this.cells[cz * this.nx + cx]
      for (let k = 0; k < list.length; k++) {
        const i = list[k]
        if (this.stamp[i] === tick) continue
        this.stamp[i] = tick
        const o = i * 6
        const minx = b[o]
        const miny = b[o + 1]
        const minz = b[o + 2]
        const maxx = b[o + 3]
        const maxy = b[o + 4]
        const maxz = b[o + 5]
        // rays that start inside a box ignore it (coplanar / touching parts)
        if (ox > minx && ox < maxx && oy > miny && oy < maxy && oz > minz && oz < maxz) continue
        let ta = (minx - ox) * idx
        let tb = (maxx - ox) * idx
        let tn = ta < tb ? ta : tb
        let tf = ta < tb ? tb : ta
        let face = ta < tb ? 0 : 1
        ta = (miny - oy) * idy
        tb = (maxy - oy) * idy
        let near = ta < tb ? ta : tb
        if (near > tn) {
          tn = near
          face = ta < tb ? 2 : 3
        }
        tf = Math.min(tf, ta < tb ? tb : ta)
        if (tn > tf) continue
        ta = (minz - oz) * idz
        tb = (maxz - oz) * idz
        near = ta < tb ? ta : tb
        if (near > tn) {
          tn = near
          face = ta < tb ? 4 : 5
        }
        tf = Math.min(tf, ta < tb ? tb : ta)
        if (tn > tf || tf < 0) continue
        const t = tn > 0 ? tn : 0
        if (t < tmax && t < best) {
          best = t
          this.hitFace = face
          this.hitBox = i
          if (any) return best
        }
      }
      const tNext = Math.min(tMaxX, tMaxZ)
      if (best <= tNext || tNext > t1) return best
      if (tMaxX < tMaxZ) {
        cx += stepX
        tMaxX += tDX
        if (cx < 0 || cx >= this.nx) return best
      } else {
        cz += stepZ
        tMaxZ += tDZ
        if (cz < 0 || cz >= this.nz) return best
      }
    }
  }
}

function pointInPoly(poly: number[], x: number, z: number) {
  let inside = false
  const n = poly.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2]
    const zi = poly[i * 2 + 1]
    const xj = poly[j * 2]
    const zj = poly[j * 2 + 1]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

// face normals for Grid.hitFace
const FACE_N: V3[] = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]]

class Scene {
  readonly grid: Grid
  readonly planes: Float32Array
  readonly quads: Float32Array
  readonly emitters: BakeEmitter[]
  readonly boxAlbedo: Float32Array | null
  readonly bounce: BakeJob['bounce']
  /** result of the last trace */
  hitN: V3 = [0, 0, 0]
  hitAlbedo = 0

  constructor(job: BakeJob) {
    this.grid = new Grid(job.boxes)
    this.planes = job.planes
    this.quads = job.quads ?? new Float32Array(0)
    this.emitters = job.emitters
    this.boxAlbedo = job.boxAlbedo ?? null
    this.bounce = job.bounce
  }

  /** Is anything opaque between the point and `tmax` along the ray? */
  blocked(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmax: number) {
    if (this.grid.cast(ox, oy, oz, dx, dy, dz, tmax, true) < tmax) return true
    return this.quadHit(ox, oy, oz, dx, dy, dz, tmax) < tmax
  }

  private quadHit(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmax: number) {
    const q = this.quads
    let best = tmax
    let hit = -1
    for (let i = 0; i < q.length; i += 12) {
      const nx = q[i + 9], ny = q[i + 10], nz = q[i + 11]
      const nd = nx * dx + ny * dy + nz * dz
      if (nd > -1e-6 && nd < 1e-6) continue
      const t = ((q[i] - ox) * nx + (q[i + 1] - oy) * ny + (q[i + 2] - oz) * nz) / nd
      if (t <= 1e-4 || t >= best) continue
      const hx = ox + dx * t - q[i], hy = oy + dy * t - q[i + 1], hz = oz + dz * t - q[i + 2]
      const ux = q[i + 3], uy = q[i + 4], uz = q[i + 5]
      const vx = q[i + 6], vy = q[i + 7], vz = q[i + 8]
      const s = (hx * ux + hy * uy + hz * uz) / (ux * ux + uy * uy + uz * uz)
      const r = (hx * vx + hy * vy + hz * vz) / (vx * vx + vy * vy + vz * vz)
      if (s < 0 || s > 1 || r < 0 || r > 1) continue
      best = t
      hit = i
    }
    if (hit >= 0) this.hitN = [this.quads[hit + 9], this.quads[hit + 10], this.quads[hit + 11]]
    return best
  }

  /** Nearest surface along the ray (boxes, walls, floor and ceiling); sets hitN and hitAlbedo. */
  trace(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmax: number) {
    let t = this.grid.cast(ox, oy, oz, dx, dy, dz, tmax, false)
    if (t < tmax) {
      this.hitN = FACE_N[this.grid.hitFace]
      this.hitAlbedo = this.boxAlbedo ? this.boxAlbedo[this.grid.hitBox] : 0.6
    }
    const tq = this.quadHit(ox, oy, oz, dx, dy, dz, Math.min(t, tmax))
    if (tq < t) {
      t = tq
      this.hitAlbedo = this.bounce?.wallAlbedo ?? 0.6
    }
    const p = this.planes
    for (let i = 0; i < p.length; i += 4) {
      const nd = p[i] * dx + p[i + 1] * dy + p[i + 2] * dz
      if (nd >= -1e-6) continue
      const tt = Math.max(0, -(p[i] * ox + p[i + 1] * oy + p[i + 2] * oz + p[i + 3]) / nd)
      if (tt < t && tt < tmax) {
        t = tt
        this.hitN = [p[i], p[i + 1], p[i + 2]]
        this.hitAlbedo = p[i + 1] > 0.5 ? this.bounce?.floorAlbedo ?? 0.5 : this.bounce?.ceilingAlbedo ?? 0.8
      }
    }
    return t
  }

  /**
   * Direct irradiance (in lightmap units) at a point and normal: `strata` × `strata`
   * stratified samples per area emitter, rotated by (ru, rv); spots once.
   * `ems` may pre-filter emitters that can reach this surface.
   */
  direct(ox: number, oy: number, oz: number, nx: number, ny: number, nz: number, strata: number, ru: number, rv: number, ems: BakeEmitter[], out: V3) {
    let r = 0
    let g = 0
    let bl = 0
    for (const e of ems) {
      if (e.kind === 'rect') {
        const area = 4 * Math.hypot(e.a[1] * e.b[2] - e.a[2] * e.b[1], e.a[2] * e.b[0] - e.a[0] * e.b[2], e.a[0] * e.b[1] - e.a[1] * e.b[0])
        const dA = area / (strata * strata)
        for (let a = 0; a < strata; a++) {
          for (let c = 0; c < strata; c++) {
            const fa = (((a + ru) % strata) / strata) * 2 - 1
            const fb = (((c + rv) % strata) / strata) * 2 - 1
            const qx = e.c[0] + e.a[0] * fa + e.b[0] * fb
            const qy = e.c[1] + e.a[1] * fa + e.b[1] * fb
            const qz = e.c[2] + e.a[2] * fa + e.b[2] * fb
            let lx = qx - ox
            let ly = qy - oy
            let lz = qz - oz
            const d2 = lx * lx + ly * ly + lz * lz
            const d = Math.sqrt(d2)
            lx /= d
            ly /= d
            lz /= d
            const cosR = lx * nx + ly * ny + lz * nz
            if (cosR <= 0) continue
            const cosE = -(lx * e.n[0] + ly * e.n[1] + lz * e.n[2])
            if (cosE <= 0) continue
            if (this.blocked(ox, oy, oz, lx, ly, lz, d - 0.02)) continue
            const f = (cosR * cosE * dA) / Math.max(d2, 0.04)
            r += e.L[0] * f
            g += e.L[1] * f
            bl += e.L[2] * f
          }
        }
      } else {
        // a small source (≈2 cm), jittered so its shadow edges stay soft
        const jx = (ru - Math.floor(ru) - 0.5) * 0.02
        const jz = (rv - Math.floor(rv) - 0.5) * 0.02
        let lx = e.p[0] + jx - ox
        let ly = e.p[1] - oy
        let lz = e.p[2] + jz - oz
        const d2 = lx * lx + ly * ly + lz * lz
        if (d2 > e.range * e.range) continue
        const d = Math.sqrt(d2)
        lx /= d
        ly /= d
        lz /= d
        const cosR = lx * nx + ly * ny + lz * nz
        if (cosR <= 0) continue
        const cosE = -(lx * e.d[0] + ly * e.d[1] + lz * e.d[2])
        if (cosE <= 0) continue
        if (this.blocked(ox, oy, oz, lx, ly, lz, d - 0.02)) continue
        const f = (Math.pow(cosE, e.exp) * cosR) / Math.max(d2, 0.01)
        r += e.I[0] * f
        g += e.I[1] * f
        bl += e.I[2] * f
      }
    }
    out[0] = r
    out[1] = g
    out[2] = bl
  }
}

/** Orthonormal tangent basis around n. */
function basis(nx: number, ny: number, nz: number) {
  let tx: number, ty: number, tz: number
  if (Math.abs(ny) < 0.9) {
    tx = nz
    ty = 0
    tz = -nx
  } else {
    tx = 0
    ty = -nz
    tz = ny
  }
  const l = Math.hypot(tx, ty, tz)
  tx /= l
  ty /= l
  tz /= l
  return [tx, ty, tz, ny * tz - nz * ty, nz * tx - nx * tz, nx * ty - ny * tx] as const
}

interface Estimate {
  /** direct irradiance (sharp shadows) */
  direct: V3
  /** bounced and ambient-fill irradiance (low-frequency; denoised harder) */
  indirect: V3
  /** openness 0..1 for the ambient fill */
  open: number
}

/** Rough emitter power at a point, for picking which emitter a bounce hit samples. */
function emitterWeight(e: BakeEmitter, px: number, py: number, pz: number) {
  if (e.kind === 'rect') {
    const area = 4 * Math.hypot(e.a[1] * e.b[2] - e.a[2] * e.b[1], e.a[2] * e.b[0] - e.a[0] * e.b[2], e.a[0] * e.b[1] - e.a[1] * e.b[0])
    const dx = e.c[0] - px, dy = e.c[1] - py, dz = e.c[2] - pz
    const d2 = dx * dx + dy * dy + dz * dz
    // points behind the panel get nothing
    const facing = -(dx * e.n[0] + dy * e.n[1] + dz * e.n[2]) / Math.sqrt(d2 || 1)
    if (facing <= 0) return 0
    return (e.L[0] + e.L[1] + e.L[2]) * area * (0.2 + facing) / (d2 + 0.25)
  }
  const dx = e.p[0] - px, dy = e.p[1] - py, dz = e.p[2] - pz
  const d2 = dx * dx + dy * dy + dz * dz
  if (d2 > e.range * e.range) return 0
  return (e.I[0] + e.I[1] + e.I[2]) / (d2 + 0.05)
}

/**
 * Irradiance at one surface point, from `subs` jittered positions (each gets
 * its share of the emitter samples and bounce rays).
 */
class Estimator {
  private readonly scene: Scene
  private readonly job: BakeJob
  private readonly tmp: V3 = [0, 0, 0]
  private readonly hitE: V3 = [0, 0, 0]
  private readonly emitterAt: BakeEmitter[][] = []
  private readonly weights: Float64Array

  constructor(scene: Scene, job: BakeJob) {
    this.scene = scene
    this.job = job
    this.emitterAt = job.emitters.map((e) => [e])
    this.weights = new Float64Array(job.emitters.length)
  }

  /** Ambient fill for a normal (bounce stand-in beyond the first bounce). */
  ambient(ny: number, out: V3) {
    const a = this.job.ambient
    if (ny >= 0) for (let k = 0; k < 3; k++) out[k] = a.side[k] + (a.up[k] - a.side[k]) * ny
    else for (let k = 0; k < 3; k++) out[k] = a.side[k] + (a.down[k] - a.side[k]) * -ny
  }

  /**
   * Bounced irradiance and openness over cosine-weighted rays from (o, n), with
   * one randomly chosen emitter lit at each hit (next-event estimation).
   */
  gather(ox: number, oy: number, oz: number, nx: number, ny: number, nz: number, rays: number, seed: number, out: V3) {
    const scene = this.scene
    const [tx, ty, tz, bx, by, bz] = basis(nx, ny, nz)
    const ems = this.job.emitters
    const aoDist = this.job.aoDist
    let r = 0, g = 0, b = 0, occ = 0
    const bounce = !!this.job.bounce && ems.length > 0
    const strata = Math.max(1, Math.round(Math.sqrt(rays)))
    for (let k = 0; k < rays; k++) {
      // stratified cosine-weighted direction, rotated per texel
      const u1 = ((k % strata) + hash(seed, k, 1)) / strata
      const u2 = (Math.floor(k / strata) % strata + hash(seed, k, 2)) / strata
      const rr = Math.sqrt(Math.min(1, u1))
      const phi = 2 * Math.PI * u2
      const hx = rr * Math.cos(phi), hy = rr * Math.sin(phi), hz = Math.sqrt(Math.max(0, 1 - rr * rr))
      const dx = tx * hx + bx * hy + nx * hz
      const dy = ty * hx + by * hy + ny * hz
      const dz = tz * hx + bz * hy + nz * hz
      const t = scene.trace(ox, oy, oz, dx, dy, dz, bounce ? 30 : aoDist)
      if (t < aoDist) occ += 1 - t / aoDist
      if (!bounce || !Number.isFinite(t) || t >= 30) continue
      const albedo = scene.hitAlbedo
      if (albedo <= 0) continue
      let hnx = scene.hitN[0], hny = scene.hitN[1], hnz = scene.hitN[2]
      if (hnx * dx + hny * dy + hnz * dz > 0) {
        hnx = -hnx
        hny = -hny
        hnz = -hnz
      }
      const px = ox + dx * t + hnx * 0.005
      const py = oy + dy * t + hny * 0.005
      const pz = oz + dz * t + hnz * 0.005
      // pick one emitter in proportion to its rough contribution at the hit
      let total = 0
      for (let e = 0; e < ems.length; e++) total += this.weights[e] = emitterWeight(ems[e], px, py, pz)
      if (total <= 0) continue
      let pick = 0
      for (let x = hash(seed, k, 3) * total; pick < ems.length - 1 && x >= this.weights[pick]; pick++) x -= this.weights[pick]
      if (this.weights[pick] <= 0) continue
      scene.direct(px, py, pz, hnx, hny, hnz, 1, hash(seed, k, 4), hash(seed, k, 5), this.emitterAt[pick], this.hitE)
      // radiance leaving the hit (in lightmap units: outgoing = albedo × irradiance),
      // divided by the pick's probability
      const w = albedo * total / this.weights[pick]
      r += this.hitE[0] * w
      g += this.hitE[1] * w
      b += this.hitE[2] * w
    }
    out[0] = r / rays
    out[1] = g / rays
    out[2] = b / rays
    return 1 - occ / rays
  }

  /** Irradiance at one point: direct from `ems`, gathered bounce (`rays` rays) and ambient fill. */
  estimate(px: number, py: number, pz: number, nx: number, ny: number, nz: number, ems: BakeEmitter[], seed: number, strata: number, rays: number, out: Estimate) {
    const job = this.job
    const ox = px + nx * 0.01
    const oy = py + ny * 0.01
    const oz = pz + nz * 0.01
    this.scene.direct(ox, oy, oz, nx, ny, nz, strata, hash(seed, 7, 0) * strata, hash(seed, 8, 0) * strata, ems, out.direct)
    const open = rays > 0 ? this.gather(ox, oy, oz, nx, ny, nz, rays, seed, this.tmp) : 1
    out.open = open
    const fill = 1 - job.aoStrength * (1 - open)
    // direct light is softened slightly by occlusion too (contact darkening)
    const directAo = 0.75 + 0.25 * fill
    const bounced = this.tmp
    const amb: V3 = [0, 0, 0]
    this.ambient(ny, amb)
    const ambientScale = job.bounce ? 0.45 : 1
    for (let k = 0; k < 3; k++) {
      out.direct[k] *= directAo
      out.indirect[k] = (job.bounce ? bounced[k] : 0) + amb[k] * fill * ambientScale
    }
  }
}

export function runBake(job: BakeJob): BakeResult {
  const tStart = performance.now()
  let texels = 0
  const scene = new Scene(job)
  const estimator = new Estimator(scene, job)
  const W = job.atlasW
  const H = job.atlasH
  const rgb = new Float32Array(W * H * 3)
  const ind = new Float32Array(W * H * 3)
  const valid = new Uint8Array(W * H)
  const islandOf = new Int16Array(W * H).fill(-1)
  const ns = Math.max(1, job.samples)
  const ss = Math.max(1, job.supersample ?? 1)
  const est: Estimate = { direct: [0, 0, 0], indirect: [0, 0, 0], open: 1 }
  const sum: V3 = [0, 0, 0]
  const sumI: V3 = [0, 0, 0]

  for (let ii = 0; ii < job.islands.length; ii++) {
    const isl = job.islands[ii]
    const [nx, ny, nz] = isl.n
    const wM = isl.wM ?? isl.w * job.texel
    const hM = isl.hM ?? isl.h * job.texel
    // emitters that can light this face at all
    const ext = Math.hypot(wM, hM)
    const cxI = isl.origin[0] + (isl.u[0] * wM + isl.v[0] * hM) * 0.5
    const cyI = isl.origin[1] + (isl.u[1] * wM + isl.v[1] * hM) * 0.5
    const czI = isl.origin[2] + (isl.u[2] * wM + isl.v[2] * hM) * 0.5
    const ems = job.emitters.filter((e) => {
      if (e.kind === 'spot') return Math.hypot(e.p[0] - cxI, e.p[1] - cyI, e.p[2] - czI) < e.range + ext * 0.5
      const vx = e.c[0] - isl.origin[0]
      const vy = e.c[1] - isl.origin[1]
      const vz = e.c[2] - isl.origin[2]
      // reject emitters facing away from the whole island plane
      return e.n[0] * nx + e.n[1] * ny + e.n[2] * nz < 0.999 && vx * nx + vy * ny + vz * nz > -0.01
    })
    // emitter strata and bounce rays per jittered position, so a texel's totals stay ≈ ns² and aoRays
    const strata = Math.max(1, Math.round(ns / ss))
    const rays = job.aoRays > 0 ? Math.max(4, Math.round(job.aoRays / (ss * ss))) : 0
    for (let j = 0; j < isl.h; j++) {
      for (let i = 0; i < isl.w; i++) {
        const ai = (isl.y + j) * W + (isl.x + i)
        sum[0] = sum[1] = sum[2] = 0
        sumI[0] = sumI[1] = sumI[2] = 0
        let n = 0
        for (let sj = 0; sj < ss; sj++) {
          for (let si = 0; si < ss; si++) {
            const seed = (ai * 16 + sj * ss + si) | 0
            // jittered position inside this texel, clamped to the real face
            const su = Math.min(wM - 0.002, Math.max(0.002, (i + (si + hash(seed, 11, ii)) / ss) * job.texel))
            const sv = Math.min(hM - 0.002, Math.max(0.002, (j + (sj + hash(seed, 12, ii)) / ss) * job.texel))
            const px = isl.origin[0] + isl.u[0] * su + isl.v[0] * sv
            const py = isl.origin[1] + isl.u[1] * su + isl.v[1] * sv
            const pz = isl.origin[2] + isl.u[2] * su + isl.v[2] * sv
            if (isl.poly && !pointInPoly(isl.poly, px, pz)) continue
            // a sample inside a solid box sees nothing: it is left out, never darkened
            if (scene.grid.inside(px + nx * 0.01, py + ny * 0.01, pz + nz * 0.01)) continue
            estimator.estimate(px, py, pz, nx, ny, nz, ems, seed, strata, rays, est)
            for (let k = 0; k < 3; k++) {
              sum[k] += est.direct[k]
              sumI[k] += est.indirect[k]
            }
            n++
          }
        }
        if (!n) continue
        valid[ai] = 1
        islandOf[ai] = ii
        texels++
        for (let k = 0; k < 3; k++) {
          rgb[ai * 3 + k] = sum[k] / n
          ind[ai * 3 + k] = sumI[k] / n
        }
      }
    }
  }

  // Direct light keeps its (already soft) shadow edges: a light 5×5 filter.
  // Bounced light is low-frequency but noisy: a wide one (≈ 25 cm at 5 cm texels).
  const out = smooth(rgb, valid, islandOf, W, H, 2)
  const indirect = smooth(ind, valid, islandOf, W, H, job.bounce ? 5 : 2)
  for (let i = 0; i < out.length; i++) out[i] += indirect[i]
  dilate(out, valid, W, H)

  const atlas = new Uint32Array(W * H)
  for (let i = 0; i < W * H; i++) atlas[i] = rgb9e5(out[i * 3], out[i * 3 + 1], out[i * 3 + 2])

  const result: BakeResult = { id: job.id, atlas, timing: { texels, texelMs: Math.round(performance.now() - tStart) } }
  if (job.volume) {
    const v0 = performance.now()
    result.volume = bakeVolume(job, scene, estimator)
    result.timing.cells = job.volume.nx * job.volume.ny * job.volume.nz
    result.timing.texelMs += Math.round(performance.now() - v0)
  }
  return result
}

/** Gaussian of the given radius inside each island's valid texels: hides residual sampling noise. */
function smooth(rgb: Float32Array, valid: Uint8Array, islandOf: Int16Array, W: number, H: number, radius: number) {
  const out = new Float32Array(rgb.length)
  const G = Array.from({ length: radius * 2 + 1 }, (_, k) => Math.exp(-((k - radius) ** 2) / (2 * (radius / 2) ** 2)))
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (!valid[i]) continue
      let r = 0
      let g = 0
      let b = 0
      let wsum = 0
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= H) continue
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= W) continue
          const k = yy * W + xx
          if (!valid[k] || islandOf[k] !== islandOf[i]) continue
          const w = G[dx + radius] * G[dy + radius]
          r += rgb[k * 3] * w
          g += rgb[k * 3 + 1] * w
          b += rgb[k * 3 + 2] * w
          wsum += w
        }
      }
      out[i * 3] = r / wsum
      out[i * 3 + 1] = g / wsum
      out[i * 3 + 2] = b / wsum
    }
  }
  return out
}

/** Dilate into invalid texels and padding so bilinear filtering never reads black. */
function dilate(out: Float32Array, valid: Uint8Array, W: number, H: number) {
  let filled = valid
  for (let pass = 0; pass < 6; pass++) {
    const next = filled.slice()
    let changed = false
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        if (filled[i]) continue
        let r = 0
        let g = 0
        let b = 0
        let n = 0
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy
          if (yy < 0 || yy >= H) continue
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx
            if (xx < 0 || xx >= W) continue
            const k = yy * W + xx
            if (!filled[k]) continue
            r += out[k * 3]
            g += out[k * 3 + 1]
            b += out[k * 3 + 2]
            n++
          }
        }
        if (n) {
          out[i * 3] = r / n
          out[i * 3 + 1] = g / n
          out[i * 3 + 2] = b / n
          next[i] = 1
          changed = true
        }
      }
    }
    filled = next
    if (!changed) break
  }
}

const CUBE: V3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

/**
 * Ambient cube per cell: the irradiance a surface facing each axis direction
 * would receive there, by the same estimator as the lightmap. Cells inside
 * solids take their valid neighbours' values, so trilinear lookups next to
 * casework never pull in darkness.
 */
function bakeVolume(job: BakeJob, scene: Scene, estimator: Estimator) {
  const v = job.volume!
  const { nx, ny, nz } = v
  const cells = nx * ny * nz
  const values = new Float32Array(cells * 18)
  const ok = new Uint8Array(cells)
  const est: Estimate = { direct: [0, 0, 0], indirect: [0, 0, 0], open: 1 }
  const strata = Math.max(1, Math.round(Math.max(1, job.samples) / 2))
  // a cell is one sample for a whole face of a cupboard: it needs more rays than a texel
  const rays = job.aoRays > 0 ? Math.max(16, job.aoRays * 2) : 0
  const insideRoom = (x: number, y: number, z: number) => {
    const p = job.planes
    for (let i = 0; i < p.length; i += 4) if (p[i] * x + p[i + 1] * y + p[i + 2] * z + p[i + 3] < 0) return false
    return true
  }
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = (k * ny + j) * nx + i
        const px = v.origin[0] + i * v.cell
        const py = v.origin[1] + j * v.cell
        const pz = v.origin[2] + k * v.cell
        if (!insideRoom(px, py, pz) || (v.poly && !pointInPoly(v.poly, px, pz)) || scene.grid.inside(px, py, pz)) continue
        ok[c] = 1
        for (let d = 0; d < 6; d++) {
          const [dx, dy, dz] = CUBE[d]
          estimator.estimate(px - dx * 0.01, py - dy * 0.01, pz - dz * 0.01, dx, dy, dz, job.emitters, (c * 6 + d) | 0, strata, rays, est)
          values[c * 18 + d * 3] = est.direct[0] + est.indirect[0]
          values[c * 18 + d * 3 + 1] = est.direct[1] + est.indirect[1]
          values[c * 18 + d * 3 + 2] = est.direct[2] + est.indirect[2]
        }
      }
    }
  }
  // a [1 2 1] filter along each axis over the measured cells hides what noise is left
  for (let axis = 0; axis < 3; axis++) {
    const src = values.slice()
    const step = axis === 0 ? 1 : axis === 1 ? nx : nx * ny
    const size = axis === 0 ? nx : axis === 1 ? ny : nz
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = (k * ny + j) * nx + i
      if (!ok[c]) continue
      const at = axis === 0 ? i : axis === 1 ? j : k
      let wsum = 2
      for (let q = 0; q < 18; q++) values[c * 18 + q] = src[c * 18 + q] * 2
      for (const s of [-1, 1]) {
        const o = c + s * step
        if (at + s < 0 || at + s >= size || !ok[o]) continue
        for (let q = 0; q < 18; q++) values[c * 18 + q] += src[o * 18 + q]
        wsum++
      }
      for (let q = 0; q < 18; q++) values[c * 18 + q] /= wsum
    }
  }
  // fill solid cells from valid neighbours, a few rings deep
  let filled = ok
  for (let pass = 0; pass < 4; pass++) {
    const next = filled.slice()
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = (k * ny + j) * nx + i
      if (filled[c]) continue
      let n = 0
      const acc = new Float32Array(18)
      for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj, kk = k + dk
        if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) continue
        const o = (kk * ny + jj) * nx + ii
        if (!filled[o]) continue
        for (let q = 0; q < 18; q++) acc[q] += values[o * 18 + q]
        n++
      }
      if (!n) continue
      for (let q = 0; q < 18; q++) values[c * 18 + q] = acc[q] / n
      next[c] = 1
    }
    filled = next
  }
  // six z-stacked blocks (direction-major), one RGB9E5 value per texel
  const out = new Uint32Array(cells * 6)
  for (let d = 0; d < 6; d++) {
    for (let c = 0; c < cells; c++) {
      const o = c * 18 + d * 3
      out[d * cells + c] = rgb9e5(values[o], values[o + 1], values[o + 2])
    }
  }
  return out
}

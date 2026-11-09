// Chair shadows from the room's own lights. Every light above the chair that
// can see it (each ceiling panel sampled across its area, each downlight; an
// under-cabinet strip only if the worktop doesn't hide it) casts its own shadow
// of the chair's parts, offset away from it. A wide panel gives a broad
// penumbra, a thin leg narrower than its penumbra only a faint antumbra, and
// where the shadows of several lights overlap the floor is darker. The light
// bounced off the ceiling and walls comes from the whole sky above the floor,
// so the chair blocks some of that too, softly, under the seat and base. The
// result is the share of the floor's light the chair blocks.
//
// Each light sample projects the chair's boxes onto the floor exactly (the
// convex hull of each box's projected corners) and the samples' weights add up
// per texel, so this is cheap enough to redo whenever a chair is moved.
import * as THREE from 'three'
import type { BakeEmitter, V3 } from './bake'

/** Ground extent of one chair's shadow (scene units, centred on the chair) and its resolution. */
export const CHAIR_SHADOW_SIZE = 1.8
export const CHAIR_SHADOW_RES = 128

/**
 * The share of an open floor point's light that comes straight from the room's
 * fittings; the rest has bounced off the ceiling and walls. Under a desk, where
 * the desk hides some fittings, the bounce is a larger share.
 */
const DIRECT_SHARE = 0.75
/** Samples across a panel, per side. */
const PANEL_SAMPLES = 5
/** A downlight's lens radius (architecture.ts), sampled at its centre and a ring of six. */
const LENS = 0.055
/** Lights further than this (horizontally) cast nothing worth drawing. */
const REACH = 5
/** Directions the bounced light arrives from (cosine-weighted over the sky). */
const SKY = 48
/** Where the chair sees its lights from: mid-height on its column. */
const EYE = 0.35
/** The outer share of the tile over which the shadow fades out. */
const BORDER = 0.1

/** A room's lights and its occluders (world boxes, six numbers each, as LabCtx keeps them). */
export interface ChairRoom { emitters: readonly BakeEmitter[]; occluders: readonly number[] }

type Box = { c: V3; h: V3; rx?: number; ry?: number; rz?: number }

/** The castor chair (buildChairModel) as boxes in its own frame. */
const PARTS: Box[] = [
  ...[0, 1, 2, 3, 4].flatMap((i): Box[] => {
    const a = (i / 5) * Math.PI * 2 + 0.3
    const at = (r: number, y: number): V3 => [r * Math.cos(a), y, -r * Math.sin(a)]
    return [
      // the arm, tilted slightly down towards its castor
      { c: at(0.164, 0.102), h: [0.1465, 0.022, 0.0245], ry: a, rz: -0.1 },
      // the castor and its fork
      { c: at(0.292, 0.042), h: [0.028, 0.042, 0.028], ry: a },
    ]
  }),
  { c: [0, 0.11, 0], h: [0.05, 0.04, 0.05] },
  { c: [0, 0.237, 0], h: [0.032, 0.115, 0.032] },
  { c: [0, 0.408, 0], h: [0.019, 0.067, 0.019] },
  { c: [0, 0.476, 0], h: [0.175, 0.014, 0.15] },
  { c: [0, 0.516, 0.01], h: [0.23, 0.036, 0.22] },
  { c: [0, 0.604, -0.252], h: [0.0235, 0.116, 0.013], rx: -0.08 },
  { c: [0, 0.82, -0.235], h: [0.204, 0.167, 0.035], rx: -0.08 },
]

const CORNERS: V3[][] = PARTS.map((p) => {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...p.c),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(p.rx ?? 0, p.ry ?? 0, p.rz ?? 0, 'YXZ')),
    new THREE.Vector3(1, 1, 1),
  )
  const out: V3[] = []
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const v = new THREE.Vector3(sx * p.h[0], sy * p.h[1], sz * p.h[2]).applyMatrix4(m)
    out.push([v.x, v.y, v.z])
  }
  return out
})
const TOP = Math.max(...CORNERS.flat().map((v) => v[1]))

interface Sample { x: number; y: number; z: number; w: number }

/** Cosine-weighted directions over the sky (a Fibonacci spiral in the unit disc, lifted). */
const SKY_DIRS: V3[] = Array.from({ length: SKY }, (_, i) => {
  const r = Math.sqrt((i + 0.5) / SKY), a = i * Math.PI * (3 - Math.sqrt(5))
  return [r * Math.cos(a), Math.sqrt(1 - r * r), r * Math.sin(a)]
})

/** Whether the segment from `a` to `b` passes through any of the room's boxes (other than one holding `a`). */
function blocked(occluders: readonly number[], a: V3, b: V3) {
  for (let i = 0; i < occluders.length; i += 6) {
    let t0 = 0, t1 = 1, inside = true
    for (let k = 0; k < 3 && t0 <= t1; k++) {
      const lo = occluders[i + k], hi = occluders[i + 3 + k], d = b[k] - a[k]
      if (a[k] < lo || a[k] > hi) inside = false
      if (Math.abs(d) < 1e-9) {
        if (a[k] < lo || a[k] > hi) t1 = -1
        continue
      }
      let u = (lo - a[k]) / d, v = (hi - a[k]) / d
      if (u > v) [u, v] = [v, u]
      t0 = Math.max(t0, u)
      t1 = Math.min(t1, v)
    }
    if (t0 <= t1 && !inside) return true
  }
  return false
}

/**
 * Light samples above a floor point that the chair there can see, each weighted
 * by the irradiance it gives that point, and the irradiance all of them would
 * give if nothing in the room were in the way.
 */
function samples(room: ChairRoom, x: number, z: number): { visible: Sample[]; open: number } {
  const visible: Sample[] = []
  let open = 0
  const lum = (c: V3) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  const eye: V3 = [x, EYE, z]
  const add = (sx: number, sy: number, sz: number, w: number) => {
    open += w
    if (!blocked(room.occluders, eye, [sx, sy, sz])) visible.push({ x: sx, y: sy, z: sz, w })
  }
  for (const e of room.emitters) {
    const p = e.kind === 'rect' ? e.c : e.p
    if (p[1] <= TOP + 0.05 || Math.hypot(p[0] - x, p[2] - z) > REACH) continue
    if (e.kind === 'rect') {
      // only panels facing down light the floor
      if (e.n[1] > -0.5) continue
      const area = 4 * Math.hypot(e.a[1] * e.b[2] - e.a[2] * e.b[1], e.a[2] * e.b[0] - e.a[0] * e.b[2], e.a[0] * e.b[1] - e.a[1] * e.b[0])
      const k = PANEL_SAMPLES
      for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
        const u = (2 * (i + 0.5)) / k - 1, v = (2 * (j + 0.5)) / k - 1
        const sx = e.c[0] + e.a[0] * u + e.b[0] * v, sy = e.c[1] + e.a[1] * u + e.b[1] * v, sz = e.c[2] + e.a[2] * u + e.b[2] * v
        const dx = sx - x, dz = sz - z, d2 = dx * dx + sy * sy + dz * dz, d = Math.sqrt(d2)
        // the floor's cosine and the panel's (it faces down)
        add(sx, sy, sz, (lum(e.L) * (area / (k * k)) * (sy / d) * (sy / d)) / d2)
      }
    } else {
      const dx = x - p[0], dy = -p[1], dz = z - p[2], d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2)
      const spot = Math.max(0, (dx * e.d[0] + dy * e.d[1] + dz * e.d[2]) / d) ** e.exp
      if (d > e.range || spot <= 0) continue
      const w = (lum(e.I) * spot * (-dy / d)) / Math.max(d2, 0.01) / 7
      add(p[0], p[1], p[2], w)
      for (let i = 0; i < 6; i++) add(p[0] + LENS * 0.8 * Math.cos((i * Math.PI) / 3), p[1], p[2] + LENS * 0.8 * Math.sin((i * Math.PI) / 3), w)
    }
  }
  return { visible, open }
}

/**
 * One chair's shadow at its pose: alpha (0…255) per texel of a square of
 * CHAIR_SHADOW_SIZE centred on the chair, in its own frame (columns along its
 * x, rows along its z), written into `out` at `offset` with row stride `stride`.
 */
export function chairShadow(room: ChairRoom, pose: { x: number; z: number; yaw: number }, out: Uint8Array, offset = 0, stride = CHAIR_SHADOW_RES) {
  const R = CHAIR_SHADOW_RES, S = CHAIR_SHADOW_SIZE
  const acc = new Float32Array(R * R)
  const stamp = new Int32Array(R * R).fill(-1)
  const { visible: lights, open } = samples(room, pose.x, pose.z)
  // the bounce an open floor point gets, from each direction of the sky the room leaves open
  const eye: V3 = [pose.x, EYE, pose.z]
  const sky = SKY_DIRS.filter((d) => !blocked(room.occluders, eye, [pose.x + d[0] * 3, EYE + d[1] * 3, pose.z + d[2] * 3]))
  const bounce = (open > 0 ? (open * (1 - DIRECT_SHARE)) / DIRECT_SHARE : 1) / SKY
  const total = lights.reduce((t, s) => t + s.w, 0) + sky.length * bounce
  const cos = Math.cos(pose.yaw), sin = Math.sin(pose.yaw)
  const hull: [number, number][] = []
  const projected: [number, number][] = new Array(8)
  const cast = (index: number, w: number, project: (c: V3) => [number, number]) => {
    for (const corners of CORNERS) {
      for (let k = 0; k < 8; k++) projected[k] = project(corners[k])
      convexHull(projected, hull)
      fillConvex(hull, (texel) => {
        if (stamp[texel] === index) return
        stamp[texel] = index
        acc[texel] += w
      })
    }
  }
  // each light sample blocks its share of the floor's light...
  lights.forEach((s, index) => {
    // the light sample in the chair's frame (inverse of its yaw and position)
    const wx = s.x - pose.x, wz = s.z - pose.z
    const lx = cos * wx - sin * wz, lz = sin * wx + cos * wz
    cast(index, s.w / total, ([cx, cy, cz]) => {
      const t = s.y / (s.y - cy)
      return [lx + (cx - lx) * t, lz + (cz - lz) * t]
    })
  })
  // ...and so does each open sky direction
  sky.forEach((d, i) => {
    const dx = cos * d[0] - sin * d[2], dz = sin * d[0] + cos * d[2]
    cast(lights.length + i, bounce / total, ([cx, cy, cz]) => [cx - (dx * cy) / d[1], cz - (dz * cy) / d[1]])
  })
  // a little blur hides the sampling steps in the widest penumbrae, and the
  // shadow fades out before the tile's edge
  const fade = (i: number) => Math.min(1, Math.max(0, (0.5 - Math.abs((i + 0.5) / R - 0.5)) / BORDER))
  for (let row = 0; row < R; row++) {
    for (let col = 0; col < R; col++) {
      let sum = 0, n = 0
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const r = row + dr, c = col + dc
        if (r < 0 || c < 0 || r >= R || c >= R) continue
        sum += acc[r * R + c]
        n++
      }
      out[offset + row * stride + col] = Math.round(Math.min(1, sum / n) * fade(row) * fade(col) * 255)
    }
  }
  function fillConvex(poly: [number, number][], set: (texel: number) => void) {
    if (poly.length < 3) return
    const toCol = (x: number) => (x / S + 0.5) * R - 0.5
    let minR = Infinity, maxR = -Infinity
    for (const [, z] of poly) { minR = Math.min(minR, toCol(z)); maxR = Math.max(maxR, toCol(z)) }
    const r0 = Math.max(0, Math.ceil(minR)), r1 = Math.min(R - 1, Math.floor(maxR))
    for (let row = r0; row <= r1; row++) {
      // this row's span through the polygon
      const z = ((row + 0.5) / R - 0.5) * S
      let lo = Infinity, hi = -Infinity
      for (let i = 0; i < poly.length; i++) {
        const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length]
        if ((az <= z && bz >= z) || (bz <= z && az >= z)) {
          const x = az === bz ? Math.min(ax, bx) : ax + ((z - az) / (bz - az)) * (bx - ax)
          const x2 = az === bz ? Math.max(ax, bx) : x
          lo = Math.min(lo, x, x2)
          hi = Math.max(hi, x, x2)
        }
      }
      if (lo > hi) continue
      const c0 = Math.max(0, Math.ceil(toCol(lo))), c1 = Math.min(R - 1, Math.floor(toCol(hi)))
      for (let col = c0; col <= c1; col++) set(row * R + col)
    }
  }
}

/** Andrew's monotone chain, into `out` (counter-clockwise, no repeated end point). */
function convexHull(points: [number, number][], out: [number, number][]) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  out.length = 0
  for (const q of p) {
    while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop()
    out.push(q)
  }
  const lower = out.length + 1
  for (let i = p.length - 2; i >= 0; i--) {
    const q = p[i]
    while (out.length >= lower && cross(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop()
    out.push(q)
  }
  out.pop()
}

// Room shells (lightmapped walls / floor / ceiling / cove base), door and
// window openings, and the suspended ceiling with its fixtures.
import * as THREE from 'three'
import { veneerBox } from './furnitureFinishes'
import { fixedFeed } from './powerRecords'
import type { BakeIsland, V3 } from './bake'
import type { LabCtx } from './context'
import { Batch, type BakeFace, type Palette } from './kit'
import type { DecalAtlas } from './decals'
import type { ShellMaterials } from './lighting'
import { CEILING_LIGHT } from './roomLight.gen'
import {
  DOORS,
  DOOR_H,
  DOOR_W,
  FAKE_DOORS,
  LEAF_H,
  LEAF_W as DEFAULT_LEAF_W,
  WINDOWS,
  doorFrame,
  doorWidth,
  leafWidth,
  polygonContains,
  wallHoles,
  zoneBounds,
  zoneWalls,
  type DoorDef,
  type Vec2,
  type WallEdge,
  type Zone,
  type ZoneId,
} from './layout'

// ── shell ───────────────────────────────────────────────────────────────────

class ShellGeo {
  pos: number[] = []
  nor: number[] = []
  uv: number[] = []
  uv1: number[] = []
  idx: number[] = []

  /** Quad from 4 corners (any winding); flipped so it faces `n`. */
  quad(p: V3[], n: V3, uv: [number, number][], uv1: [number, number][]) {
    const e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]]
    const e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]]
    const cx = e1[1] * e2[2] - e1[2] * e2[1]
    const cy = e1[2] * e2[0] - e1[0] * e2[2]
    const cz = e1[0] * e2[1] - e1[1] * e2[0]
    const flip = cx * n[0] + cy * n[1] + cz * n[2] < 0
    const base = this.pos.length / 3
    for (let i = 0; i < 4; i++) {
      this.pos.push(...p[i])
      this.nor.push(...n)
      this.uv.push(...uv[i])
      this.uv1.push(...uv1[i])
    }
    if (flip) this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2)
    else this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }

  /** Horizontal polygon (any simple shape, convex or not). */
  polygon(p: V3[], n: V3, uv: (q: V3) => [number, number], uv1: (q: V3) => [number, number]) {
    const base = this.pos.length / 3
    for (const q of p) {
      this.pos.push(...q)
      this.nor.push(...n)
      this.uv.push(...uv(q))
      this.uv1.push(...uv1(q))
    }
    const tris = THREE.ShapeUtils.triangulateShape(
      p.map((q) => new THREE.Vector2(q[0], q[2])),
      [],
    )
    for (const [a, b, c] of tris) {
      // y-component of (b − a) × (c − a) decides which way the triangle faces
      const ny = (p[b][2] - p[a][2]) * (p[c][0] - p[a][0]) - (p[b][0] - p[a][0]) * (p[c][2] - p[a][2])
      if (ny * n[1] < 0) this.idx.push(base + a, base + c, base + b)
      else this.idx.push(base + a, base + b, base + c)
    }
  }

  mesh(material: THREE.Material, name: string) {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    g.setAttribute('uv1', new THREE.Float32BufferAttribute(this.uv1, 2))
    g.setIndex(this.idx)
    g.computeBoundingSphere()
    const m = new THREE.Mesh(g, material)
    m.name = name
    m.matrixAutoUpdate = false
    m.receiveShadow = true
    return m
  }
}

interface IslandSpec {
  key: string
  wM: number
  hM: number
  origin: V3
  u: V3
  v: V3
  n: V3
  poly?: number[]
}

export interface ShellResult {
  zone: ZoneId
  group: THREE.Group
  islands: BakeIsland[]
  atlasW: number
  atlasH: number
  /** AO bounding planes (floor + ceiling: n xyz, d) */
  planes: Float32Array
  /** thin boxes just behind every wall face (line-of-sight tests; works for concave rooms) */
  wallBoxes: number[]
  /** exact wall pieces around the openings, for the light bake (12 floats each: origin, u, v, inward n) */
  wallQuads: Float32Array
  /** atlas pixel position of any packed island */
  place: (key: string) => { x: number; y: number }
}

const PAD = 2

function pack(specs: IslandSpec[], texel: number) {
  const sized = specs.map((s) => ({ s, w: Math.max(2, Math.ceil(s.wM / texel)), h: Math.max(2, Math.ceil(s.hM / texel)) }))
  const area = sized.reduce((a, b) => a + (b.w + PAD * 2) * (b.h + PAD * 2), 0)
  const widest = Math.max(...sized.map((s) => s.w + PAD * 2))
  let W = 64
  while (W < Math.max(widest, Math.sqrt(area) * 1.15)) W *= 2
  const order = [...sized].sort((a, b) => b.h - a.h)
  let x = 0
  let y = 0
  let row = 0
  const placed = new Map<string, { x: number; y: number; w: number; h: number }>()
  for (const it of order) {
    const fw = it.w + PAD * 2
    const fh = it.h + PAD * 2
    if (x + fw > W) {
      x = 0
      y += row
      row = 0
    }
    placed.set(it.s.key, { x: x + PAD, y: y + PAD, w: it.w, h: it.h })
    x += fw
    row = Math.max(row, fh)
  }
  let H = 64
  while (H < y + row) H *= 2
  return { W, H, placed }
}

export function buildShell(zone: Zone, texel: number, mats: ShellMaterials, extra: BakeFace[] = []): ShellResult {
  const b = zoneBounds(zone)
  const H = zone.ceiling
  const walls = zoneWalls(zone)
  const flat = zone.floor.flat()
  const specs: IslandSpec[] = [
    { key: 'floor', wM: b.maxX - b.minX, hM: b.maxZ - b.minZ, origin: [b.minX, 0, b.minZ], u: [1, 0, 0], v: [0, 0, 1], n: [0, 1, 0], poly: flat },
    { key: 'ceiling', wM: b.maxX - b.minX, hM: b.maxZ - b.minZ, origin: [b.minX, H, b.minZ], u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0], poly: flat },
    ...walls.map((w, i) => ({
      key: `wall${i}`,
      wM: w.length,
      hM: H,
      origin: [w.a[0], 0, w.a[1]] as V3,
      u: [w.t[0], 0, w.t[1]] as V3,
      v: [0, 1, 0] as V3,
      n: [w.n[0], 0, w.n[1]] as V3,
    })),
    ...extra.map((f) => ({ key: f.key, wM: f.wM, hM: f.hM, origin: f.origin, u: f.u, v: f.v, n: f.n })),
  ]
  const { W, H: AH, placed } = pack(specs, texel)
  const at = (key: string, s: number, t: number): [number, number] => {
    const r = placed.get(key)!
    return [(r.x + s / texel) / W, (r.y + t / texel) / AH]
  }

  const wallGeo = new ShellGeo()
  const floorGeo = new ShellGeo()
  const ceilGeo = new ShellGeo()
  const coveGeo = new ShellGeo()

  // floor + ceiling
  const floorPts = zone.floor.map(([x, z]) => [x, 0, z] as V3)
  floorGeo.polygon(
    floorPts,
    [0, 1, 0],
    (q) => [q[0], -q[2]],
    (q) => at('floor', q[0] - b.minX, q[2] - b.minZ),
  )
  const [gx, gz] = zone.gridOrigin
  ceilGeo.polygon(
    zone.floor.map(([x, z]) => [x, H, z] as V3),
    [0, -1, 0],
    (q) => [(q[0] - gx) / 1.2, (q[2] - gz) / 1.2],
    (q) => at('ceiling', q[0] - b.minX, q[2] - b.minZ),
  )

  // walls with openings + cove base
  const wallQuads: number[] = []
  walls.forEach((w, i) => {
    const key = `wall${i}`
    const n: V3 = [w.n[0], 0, w.n[1]]
    const P = (s: number, y: number, off = 0): V3 => [w.a[0] + w.t[0] * s + w.n[0] * off, y, w.a[1] + w.t[1] * s + w.n[1] * off]
    const rect = (s0: number, s1: number, y0: number, y1: number) => {
      if (s1 - s0 < 1e-4 || y1 - y0 < 1e-4) return
      wallQuads.push(...P(s0, y0), w.t[0] * (s1 - s0), 0, w.t[1] * (s1 - s0), 0, y1 - y0, 0, ...n)
      wallGeo.quad(
        [P(s0, y0), P(s1, y0), P(s1, y1), P(s0, y1)],
        n,
        [
          [s0, y0],
          [s1, y0],
          [s1, y1],
          [s0, y1],
        ],
        [at(key, s0, y0), at(key, s1, y0), at(key, s1, y1), at(key, s0, y1)],
      )
    }
    const holes = wallHoles(w).map((h) => ({ ...h, s0: Math.max(0, h.s0), s1: Math.min(w.length, h.s1) }))
    let s = 0
    for (const h of holes) {
      rect(s, h.s0, 0, H)
      rect(h.s0, h.s1, 0, h.y0)
      rect(h.s0, h.s1, h.y1, H)
      s = h.s1
    }
    rect(s, w.length, 0, H)

    // vinyl cove base, interrupted by doorways
    const doorHoles = holes.filter((h) => h.kind === 'door')
    let c = 0
    const coveRun = (s0: number, s1: number) => {
      if (s1 - s0 < 0.01) return
      const off = 0.006
      const top = 0.1
      coveGeo.quad(
        [P(s0, 0, off), P(s1, 0, off), P(s1, top, off), P(s0, top, off)],
        n,
        [
          [s0, 0],
          [s1, 0],
          [s1, top],
          [s0, top],
        ],
        [at(key, s0, 0.01), at(key, s1, 0.01), at(key, s1, top), at(key, s0, top)],
      )
      coveGeo.quad(
        [P(s0, top, 0), P(s1, top, 0), P(s1, top, off), P(s0, top, off)],
        [0, 1, 0],
        [
          [s0, 0],
          [s1, 0],
          [s1, 0.01],
          [s0, 0.01],
        ],
        [at(key, s0, top), at(key, s1, top), at(key, s1, top), at(key, s0, top)],
      )
    }
    for (const h of doorHoles) {
      coveRun(c, h.s0)
      c = h.s1
    }
    coveRun(c, w.length)
  })

  const group = new THREE.Group()
  group.name = `shell:${zone.id}`
  group.add(
    wallGeo.mesh(mats.wall, `${zone.id}:walls`),
    floorGeo.mesh(mats.floor, `${zone.id}:floor`),
    ceilGeo.mesh(mats.ceiling, `${zone.id}:ceiling`),
    coveGeo.mesh(mats.cove, `${zone.id}:cove`),
  )

  const islands: BakeIsland[] = specs.map((sp) => {
    const r = placed.get(sp.key)!
    return { x: r.x, y: r.y, w: r.w, h: r.h, wM: sp.wM, hM: sp.hM, origin: sp.origin, u: sp.u, v: sp.v, n: sp.n, poly: sp.poly }
  })

  const planes = new Float32Array([0, 1, 0, 0, 0, -1, 0, H])
  const wallBoxes = wallOccluders(walls, H)

  return { zone: zone.id, group, islands, atlasW: W, atlasH: AH, planes, wallBoxes, wallQuads: new Float32Array(wallQuads), place: (key) => placed.get(key)! }
}

/**
 * Bake occluder boxes (6 floats each) behind every wall, so light never leaks
 * between rooms. A slanted wall becomes a run of short axis-aligned boxes; each
 * box's corner pokes out by segment × |sin 2θ| / 2 (at most half a segment, at
 * 45°), so the run is recessed that far behind the face. Otherwise wall texels
 * test as inside a box (ambient only, no direct light) and grazing rays hit
 * the next corner.
 */
export function wallOccluders(walls: WallEdge[], H: number) {
  const SEG = 0.15
  const boxes: number[] = []
  for (const w of walls) {
    const axis = Math.abs(w.t[0]) > 0.999 || Math.abs(w.t[1]) > 0.999
    const steps = axis ? 1 : Math.ceil(w.length / SEG)
    const front = axis ? 0 : -(SEG / 2 + 0.005)
    const back = axis ? -0.12 : front - 0.12
    for (let i = 0; i < steps; i++) {
      const s0 = (w.length * i) / steps
      const s1 = (w.length * (i + 1)) / steps
      const xs: number[] = []
      const zs: number[] = []
      for (const s of [s0, s1]) {
        for (const d of [front, back]) {
          xs.push(w.a[0] + w.t[0] * s + w.n[0] * d)
          zs.push(w.a[1] + w.t[1] * s + w.n[1] * d)
        }
      }
      boxes.push(Math.min(...xs), 0, Math.min(...zs), Math.max(...xs), H, Math.max(...zs))
    }
  }
  return boxes
}

// ── door frames, leaves and windows ────────────────────────────────────────

const FRAME_GREY = '#b4b8bd'

/**
 * Hollow-metal frame around an opening, centred in the current frame: the
 * half on one side of the wall (towards -z or +z). Each room builds the half on
 * its side, lit and reflected by that room. Built whole in both rooms, the two
 * coincident copies showed whichever drew last: one room's light right across
 * the doorway, with a line down the frame and threshold where that room's box
 * ends. The halves meet under the door stop.
 */
function doorCasing(b: Batch, thickness: number, width = DOOR_W, kind: DoorDef['kind'] = 'single', side: 1 | -1 = 1) {
  const face = 0.05
  const depth = thickness + 0.03
  const half = width / 2
  // a part across the wall's thickness, cut at the wall's middle: this side's half
  const across = (mat: 'frame' | 'steel', x: number, y: number, w: number, h: number, d: number, color?: string) =>
    b.box(mat, x, y, (side * d) / 4, w, h, d / 2, color ? { color } : {})
  across('frame', -half + face / 2, DOOR_H / 2, face, DOOR_H, depth, FRAME_GREY)
  across('frame', half - face / 2, DOOR_H / 2, face, DOOR_H, depth, FRAME_GREY)
  across('frame', 0, DOOR_H - face / 2, width, face, depth, FRAME_GREY)
  if (kind === 'opening') {
    // floor bridge across the wall thickness, flush with the vinyl
    across('frame', 0, 0.002, width - face * 2, 0.004, thickness + 0.06, '#d9dbdc')
    return
  }
  // door stop
  across('frame', -half + face + 0.008, LEAF_H / 2, 0.016, LEAF_H, 0.04, FRAME_GREY)
  across('frame', half - face - 0.008, LEAF_H / 2, 0.016, LEAF_H, 0.04, FRAME_GREY)
  across('frame', 0, LEAF_H + 0.008, width - face * 2, 0.016, 0.04, FRAME_GREY)
  // threshold across the wall thickness, with the raised rib the leaf seals
  // on where the halves meet (built once, by the room on the -z side)
  across('steel', 0, 0.003, width - face * 2, 0.006, thickness + 0.03)
  if (side === -1) b.box('steel', 0, 0.008, 0, width - face * 2, 0.004, 0.012)
}

function yawFor(n: Vec2) {
  return Math.atan2(n[0], n[1])
}

/** Leaf geometry with its hinge at the local origin, extending along +x. */
export function buildLeaf(palette: Palette, atlas: DecalAtlas, detail: 'reduced' | 'full', pushSide: 1 | -1, LEAF_W = DEFAULT_LEAF_W, veneerId = 'default', glazing: 'clear' | 'obscure' = 'clear') {
  const b = new Batch('main', detail, atlas)
  const T = 0.044
  const y0 = 0.012
  const top = y0 + LEAF_H - 0.01
  // vision panel near the latch half
  const vx0 = LEAF_W * 0.55
  const vx1 = vx0 + 0.13
  const vy0 = 1.18
  const vy1 = 1.9
  const slab = (x0: number, x1: number, ya: number, yb: number) => b.add('walnut',veneerBox(x0,x1,ya,yb,-T/2,T/2,LEAF_W,LEAF_H,veneerId),undefined,undefined,true)
  slab(0, vx0, y0, top)
  slab(vx1, LEAF_W, y0, top)
  slab(vx0, vx1, y0, vy0)
  slab(vx0, vx1, vy1, top)
  // clear glass: the next room itself is drawn behind it (see Nav.visibleZones);
  // a door with only wall behind it has obscure (frosted) glass instead
  if (glazing === 'clear') b.box('glass', (vx0 + vx1) / 2, (vy0 + vy1) / 2, 0, vx1 - vx0, vy1 - vy0, 0.006)
  else b.box('plastic', (vx0 + vx1) / 2, (vy0 + vy1) / 2, 0, vx1 - vx0, vy1 - vy0, 0.006, { color: '#cdd3d8' })
  for (const s of [-1, 1]) {
    const z = (s * T) / 2 + s * 0.004
    // vision-panel trim
    b.span('steel', vx0 - 0.012, vy0 - 0.012, z - 0.004, vx1 + 0.012, vy0, z + 0.004)
    b.span('steel', vx0 - 0.012, vy1, z - 0.004, vx1 + 0.012, vy1 + 0.012, z + 0.004)
    b.span('steel', vx0 - 0.012, vy0, z - 0.004, vx0, vy1, z + 0.004)
    b.span('steel', vx1, vy0, z - 0.004, vx1 + 0.012, vy1, z + 0.004)
    // stainless kick plate
    b.span('satinSteel', 0.025, y0 + 0.005, z - 0.0015, LEAF_W - 0.025, y0 + 0.29, z + 0.0015)
    for(const x of [.04,LEAF_W-.04]) for(const y of [y0+.025,y0+.27]) b.cyl('chrome',x,y,z+s*.002,.002,.002,.001,{rx:Math.PI/2,seg:6})
    // lever handle
    const hx = LEAF_W - 0.075
    b.cyl('steel', hx, 1.0, s * (T / 2 + 0.008), 0.026, 0.028, 0.016, { rx: Math.PI / 2, seg: 18 })
    b.cyl('steel', hx, 1.0, s * (T / 2 + 0.03), 0.009, 0.009, 0.045, { rx: Math.PI / 2, seg: 10 })
    b.box('steel', hx - 0.06, 1.0, s * (T / 2 + 0.052), 0.13, 0.018, 0.018, { radius: 0.007 })
  }
  // hinges
  for (const y of [0.25, 1.05, 1.85]) b.cyl('steel', -0.004, y, -pushSide * 0.02, 0.008, 0.008, 0.11, { seg: 10 })
  // overhead closer on the pull (swing) side
  const pull = -pushSide
  b.box('frame', 0.3, top - 0.07, pull * (T / 2 + 0.03), 0.3, 0.06, 0.05, { color: '#a7acb2', radius: 0.008 })
  b.box('frame', 0.24, top + 0.01, pull * (T / 2 + 0.09), 0.3, 0.016, 0.022, { color: '#a7acb2', ry: 0.35 })
  return b.build(palette, 'leaf').group
}

/**
 * Move the triangles in front of a leaf's push face (that face, its trim, kick
 * plate and handle) into meshes of their own, so that side takes the light of
 * the room it faces. Lit by the room it swings into, a closed leaf's far side
 * read the light arriving there from the door itself: dark. Vertex buffers stay
 * shared; only the index splits.
 */
function splitPushSide(leaf: THREE.Object3D, pushSide: 1 | -1) {
  const push = new THREE.Group()
  push.name = 'push side'
  push.matrix.copy(leaf.matrix)
  push.matrix.decompose(push.position, push.quaternion, push.scale)
  leaf.updateMatrixWorld(true)
  const meshes: THREE.Mesh[] = []
  leaf.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh) })
  const p = new THREE.Vector3()
  for (const mesh of meshes) {
    const g = mesh.geometry
    const pos = g.getAttribute('position')
    const index = g.getIndex()
    const count = index ? index.count : pos.count
    const keep: number[] = []
    const move: number[] = []
    for (let i = 0; i < count; i += 3) {
      let z = 0
      for (let k = 0; k < 3; k++) z += p.fromBufferAttribute(pos, index ? index.getX(i + k) : i + k).applyMatrix4(mesh.matrix).z
      const tri = [0, 1, 2].map((k) => (index ? index.getX(i + k) : i + k))
      ;((z / 3) * pushSide > 0.01 ? move : keep).push(...tri)
    }
    if (!move.length) continue
    const part = (tris: number[]) => {
      const geo = new THREE.BufferGeometry()
      for (const [name, attribute] of Object.entries(g.attributes)) geo.setAttribute(name, attribute)
      geo.setIndex(tris)
      return geo
    }
    const side = new THREE.Mesh(part(move), mesh.material)
    side.name = `${mesh.name}:push`
    side.matrix.copy(mesh.matrix)
    side.matrix.decompose(side.position, side.quaternion, side.scale)
    side.castShadow = mesh.castShadow
    side.receiveShadow = mesh.receiveShadow
    side.renderOrder = mesh.renderOrder
    push.add(side)
    if (keep.length) mesh.geometry = part(keep)
    else mesh.removeFromParent()
  }
  return push
}

export interface DoorRuntime {
  def: DoorDef
  /** leaf width (a double door has two runtimes, one per leaf) */
  leafW: number
  pivot: THREE.Group
  /** the leaf, lit by the room it swings into... */
  leaf: THREE.Object3D
  /** ...except its push side, lit by the room that side faces */
  pushFaces: THREE.Group
  pushInto: ZoneId
  hinge: Vec2
  /** closed leaf direction (hinge → latch) */
  closedDir: Vec2
  swingDir: Vec2
  yaw0: number
  sign: number
  openness: number
}

export function buildDoors(ctx: LabCtx, palette: Palette, atlas: DecalAtlas) {
  const runtimes: DoorRuntime[] = []
  const group = new THREE.Group()
  group.name = 'doors'
  for (const d of DOORS) {
    // each room builds the half of the casing on its side (the normal points from a into b)
    for (const [z, side] of [[d.a, -1], [d.b, 1]] as const) {
      ctx.batch[z].at(d.center[0], 0, d.center[1], yawFor(d.normal), () => doorCasing(ctx.batch[z], d.thickness, doorWidth(d), d.kind, side))
    }
    if (d.kind === 'opening') continue
    const sides: (1 | -1)[] = d.kind === 'double' ? [d.hingeSide, d.hingeSide === 1 ? -1 : 1] : [d.hingeSide]
    const leafW = leafWidth(d)
    for (const side of sides) {
      const f = doorFrame(d, side)
      const closedDir: Vec2 = [-f.t[0] * side, -f.t[1] * side]
      const swingDir: Vec2 = [d.normal[0] * f.towardSwing, d.normal[1] * f.towardSwing]
      const yaw0 = Math.atan2(-closedDir[1], closedDir[0])
      // d(local x)/dyaw = (−sin θ, −cos θ); choose the sign that swings towards swingDir
      const sign = -Math.sin(yaw0) * swingDir[0] - Math.cos(yaw0) * swingDir[1] > 0 ? 1 : -1
      // leaf local +z points to the push (non-swing) side
      const localZ: Vec2 = [Math.sin(yaw0), Math.cos(yaw0)]
      const pushSide = localZ[0] * swingDir[0] + localZ[1] * swingDir[1] > 0 ? -1 : 1
      const pivot = new THREE.Group()
      pivot.name = `door:${d.id}${sides.length > 1 ? (side === d.hingeSide ? ':a' : ':b') : ''}`
      pivot.position.set(f.hinge[0], 0, f.hinge[1])
      const leaf = buildLeaf(palette, atlas, ctx.detail, pushSide, leafW, `${d.id}:${side}`)
      const pushFaces = splitPushSide(leaf, pushSide)
      pivot.add(leaf, pushFaces)
      group.add(pivot)
      const rt: DoorRuntime = { def: d, leafW, pivot, leaf, pushFaces, pushInto: d.swingInto === d.a ? d.b : d.a, hinge: f.hinge, closedDir, swingDir, yaw0, sign, openness: d.propped ?? 0 }
      pivot.rotation.y = yaw0 + sign * rt.openness * d.maxAngle
      runtimes.push(rt)
    }
  }
  return { group, doors: runtimes }
}

/** Current leaf segment for collision. */
export function leafSegment(d: DoorRuntime): [Vec2, Vec2] {
  const a = d.yaw0 + d.sign * d.openness * d.def.maxAngle
  return [d.hinge, [d.hinge[0] + Math.cos(a) * d.leafW, d.hinge[1] - Math.sin(a) * d.leafW]]
}

/** Where a door on a solid wall hangs its leaf: a real leaf, closed against the wall. */
export interface FakeLeaf {
  zone: ZoneId
  matrix: THREE.Matrix4
  veneer: string
}

/**
 * Doors drawn on a wall without an opening: exterior, delivery and escape doors.
 * Single doors hang the same leaf as a real door (built and lit by the caller),
 * so the two never differ in wood, trim, closer or light.
 */
export function buildFakeDoors(ctx: LabCtx): FakeLeaf[] {
  const LEAF_W = DEFAULT_LEAF_W
  const leaves: FakeLeaf[] = []
  for (const fd of FAKE_DOORS) {
    const b = ctx.batch[fd.zone]
    b.at(fd.center[0], 0, fd.center[1], yawFor(fd.normal), () => {
      const face = 0.05
      const W = fd.double ? DOOR_W * 1.5 : DOOR_W
      // casing proud of the wall, deep enough to frame a real leaf
      const depth = fd.double ? 0.03 : 0.06
      b.box('frame', -W / 2 + face / 2, DOOR_H / 2, depth / 2 - 0.005, face, DOOR_H, depth, { color: FRAME_GREY, radius: 0.004 })
      b.box('frame', W / 2 - face / 2, DOOR_H / 2, depth / 2 - 0.005, face, DOOR_H, depth, { color: FRAME_GREY, radius: 0.004 })
      b.box('frame', 0, DOOR_H - face / 2, depth / 2 - 0.005, W, face, depth, { color: FRAME_GREY, radius: 0.004 })
      if (fd.double) {
        // glazed entrance pair onto the outside
        const lw = (W - 0.11) / 2
        for (const s of [-1, 1]) {
          const x0 = s < 0 ? -W / 2 + face : 0.005
          b.span('frame', x0, 0.012, -0.004, x0 + lw, LEAF_H, 0.04, { color: '#c3c7cc' })
          // tinted glazing (the wall behind is solid, so no see-through)
          b.span('gloss', x0 + 0.06, 0.25, 0.04, x0 + lw - 0.06, LEAF_H - 0.08, 0.044, { color: '#3e4b58' })
          b.box('steel', s * 0.06, 1.05, 0.07, 0.025, 0.6, 0.025, { radius: 0.01 })
        }
        return
      }
      // the leaf: hinge at the casing's left, push side towards the room, back on the wall
      const leafT = 0.044
      leaves.push({ zone: fd.zone, matrix: b.matrix.clone().multiply(new THREE.Matrix4().makeTranslation(-LEAF_W / 2, 0, leafT / 2 + 0.003)), veneer: `fixed:${fd.zone}:${fd.center}` })
      if (fd.sign === 'EXIT') {
        fixedFeed(b,'illuminated exit sign',new THREE.Vector3(0,DOOR_H+.16,.03),new THREE.Vector3(0,DOOR_H+.16,-.025))
        b.box('plastic', 0, DOOR_H + 0.16, 0.05, 0.36, 0.16, 0.06, { color: '#f2f4f2' })
        b.decal('exit', 0, DOOR_H + 0.16, 0.081, 0.3, 0.12, 0, 'screen', 1.6)
      } else if (fd.sign) {
        b.decal(`plate-${fd.sign}`, LEAF_W / 2 + 0.2, 1.55, 0.004, 0.2, 0.12)
      }
    })
  }
  return leaves
}

export function buildWindows(ctx: LabCtx) {
  for (const w of WINDOWS) {
    const b = ctx.batch[w.zone]
    const h = w.head - w.sill
    const yaw = yawFor(w.normal)
    b.at(w.center[0], 0, w.center[1], yaw, () => {
      // local +z points into the room, wall face at z = 0, outside at z = −depth
      const half = w.width / 2
      const D = w.depth
      // painted reveals (plasterboard returns)
      b.span('laminate', -half, w.sill - 0.01, -D, -half + 0.01, w.head, 0, { color: '#e9e6e0' })
      b.span('laminate', half - 0.01, w.sill - 0.01, -D, half, w.head, 0, { color: '#e9e6e0' })
      b.span('laminate', -half, w.head - 0.01, -D, half, w.head, 0, { color: '#e9e6e0' })
      // A fixed commercial unit: slim powder-coated aluminium frame, vertical
      // mullions at most 1.5 apart, no sashes, transoms or handles.
      const fz = -D * 0.55
      const fw = 0.045
      const metal = '#aeb3b8'
      b.span('frame', -half, w.sill, fz - 0.035, -half + fw, w.head, fz + 0.035, { color: metal })
      b.span('frame', half - fw, w.sill, fz - 0.035, half, w.head, fz + 0.035, { color: metal })
      b.span('frame', -half, w.sill, fz - 0.035, half, w.sill + fw, fz + 0.035, { color: metal })
      b.span('frame', -half, w.head - fw, fz - 0.035, half, w.head, fz + 0.035, { color: metal })
      const panes = Math.max(1, Math.ceil((w.width - 0.05) / 1.5))
      for (let i = 1; i < panes; i++) {
        const x = -half + (w.width * i) / panes
        b.span('frame', x - 0.022, w.sill, fz - 0.04, x + 0.022, w.head, fz + 0.04, { color: metal })
      }
      b.plane('glass', 0, w.sill + h / 2, fz, w.width - 0.04, h - 0.04)
      if (w.sill > 0.3) {
        // solid-surface sill board (full-height glazing stands on the floor finish instead)
        b.span('laminate', -half - 0.03, w.sill - 0.022, -D, half + 0.03, w.sill, 0.035, { color: '#eceae5', radius: 0.004 })
      }
      // Exterior: the shared campus beyond is built by exterior.ts. Observation
      // glazing shows the neighbouring room itself, drawn through Nav's portals.
    })
    // dusk sky spill (very faint) for the bake
    if (w.kind === 'exterior') {
      const t: Vec2 = [-w.normal[1], w.normal[0]]
      ctx.emit(w.zone, {
        kind: 'rect',
        c: [w.center[0] - w.normal[0] * 0.05, (w.sill + w.head) / 2, w.center[1] - w.normal[1] * 0.05],
        a: [t[0] * (w.width / 2), 0, t[1] * (w.width / 2)],
        b: [0, h / 2, 0],
        n: [w.normal[0], 0, w.normal[1]],
        L: [0.05, 0.08, 0.17],
      })
    }
  }
}

// ── suspended ceiling ──────────────────────────────────────────────────────

export const TROFFER_RADIANCE = 6.2

export function buildCeiling(ctx: LabCtx, zone: Zone) {
  const b = ctx.batch[zone.id]
  const H = zone.ceiling
  const white = '#f3f3f1'
  for (const t of zone.troffers) {
    // flush 2×4 LED panel: trim ring + diffuser lens
    const y = H - 0.008
    fixedFeed(b,'ceiling luminaire',new THREE.Vector3(t.x,H,t.z),new THREE.Vector3(t.x+.08,H+.03,t.z))
    b.span('frame', t.x - t.w / 2, y - 0.006, t.z - t.d / 2, t.x + t.w / 2, y + 0.008, t.z - t.d / 2 + 0.03, { color: white })
    b.span('frame', t.x - t.w / 2, y - 0.006, t.z + t.d / 2 - 0.03, t.x + t.w / 2, y + 0.008, t.z + t.d / 2, { color: white })
    b.span('frame', t.x - t.w / 2, y - 0.006, t.z - t.d / 2, t.x - t.w / 2 + 0.03, y + 0.008, t.z + t.d / 2, { color: white })
    b.span('frame', t.x + t.w / 2 - 0.03, y - 0.006, t.z - t.d / 2, t.x + t.w / 2, y + 0.008, t.z + t.d / 2, { color: white })
    const L = TROFFER_RADIANCE * Math.PI * 0.9
    b.plane('lamp', t.x, y - 0.002, t.z, t.w - 0.06, t.d - 0.06, 0, new THREE.Color(L, L, L), Math.PI / 2)
    ctx.emit(zone.id, {
      kind: 'rect',
      c: [t.x, H - 0.02, t.z],
      a: [t.w / 2 - 0.03, 0, 0],
      b: [0, 0, t.d / 2 - 0.03],
      n: [0, -1, 0],
      L: scaled([TROFFER_RADIANCE, TROFFER_RADIANCE, TROFFER_RADIANCE], ceilingLight(zone)),
    })
  }
  const [gx, gz] = zone.gridOrigin
  const tile = (i: number, j: number): [number, number] => [gx + 0.3 + 0.6 * i, gz + 0.3 + 0.6 * j]
  const diffusers: Partial<Record<ZoneId, [number, number][]>> = {
    main: [tile(-5, 1), tile(3, -2)],
    post: [tile(1, -3)],
    cold: [tile(1, -3)],
  }
  for (const [x, z] of diffusers[zone.id] ?? autoDiffusers(zone)) {
    for (let r = 0; r < 4; r++) {
      const s = 0.58 - r * 0.12
      const y = H - 0.012 - r * 0.012
      b.span('frame', x - s / 2, y, z - s / 2, x + s / 2, y + 0.01, z - s / 2 + 0.03, { color: white })
      b.span('frame', x - s / 2, y, z + s / 2 - 0.03, x + s / 2, y + 0.01, z + s / 2, { color: white })
      b.span('frame', x - s / 2, y, z - s / 2, x - s / 2 + 0.03, y + 0.01, z + s / 2, { color: white })
      b.span('frame', x + s / 2 - 0.03, y, z - s / 2, x + s / 2, y + 0.01, z + s / 2, { color: white })
    }
    b.span('rubber', x - 0.09, H - 0.06, z - 0.09, x + 0.09, H - 0.055, z + 0.09, { color: '#3a3d42' })
  }
  downlights(ctx, zone)
  // sprinkler heads + smoke detector
  const bb = zoneBounds(zone)
  const cx = (bb.minX + bb.maxX) / 2
  const cz = (bb.minZ + bb.maxZ) / 2
  const suite = zone.id === 'main' || zone.id === 'post' || zone.id === 'cold'
  const sprinklers: [number, number][] =
    zone.id === 'main'
      ? [
          [-2.4, -1.2],
          [0, 1.2],
          [2.4, -1.2],
        ]
      : suite
        ? [[cx + 0.6, cz + 0.6]]
        : [freeSpot(zone, [cx + 0.6, cz + 0.6], 0.15)]
  for (const [x, z] of sprinklers) {
    b.cyl('chrome', x, H - 0.006, z, 0.03, 0.03, 0.01, { seg: 14 })
    b.cyl('chrome', x, H - 0.03, z, 0.008, 0.012, 0.04, { seg: 8 })
    b.cyl('chrome', x, H - 0.05, z, 0.022, 0.022, 0.004, { seg: 12 })
  }
  // suite rooms: the clear tile nearest the room centre, never inside a light panel
  const [sx, sz] = freeSpot(zone, suite ? [cx, cz] : [cx - 0.9, cz], 0.12)
  fixedFeed(b,'wired smoke detector',new THREE.Vector3(sx,H,sz),new THREE.Vector3(sx+.06,H+.03,sz))
  b.cyl('plastic', sx, H - 0.02, sz, 0.065, 0.07, 0.04, { color: '#f6f6f4' })
  b.cyl('glow', sx + 0.03, H - 0.041, sz, 0.004, 0.004, 0.002, { color: new THREE.Color(0, 2.4, 0.4) })
}

/**
 * A room's ceiling-light output, calibrated so every room's floor is lit to
 * its level (`npm run light:calibrate`). Only what the fittings cast into the
 * bake changes; the panels and lenses look the same everywhere.
 */
function ceilingLight(zone: Zone) {
  return CEILING_LIGHT[zone.id] ?? 1
}

const scaled = (v: V3, k: number): V3 => [v[0] * k, v[1] * k, v[2] * k]

/** Recessed downlight beam (warm-neutral, ≈3500 K) and the radiance of its visible lens. */
const DOWNLIGHT_I: [number, number, number] = [0.5, 0.45, 0.39]
const DOWNLIGHT_LENS = 14

/**
 * Small recessed downlights in rows along a room's long walls, in front of the
 * upper cabinets (look target 2026-10-27): they light the cabinet fronts and
 * worktops from above with soft falloff. Rooms narrower than a lab skip them.
 */
function downlights(ctx: LabCtx, zone: Zone) {
  const b = ctx.batch[zone.id]
  const H = zone.ceiling
  const bb = zoneBounds(zone)
  if (Math.min(bb.maxX - bb.minX, bb.maxZ - bb.minZ) < 2.4) return
  const walls = zoneWalls(zone)
    .filter((w) => Math.abs(w.t[0]) > 0.999 || Math.abs(w.t[1]) > 0.999)
    .sort((a, c) => c.length - a.length)
    .slice(0, 2)
  for (const w of walls) {
    const n = Math.max(1, Math.round((w.length - 1.2) / 1.25))
    for (let i = 0; i < n; i++) {
      const s = 0.6 + ((w.length - 1.2) * (i + 0.5)) / n
      const p: [number, number] = [w.a[0] + w.t[0] * s + w.n[0] * 0.78, w.a[1] + w.t[1] * s + w.n[1] * 0.78]
      if (blocked(zone, p, 0.1)) continue
      b.cyl('frame', p[0], H - 0.004, p[1], 0.075, 0.075, 0.008, { color: '#f1f1ef', seg: 24 })
      b.cyl('lamp', p[0], H - 0.009, p[1], 0.055, 0.055, 0.002, { color: new THREE.Color(DOWNLIGHT_LENS, DOWNLIGHT_LENS * 0.94, DOWNLIGHT_LENS * 0.86), seg: 24 })
      ctx.emit(zone.id, { kind: 'spot', p: [p[0], H - 0.03, p[1]], d: [0, -1, 0], exp: 3, I: scaled(DOWNLIGHT_I, ceilingLight(zone)), range: 3.6 })
    }
  }
}

/** True when a ceiling fitting of radius r at p would overlap a light panel or leave the room. */
function blocked(zone: Zone, p: [number, number], r: number) {
  if (zone.troffers.some((t) => Math.abs(t.x - p[0]) < t.w / 2 + r + 0.05 && Math.abs(t.z - p[1]) < t.d / 2 + r + 0.05)) return true
  return ![[0, 0], [r, r], [-r, -r], [r, -r], [-r, r]].every(([dx, dz]) => polygonContains(zone.floor, p[0] + dx, p[1] + dz))
}

/** Nearest ceiling spot to `want` (on the 0.3 grid) that is clear of panels. */
function freeSpot(zone: Zone, want: [number, number], r: number): [number, number] {
  for (let ring = 0; ring < 12; ring++) {
    for (let i = -ring; i <= ring; i++) {
      for (const [dx, dz] of [[i, -ring], [i, ring], [-ring, i], [ring, i]]) {
        const p: [number, number] = [want[0] + dx * 0.3, want[1] + dz * 0.3]
        if (!blocked(zone, p, r)) return p
      }
    }
  }
  return want
}

/** Supply diffusers for generated rooms: one per ~9 m² of ceiling, clear of the light panels. */
function autoDiffusers(zone: Zone): [number, number][] {
  const bb = zoneBounds(zone)
  const W = bb.maxX - bb.minX
  const D = bb.maxZ - bb.minZ
  const n = Math.max(1, Math.min(3, Math.round((W * D) / 9)))
  const along = W >= D
  const out: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const f = (i + 0.5) / n
    const want: [number, number] = [along ? bb.minX + W * f : bb.minX + W / 2, along ? bb.minZ + D / 2 : bb.minZ + D * f]
    const p = freeSpot(zone, want, 0.35)
    if (!blocked(zone, p, 0.35) && !out.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1.2)) out.push(p)
  }
  return out
}

/** Light switch / thermostat plates next to doors. */
export function wallPlate(b: Batch, kind: 'switch' | 'double' | 'thermostat') {
  if (kind === 'thermostat') {
    fixedFeed(b,'thermostat',new THREE.Vector3(0,0,0),new THREE.Vector3(0,0,-.035))
    b.box('plastic', 0, 0, 0.012, 0.09, 0.12, 0.024, { color: '#f4f4f2', radius: 0.008 })
    b.box('glow', 0, 0.02, 0.0245, 0.05, 0.03, 0.001, { color: new THREE.Color(0.3, 0.5, 0.65) })
    return
  }
  b.box('plastic', 0, 0, 0.004, kind === 'double' ? 0.12 : 0.072, 0.115, 0.008, { color: '#f6f6f3', radius: 0.004 })
  const n = kind === 'double' ? 2 : 1
  for (let i = 0; i < n; i++) {
    const x = n === 1 ? 0 : (i - 0.5) * 0.045
    b.box('plastic', x, 0, 0.0095, 0.022, 0.06, 0.004, { color: '#ffffff', radius: 0.002 })
  }
}

export { yawFor }

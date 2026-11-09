// Canonical floor plan of the Molecular Biology suite.
//
// Single source of truth for geometry, the lighting bake, walk collision and
// room culling. Coordinates are scene units; +x east, −z north, floor at y = 0.
// Use ../units for displayed spatial measurements; geometry stays unchanged.
//
//            ┌────────── Post-PCR / Gel ─────┬──── Cold storage ─────┐
//            │                               │  (extends further N)  │
//   hallway  │                               │                       │
//   ┌─────┐  ├─[door]───────────────────────┴──────────[door]───────┤
//   │     │  │  ↑ Post-PCR  ▓▓▓▓ Pre-PCR bench ▓▓▓▓   ↑ cold storage   │
//   │  ◄──┼──┤ entrance (swings into the lab)                         │ big window
//   │     │  │ sink        PRE-PCR / MAIN                            │
//   └─────┘  └──────────── microscopes · PC · reader ────────────────┘
//
// Visual reference: the "Bio Lab" photo set; the floor plan only fixes where
// doors lead and the general room sizes.

import { centimetresToSceneUnits } from '../units'
import { FACILITY_DOORS, FACILITY_EXITS, FACILITY_WINDOWS, FACILITY_ZONES, type FacilityZone } from './facility.gen'

/**
 * Room-level render group. The photo-matched suite uses `main`, `post`, `cold`
 * and `hall` (the Molecular lobby); every other zone is named after its
 * facility room id (docs/master-plan/facility/facility.json).
 */
export type ZoneId = string
export type Vec2 = [number, number]
export type Vec3 = [number, number, number]

export const BENCH_TOP = 0.9
export const UPPER_BOTTOM = 1.45
export const UPPER_TOP = 2.5
export const UPPER_DEPTH = 0.3
export const DOOR_W = 1.0 // rough opening incl. frame
export const DOOR_H = 2.15
export const LEAF_W = 0.91
export const LEAF_H = 2.1

export interface Troffer {
  x: number
  z: number
  /** size along x */
  w: number
  /** size along z */
  d: number
}

export interface Zone {
  id: ZoneId
  /** convex floor polygon */
  floor: Vec2[]
  ceiling: number
  /** reflection probe position */
  probe: Vec3
  troffers: Troffer[]
  /** ceiling-grid origin so troffers sit in whole tiles */
  gridOrigin: Vec2
  /** the room's light level relative to the labs (`npm run light:calibrate`) */
  ambient: number
  /** facility register entry (generated zones only) */
  room?: FacilityZone
}

/** Kinds of room people pass through rather than work in. */
export const CIRCULATION_KINDS = new Set(['circulation', 'hub', 'foyer'])

/**
 * Wall paint: taupe grey in the labs (the look target, 2026-10-27), a lighter
 * warm greige in the corridors, lobbies and commons (owner's commons
 * reference, 2026-10-27).
 */
export function roomPaint(zone: Zone) {
  return CIRCULATION_KINDS.has(zone.room?.kind ?? '') ? '#cdc5b6' : '#b0aaa1'
}

/** The photo-matched Molecular Biology suite: hand-tuned, never regenerated. */
const SUITE_ZONES: Record<'main' | 'post' | 'cold', Zone> = {
  main: {
    id: 'main',
    // the west wall steps back into a hand-washing alcove (z 0.3 … 1.5)
    floor: [
      [-4.3, -1.8],
      [4.3, -1.8],
      [4.3, 1.8],
      [-4.3, 1.8],
      [-4.3, 1.5],
      [-4.65, 1.5],
      [-4.65, 0.3],
      [-4.3, 0.3],
    ],
    ceiling: 2.75,
    probe: [0, 1.45, 0],
    troffers: [
      { x: -3.6, z: 0, w: 0.6, d: 1.2 },
      { x: -1.2, z: 0, w: 0.6, d: 1.2 },
      { x: 1.2, z: 0, w: 0.6, d: 1.2 },
      { x: 3.6, z: 0, w: 0.6, d: 1.2 },
    ],
    gridOrigin: [0.3, 0],
    ambient: 1,
  },
  post: {
    id: 'post',
    floor: [
      [-4.3, -1.95],
      [0, -1.95],
      [0, -5.2],
      [-4.3, -5.2],
    ],
    ceiling: 2.75,
    probe: [-2.1, 1.45, -3.5],
    troffers: [
      { x: -2.9, z: -3.55, w: 0.6, d: 1.2 },
      { x: -1.1, z: -3.55, w: 0.6, d: 1.2 },
    ],
    gridOrigin: [-3.2, -2.95],
    ambient: 1,
  },
  cold: {
    id: 'cold',
    floor: [
      [0.15, -1.95],
      [0.15, -6.2],
      [4.3, -6.2],
      [4.3, -1.95],
    ],
    ceiling: 2.75,
    probe: [2.25, 1.45, -4.05],
    troffers: [
      { x: 1.3, z: -4.1, w: 0.6, d: 1.2 },
      { x: 3.1, z: -4.1, w: 0.6, d: 1.2 },
    ],
    gridOrigin: [1.0, -3.5],
    ambient: 1,
  },
}

/** Every room of the facility, keyed by zone id (the lobby `hall` comes from facility.json). */
export const ZONES: Record<ZoneId, Zone> = {
  ...SUITE_ZONES,
  ...Object.fromEntries(
    FACILITY_ZONES.map((r): [ZoneId, Zone] => [
      r.id,
      { id: r.id, floor: r.floor, ceiling: r.ceiling, probe: r.probe, troffers: r.troffers, gridOrigin: r.gridOrigin, ambient: r.ambient, room: r },
    ]),
  ),
}

export const ZONE_IDS: ZoneId[] = ['main', 'post', 'cold', ...FACILITY_ZONES.map((r) => r.id)]

// ── openings ────────────────────────────────────────────────────────────────

export interface DoorDef {
  id: string
  /** rough opening incl. frame (default DOOR_W) */
  width?: number
  /** `opening`: a cased doorway without a leaf; `double`: two leaves */
  kind?: 'single' | 'double' | 'opening'
  /** only opens when approached from zone `a` (one-way workflow doors) */
  oneWay?: boolean
  /** airlock group: doors sharing it never stand open together */
  interlock?: string
  /** centre of the opening on the wall centre-line */
  center: Vec2
  /** unit normal pointing from zone `a` into zone `b` */
  normal: Vec2
  a: ZoneId
  b: ZoneId
  thickness: number
  /** hinge end, as a signed offset along the wall tangent (t = (-n.z, n.x)) */
  hingeSide: 1 | -1
  /** zone the leaf swings into */
  swingInto: ZoneId
  maxAngle: number
  /** fixed open amount, or auto-open on approach */
  propped?: number
}

export const DOORS: DoorDef[] = [
  {
    // swings into the lab, hinged away from the corner so it opens towards
    // the sink wall and never crosses the Post-PCR door or the corridor
    id: 'entrance',
    center: [-4.4, -0.65],
    normal: [-1, 0],
    a: 'main',
    b: 'hall',
    thickness: 0.2,
    hingeSide: -1,
    swingInto: 'main',
    maxAngle: 1.6,
  },
  {
    // north wall beside the corner; swings into Post-PCR along its west wall.
    // One-way: work moves Pre-PCR → Post-PCR and leaves by the Post-PCR exit.
    id: 'post',
    center: [-3.55, -1.875],
    normal: [0, -1],
    a: 'main',
    b: 'post',
    thickness: 0.15,
    hingeSide: -1,
    swingInto: 'post',
    maxAngle: 1.55,
    oneWay: true,
  },
  {
    id: 'cold',
    center: [2.85, -1.875],
    normal: [0, -1],
    a: 'main',
    b: 'cold',
    thickness: 0.15,
    hingeSide: 1,
    swingInto: 'cold',
    maxAngle: 1.55,
  },
  ...FACILITY_DOORS.map(
    (d): DoorDef => ({
      id: d.id,
      width: d.width,
      kind: d.kind,
      oneWay: d.oneWay,
      interlock: d.interlock ?? undefined,
      center: d.center,
      normal: d.normal,
      a: d.a,
      b: d.b,
      thickness: d.thickness,
      hingeSide: d.hingeSide,
      swingInto: d.swingInto,
      maxAngle: 1.55,
    }),
  ),
]

/** Opening width incl. frame, and the leaf that fits it. */
export const doorWidth = (d: DoorDef) => d.width ?? DOOR_W
export const leafWidth = (d: DoorDef) => (d.kind === 'double' ? (doorWidth(d) - 0.09) / 2 : doorWidth(d) - 0.09)

export interface WindowDef {
  id: string
  zone: ZoneId
  /** centre on the room-side wall face */
  center: Vec2
  /** inward normal (into the room) */
  normal: Vec2
  width: number
  sill: number
  head: number
  depth: number
  kind: 'exterior' | 'observation'
}

export const WINDOWS: WindowDef[] = [
  { id: 'main-east', zone: 'main', center: [4.3, 0], normal: [-1, 0], width: 1.8, sill: 1.0, head: 2.45, depth: 0.2, kind: 'exterior' },
  { id: 'cold-east', zone: 'cold', center: [4.3, -4.1], normal: [-1, 0], width: 1.5, sill: 1.08, head: 2.36, depth: 0.2, kind: 'exterior' },
  // the cold room's north window looks outside, toward the reserved sector (no painted lab view)
  { id: 'cold-obs', zone: 'cold', center: [3.1, -6.2], normal: [0, 1], width: 2.1, sill: 1.08, head: 2.36, depth: 0.2, kind: 'exterior' },
  ...FACILITY_WINDOWS.map((w): WindowDef => ({ ...w })),
]

/** Exterior doors: drawn on the wall without an opening (entrance, deliveries, escape). */
export const FAKE_DOORS: { zone: ZoneId; center: Vec2; normal: Vec2; sign?: '2.13' | '2.15' | 'EXIT'; double?: boolean }[] = FACILITY_EXITS.map((x) => ({
  zone: x.zone,
  center: x.center,
  normal: x.normal,
  sign: x.kind === 'escape' ? 'EXIT' : undefined,
  double: x.kind === 'entrance',
}))

// ── casework ────────────────────────────────────────────────────────────────

export type ModuleKind = 'drawers4' | 'door2' | 'door1' | 'drawerDoor' | 'knee' | 'open' | 'blind' | 'sink'

export interface BenchRun {
  id: string
  zone: ZoneId
  /** back-left corner at the wall when facing the bench */
  start: Vec2
  /** unit direction along the run (left → right when facing it) */
  dir: Vec2
  depth: number
  modules: { kind: ModuleKind; w: number }[]
  uppers?: { from: number; to: number; glazed?: boolean }
  /** finished end panels */
  ends?: { left?: boolean; right?: boolean }
  /** worktop upstand against the wall(s) */
  splash?: boolean
}

export const BENCHES: BenchRun[] = [
  {
    id: 'main-north',
    zone: 'main',
    start: [-2.75, -1.8],
    dir: [1, 0],
    depth: 0.76,
    modules: [
      { kind: 'drawers4', w: 0.6 },
      { kind: 'knee', w: 1.0 },
      { kind: 'drawers4', w: 0.5 },
      { kind: 'door2', w: 0.8 },
      { kind: 'drawers4', w: 0.5 },
      { kind: 'knee', w: 0.9 },
      { kind: 'drawers4', w: 0.6 },
    ],
    uppers: { from: 0, to: 4.9 },
    ends: { left: true, right: true },
  },
  {
    id: 'main-south',
    zone: 'main',
    start: [4.3, 1.8],
    dir: [-1, 0],
    depth: 0.76,
    modules: [
      { kind: 'blind', w: 0.76 },
      { kind: 'drawers4', w: 0.6 },
      { kind: 'door2', w: 0.9 },
      { kind: 'drawers4', w: 0.6 },
      { kind: 'door2', w: 0.9 },
      { kind: 'drawers4', w: 0.5 },
      { kind: 'knee', w: 1.0 },
      { kind: 'drawers4', w: 0.5 },
      { kind: 'knee', w: 0.9 },
      { kind: 'drawers4', w: 0.54 },
    ],
    uppers: { from: 1.4, to: 7.2 },
    ends: { right: true },
  },
  {
    id: 'main-east',
    zone: 'main',
    start: [4.3, -1.8],
    dir: [0, 1],
    depth: 0.76,
    // ends where main-south's worktop overhang begins (z 1.02): the slabs meet, never overlap
    modules: [
      { kind: 'door2', w: 0.9 },
      { kind: 'drawers4', w: 0.6 },
      { kind: 'door2', w: 0.8 },
      { kind: 'drawers4', w: 0.52 },
    ],
    ends: { left: true },
  },
  {
    // fills the recessed hand-washing alcove wall to wall
    id: 'main-sink',
    zone: 'main',
    start: [-4.65, 1.5],
    dir: [0, -1],
    depth: 0.6,
    modules: [
      { kind: 'drawerDoor', w: 0.3 },
      { kind: 'sink', w: 0.6 },
      { kind: 'drawerDoor', w: 0.3 },
    ],
    splash: true,
  },
  {
    // ends short of the north-east corner: the door to Amplification &
    // Sequencing (BI04) took the last two modules (2026-10-22)
    id: 'post-north',
    zone: 'post',
    start: [-3.55, -5.2],
    dir: [1, 0],
    depth: 0.76,
    modules: [
      { kind: 'drawers4', w: 0.6 },
      { kind: 'knee', w: 0.95 },
      { kind: 'door2', w: 0.8 },
    ],
    uppers: { from: 0, to: 2.35, glazed: true },
    ends: { left: true, right: true },
  },
  {
    id: 'post-south',
    zone: 'post',
    start: [0, -1.95],
    dir: [-1, 0],
    depth: 0.6,
    modules: [
      { kind: 'door2', w: 0.9 },
      { kind: 'drawers4', w: 0.6 },
      { kind: 'door2', w: 0.6 },
      { kind: 'door2', w: 0.6 },
    ],
    ends: { right: true },
  },
  {
    id: 'cold-north',
    zone: 'cold',
    start: [1.85, -6.2],
    dir: [1, 0],
    depth: 0.76,
    modules: [
      { kind: 'door2', w: 0.9 },
      { kind: 'drawers4', w: 0.6 },
      { kind: 'door2', w: 0.95 },
    ],
  },
]

export function benchLength(run: BenchRun) {
  return run.modules.reduce((a, m) => a + m.w, 0)
}

/** Inward (room-facing) normal of a bench run. */
export function benchInward(run: BenchRun): Vec2 {
  // facing the bench, `dir` points to your right, so the room is behind you
  return [-run.dir[1], run.dir[0]]
}

/** World point from bench-local coordinates: s along the run, d out from the wall. */
export function benchPoint(run: BenchRun, s: number, d: number): Vec2 {
  const n = benchInward(run)
  return [run.start[0] + run.dir[0] * s + n[0] * d, run.start[1] + run.dir[1] * s + n[1] * d]
}

/** Yaw that turns a model's local +z to face out of the bench into the room. */
export function benchYaw(run: BenchRun) {
  const n = benchInward(run)
  return Math.atan2(n[0], n[1])
}

export function bench(id: string) {
  const run = BENCHES.find((b) => b.id === id)
  if (!run) throw new Error(`unknown bench ${id}`)
  return run
}

// ── tall fixtures (also used for collision and as lighting occluders) ───────

export interface Fixture {
  id: string
  zone: ZoneId
  min: Vec3
  max: Vec3
}

export const FIXTURES: Fixture[] = [
  // cold storage
  { id: 'fume-hood', zone: 'cold', min: [0.35, 0, -6.2], max: [1.85, 2.38, -5.35] },
  { id: 'fridge-4', zone: 'cold', min: [0.32, 0, -2.78], max: [0.94, 1.95, -1.97] },
  { id: 'freezer-20', zone: 'cold', min: [0.97, 0, -2.78], max: [1.59, 1.95, -1.97] },
  { id: 'freezer-80', zone: 'cold', min: [1.62, 0, -2.84], max: [2.27, 1.98, -1.97] },
  { id: 'shelf-low-a', zone: 'cold', min: [3.84, 0, -5.0], max: [4.29, 1.02, -4.1] },
  { id: 'shelf-low-b', zone: 'cold', min: [3.84, 0, -4.08], max: [4.29, 1.02, -3.18] },
  { id: 'shelf-tall', zone: 'cold', min: [3.84, 0, -3.1], max: [4.29, 1.86, -2.0] },
  // post-PCR
  { id: 'shelf-cart', zone: 'post', min: [-4.29, 0, -5.15], max: [-3.84, 1.8, -3.95] },
  // moved off the north wall to keep the BI04 doorway clear
  { id: 'etbr-bin', zone: 'post', min: [-0.42, 0, -3.62], max: [-0.06, 0.62, -3.26] },
  // main
  { id: 'trash', zone: 'main', min: [-4.27, 0, -0.04], max: [-3.95, 0.68, 0.28] },
]

/** Task chairs: position, yaw (seat facing). */
export const CHAIRS: { zone: ZoneId; x: number; z: number; yaw: number }[] = [
  { zone: 'main', x: -1.65, z: -0.98, yaw: Math.PI },
  { zone: 'main', x: 1.1, z: -0.92, yaw: Math.PI + 0.25 },
  { zone: 'main', x: -0.46, z: 0.92, yaw: 0.1 },
  { zone: 'main', x: -1.91, z: 0.86, yaw: -0.3 },
  { zone: 'post', x: -2.47, z: -4.3, yaw: Math.PI - 0.15 },
]

// ── stations and cameras ────────────────────────────────────────────────────

export const ANCHORS = {
  /** Sample-prep work zone on the Pre-PCR bench (north wall, west end). */
  prep: {
    plate: [-1.75, BENCH_TOP, -1.28] as Vec3,
    pipette: [-1.45, BENCH_TOP + 0.2, -1.22] as Vec3,
    stockStart: [-2.3, -1.6] as Vec2,
    stockPitch: 0.105,
    rack: [-1.2, -1.52] as Vec2,
    tips: [-0.98, -1.32] as Vec2,
    sharps: [-0.74, BENCH_TOP, -1.52] as Vec3,
    beaker: [-0.48, -1.3] as Vec2,
  },
  reader: { pos: [0.8, BENCH_TOP, 1.44] as Vec3, yaw: Math.PI },
  readerSide: { rack: [0.28, 1.36] as Vec2, bottle: [0.4, 1.58] as Vec2 },
  centrifuge: { pos: [3.88, BENCH_TOP, -5.86] as Vec3, yaw: 0 },
  chromatography: { skid: [3.08, BENCH_TOP, -6.0] as Vec3, rack: [3.12, BENCH_TOP, -5.62] as Vec3 },
}

/**
 * Housings (W × H × D, centred on the anchor) of station instruments that
 * always stand at their anchors. They are runtime models, so the bake learns
 * of them here and shades the bench and wall around them.
 */
export const PERSISTENT_BODIES: { zone: ZoneId; pos: Vec3; yaw: number; size: Vec3 }[] = [
  { zone: 'main', pos: ANCHORS.reader.pos, yaw: ANCHORS.reader.yaw, size: [0.45, 0.4, 0.51] },
  { zone: 'cold', pos: ANCHORS.centrifuge.pos, yaw: ANCHORS.centrifuge.yaw, size: [0.29, 0.26, 0.48] },
]

export type SceneVariant = 'home' | 'overview' | 'prep' | 'reader' | 'centrifuge' | 'chromatography'

export interface ViewPreset {
  eye: Vec3
  focus: Vec3
  free: Vec3
}

export const WALK_EYE_HEIGHT = centimetresToSceneUnits(170) // 1.40 scene units
/** Chair cushion top (0.55) plus the seated torso/eye offset. */
export const SEATED_EYE_HEIGHT = 0.55 + centimetresToSceneUnits(65)

export const VIEWS: Record<SceneVariant, ViewPreset> = {
  // Composition of the "Bio Lab (Pre-PCR)" photo: down the long room to the window.
  home: { eye: [-3.05, WALK_EYE_HEIGHT, 0.12], focus: [4.3, 1.28, 0.0], free: [-3.05, 1.62, 0.12] },
  // Composition of the "Pre-PCR Backside" photo: back towards sink, entrance and the angled door.
  overview: { eye: [3.15, WALK_EYE_HEIGHT, 0.05], focus: [-4.3, 1.18, -0.15], free: [3.2, 1.9, 0.1] },
  prep: { eye: [-1.62, WALK_EYE_HEIGHT, -0.55], focus: [-1.62, 0.93, -1.38], free: [-1.3, 1.75, 0.3] },
  reader: { eye: [0.78, WALK_EYE_HEIGHT, 0.32], focus: [0.76, 1.04, 1.38], free: [0.2, 1.75, 0.1] },
  centrifuge: { eye: [3.75, WALK_EYE_HEIGHT, -4.85], focus: [3.88, 1.06, -5.84], free: [3.0, 1.8, -4.4] },
  chromatography: { eye: [3.12, 1.22, -5.05], focus: [3.12, 0.93, -5.66], free: [2.6, 1.6, -4.8] },
}

/**
 * Lab display: hung from the ceiling near the window corner, in front of the
 * south uppers, angled towards the middle of the room so it reads from
 * anywhere in the Pre-PCR lab.
 */
export const TV = { pos: [3.76, 2.1, 1.37] as Vec3, faces: [-0.49, -1.28] as Vec2 }

export const LAYOUT_VERSION = 5

// ── geometry helpers ────────────────────────────────────────────────────────

export function polygonContains(poly: Vec2[], x: number, z: number) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]
    const [xj, zj] = poly[j]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

export function zoneBounds(z: Zone) {
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const [x, zz] of z.floor) {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minZ = Math.min(minZ, zz)
    maxZ = Math.max(maxZ, zz)
  }
  return { minX, maxX, minZ, maxZ }
}

export interface WallEdge {
  zone: ZoneId
  a: Vec2
  b: Vec2
  length: number
  /** unit tangent a → b */
  t: Vec2
  /** inward normal */
  n: Vec2
  height: number
}

/** Inner wall faces of a zone, one per polygon edge. */
export function zoneWalls(zone: Zone): WallEdge[] {
  const poly = zone.floor
  return poly.map((a, i) => {
    const b = poly[(i + 1) % poly.length]
    const dx = b[0] - a[0]
    const dz = b[1] - a[1]
    const length = Math.hypot(dx, dz)
    const t: Vec2 = [dx / length, dz / length]
    let n: Vec2 = [-t[1], t[0]]
    // inward = the side of the edge that lies inside the (possibly concave) room
    const mx = (a[0] + b[0]) / 2
    const mz = (a[1] + b[1]) / 2
    if (!polygonContains(poly, mx + n[0] * 0.02, mz + n[1] * 0.02)) n = [-n[0], -n[1]]
    return { zone: zone.id, a, b, length, t, n, height: zone.ceiling }
  })
}

export interface WallHole {
  /** along-edge start / end */
  s0: number
  s1: number
  y0: number
  y1: number
  kind: 'door' | 'window'
  ref: string
}

/** Openings that pierce a given wall face. */
export function wallHoles(edge: WallEdge): WallHole[] {
  const holes: WallHole[] = []
  const project = (p: Vec2) => {
    const rx = p[0] - edge.a[0]
    const rz = p[1] - edge.a[1]
    return { s: rx * edge.t[0] + rz * edge.t[1], off: Math.abs(rx * edge.n[0] + rz * edge.n[1]) }
  }
  for (const d of DOORS) {
    if (d.a !== edge.zone && d.b !== edge.zone) continue
    const { s, off } = project(d.center)
    const parallel = Math.abs(d.normal[0] * edge.n[0] + d.normal[1] * edge.n[1]) > 0.95
    if (!parallel || off > Math.max(d.thickness, 0.05) || s < 0 || s > edge.length) continue
    const w = doorWidth(d)
    holes.push({ s0: s - w / 2, s1: s + w / 2, y0: 0, y1: DOOR_H, kind: 'door', ref: d.id })
  }
  for (const w of WINDOWS) {
    if (w.zone !== edge.zone) continue
    const { s, off } = project(w.center)
    const parallel = Math.abs(w.normal[0] * edge.n[0] + w.normal[1] * edge.n[1]) > 0.95
    if (!parallel || off > 0.05 || s < 0 || s > edge.length) continue
    holes.push({ s0: s - w.width / 2, s1: s + w.width / 2, y0: w.sill, y1: w.head, kind: 'window', ref: w.id })
  }
  return holes.sort((p, q) => p.s0 - q.s0)
}

/** Door hinge, closed-leaf direction and swing sign (`side` picks the leaf of a double door). */
export function doorFrame(d: DoorDef, side: 1 | -1 = d.hingeSide) {
  const t: Vec2 = [-d.normal[1], d.normal[0]]
  const reach = d.kind === 'double' ? doorWidth(d) / 2 - 0.045 : leafWidth(d) / 2
  const hinge: Vec2 = [d.center[0] + t[0] * side * reach, d.center[1] + t[1] * side * reach]
  // leaf sits flush with the face of the wall it swings away from
  const towardSwing = d.swingInto === d.b ? 1 : -1
  const face = (d.thickness / 2 - 0.02) * towardSwing
  return { t, hinge: [hinge[0] + d.normal[0] * face, hinge[1] + d.normal[1] * face] as Vec2, towardSwing }
}

// Furniture, fixtures and signage for the generated facility rooms.
//
// Every room gets a recipe (tall fixtures against the walls, perimeter
// casework, bench instruments, an optional island or centrepiece). A small
// allocator places them along the walls, clear of doorways, windows and each
// other. The photo-matched suite (main, post, cold) and the lobby keep their
// hand-built props in props.ts.
import * as THREE from 'three'
import { appliance, powerInlet } from './powerRecords'
import type { LabCtx } from './context'
import type { Batch } from './kit'
import { movableStorage } from './storage'
import { buildBench, outlet, carcass } from './casework'
import { wallPlate, yawFor } from './architecture'
import {
  bottle,
  carton,
  chair,
  compoundMicroscope,
  microfuge,
  monitor,
  pcTower,
  plateReader,
  plant,
  soapDispenser,
  gloveDispenser,
  stereoMicroscope,
  thermocycler,
  tipBox,
  trashCan,
  tubeRack,
  vortex,
  wireShelf,
} from './props'
import { rng } from './surfaces'
import { beakerGeometry, instrumentCasingGeometry } from '../equipmentGeometry'
import {
  BENCH_TOP,
  DOORS,
  DOOR_H,
  DOOR_W,
  FAKE_DOORS,
  WINDOWS,
  doorFrame,
  ZONES,
  benchPoint,
  benchYaw,
  doorWidth,
  leafWidth,
  polygonContains,
  zoneWalls,
  type BenchRun,
  type ModuleKind,
  type Vec2,
  type Zone,
  type ZoneId,
} from './layout'

const WHITE = '#f2f3f4'
const OFFWHITE = '#e7e9eb'
const GREY = '#c9cdd2'
const DARK = '#24272c'
const BLUE = '#1e56c8'
const HAND_BUILT = new Set(['main', 'post', 'cold', 'hall'])
const CIRCULATION = new Set(['circulation', 'hub', 'foyer'])
const BENCH_D = 0.76

// ── recipes ────────────────────────────────────────────────────────────────

type Tall =
  | 'hood' | 'hood2' | 'walkInHood' | 'bsc' | 'fridge' | 'freezer20' | 'freezer80' | 'chemFridge' | 'shelf' | 'cabinet'
  | 'autoclave' | 'washer' | 'incubators' | 'fplc' | 'floorInst' | 'floorInstTall' | 'glovebox' | 'xrd' | 'flamCab' | 'corrCab'
  | 'gasRack' | 'dewars' | 'lockers' | 'lockerBank' | 'ovenStack' | 'tissueProc' | 'chest80' | 'iceMachine' | 'nitrogenGen' | 'coatHooks'
  | 'cryostat' | 'shaker' | 'centrifugeFloor' | 'bookcase' | 'icp' | 'balanceTable' | 'radioBench'
type Top =
  | 'pc' | 'microscope' | 'stereo' | 'balance' | 'stirrer' | 'rotavap' | 'phMeter' | 'spec' | 'plateReader' | 'microfuge'
  | 'vortex' | 'thermocycler' | 'instrument' | 'instrumentTall' | 'hplc' | 'gc' | 'ms' | 'bottles' | 'waterBath' | 'oven'
  | 'tubeFurnace' | 'gelTank' | 'bioreactor' | 'counter' | 'shield' | 'tips' | 'racks' | 'tlcLamp' | 'sonicator' | 'digester'
  | 'flash' | 'pcrHood' | 'microtome' | 'stainer' | 'analyser' | 'ecg' | 'organBath' | 'meltingPoint' | 'polarimeter' | 'ftir'
  | 'potentiostat' | 'calorimeter' | 'colonyCounter' | 'cellCounter' | 'ballMill' | 'manifold' | 'beakers'
type Center = 'island' | 'nmr' | 'opticalTable' | 'laserEnclosure' | 'confocal' | 'confocalBay' | 'ephys' | 'hubConsole' | 'desks' | 'bench'
type Decor = 'notice' | 'extinguisher' | 'eyewash' | 'plant' | 'tallPlant' | 'seats' | 'ppe' | 'handwash' | 'clock' | 'o2' | 'pressure' | 'whiteboard' | 'leaflets'

interface Recipe {
  tall?: Tall[]
  tops?: Top[]
  center?: Center[]
  benches?: 'all' | 'long' | 'one' | 'none'
  sink?: boolean
  uppers?: boolean
  chairs?: number
  decor?: Decor[]
  /** autoclaves built into the wall shared with this room, back to back with its own */
  passThrough?: { zone: ZoneId; count: number }
}

const RECIPES: Record<string, Recipe> = {
  C01: { center: ['hubConsole'], benches: 'none', decor: ['plant', 'plant', 'seats'] },
  C02: { tall: ['lockers', 'lockers', 'coatHooks'], benches: 'none', decor: ['seats', 'ppe', 'handwash', 'notice'] },
  C10: { tall: ['bookcase'], center: ['desks'], benches: 'one', tops: ['pc', 'pc'], chairs: 1 },
  // molecular suite: clean reagents and library prep before amplification, amplification and sequencing after
  BI03: { tall: ['freezer20'], tops: ['pcrHood', 'microfuge', 'vortex', 'thermocycler', 'tips', 'racks'], benches: 'long', chairs: 1 },
  BI04: { tall: ['fridge', 'freezer20'], tops: ['thermocycler', 'thermocycler', 'instrument', 'pc', 'instrumentTall', 'instrument', 'tips'], benches: 'all', chairs: 2 },
  C07: { tall: ['freezer80', 'freezer80', 'freezer20', 'dewars', 'iceMachine'], tops: ['balance', 'balance', 'phMeter', 'stirrer', 'stirrer', 'instrumentTall', 'instrument', 'bottles', 'beakers'], benches: 'long', sink: true, uppers: true, decor: ['o2'] },
  BI01: { tall: ['fplc', 'centrifugeFloor', 'shaker', 'radioBench', 'freezer20'], tops: ['sonicator', 'plateReader', 'spec', 'pc', 'gelTank', 'microfuge', 'stereo', 'bottles', 'racks'], center: ['island'], benches: 'all', sink: true, uppers: true, chairs: 2 },
  IN07: { center: ['confocalBay'], tall: ['centrifugeFloor'], tops: ['instrument', 'instrumentTall', 'instrument', 'spec', 'pc', 'instrument', 'microscope', 'instrumentTall', 'pc'], benches: 'all', chairs: 2 },
  C06: { passThrough: { zone: 'C06C', count: 2 }, tall: ['washer', 'shelf'], benches: 'one', sink: true },
  C06C: { passThrough: { zone: 'C06', count: 2 }, tall: ['ovenStack', 'shelf', 'shelf'], benches: 'one' },
  BI06: { tall: ['bsc', 'incubators', 'shaker', 'fridge'], tops: ['microscope', 'colonyCounter', 'bioreactor', 'bioreactor', 'pc', 'stirrer', 'waterBath', 'bottles', 'racks', 'vortex'], center: ['island'], benches: 'all', sink: true, uppers: true, chairs: 2 },
  BI08: { tall: ['bsc', 'bsc', 'incubators', 'fridge', 'dewars', 'coatHooks'], tops: ['microscope', 'microfuge', 'cellCounter', 'waterBath'], benches: 'long', chairs: 1, decor: ['handwash', 'ppe'] },
  BI09: { tall: ['tissueProc', 'cryostat', 'walkInHood'], tops: ['microtome', 'stainer', 'analyser', 'analyser', 'microscope', 'pc'], benches: 'all', chairs: 2 },
  BI10: { center: ['ephys'], tops: ['organBath', 'ecg', 'pc', 'instrument'], benches: 'long', chairs: 1 },
  BI07A: { passThrough: { zone: 'BI07', count: 1 }, tall: ['coatHooks'], benches: 'none', decor: ['pressure', 'handwash', 'ppe'] },
  BI07: { passThrough: { zone: 'BI07A', count: 1 }, tall: ['bsc', 'bsc', 'incubators', 'centrifugeFloor'], tops: ['microfuge', 'microscope'], benches: 'long', decor: ['pressure'] },
  // shared core
  IN01: { tall: ['floorInstTall', 'floorInst', 'floorInst', 'icp', 'nitrogenGen'], tops: ['spec', 'ftir', 'instrument', 'polarimeter', 'meltingPoint', 'hplc', 'hplc', 'gc', 'instrument', 'pc', 'pc', 'instrument'], center: ['island'], benches: 'all', chairs: 3 },
  IN04: { center: ['nmr'], tall: ['cabinet'], tops: ['pc', 'instrument'], benches: 'one', chairs: 1, decor: ['o2'] },
  C11: { tall: ['dewars', 'dewars', 'chest80'], benches: 'none', decor: ['o2'] },
  IN06: { tall: ['xrd', 'xrd'], tops: ['pc', 'stereo', 'instrument'], benches: 'long', chairs: 1 },
  // chemistry
  C05: { tall: ['washer', 'ovenStack', 'iceMachine', 'shelf'], benches: 'long', sink: true },
  CH05: { tall: ['hood', 'balanceTable'], tops: ['digester', 'instrument', 'oven', 'balance', 'phMeter', 'bottles'], benches: 'all', sink: true, uppers: true, chairs: 1 },
  CH01: { tall: ['hood2', 'hood2', 'chemFridge'], tops: ['balance', 'balance', 'phMeter', 'stirrer', 'stirrer', 'waterBath', 'bottles', 'beakers'], center: ['island'], benches: 'all', sink: true, uppers: true, chairs: 2 },
  CH02: { tall: ['hood2', 'hood2', 'walkInHood', 'chemFridge', 'ovenStack'], tops: ['rotavap', 'rotavap', 'flash', 'hplc', 'tlcLamp', 'balance', 'stirrer', 'sonicator', 'bottles', 'beakers'], center: ['island'], benches: 'all', sink: true, chairs: 2 },
  CH06: { center: ['laserEnclosure'], tall: ['cabinet', 'fridge'], tops: ['potentiostat', 'calorimeter', 'instrument', 'instrumentTall', 'spec', 'pc', 'balance'], benches: 'long', uppers: true, chairs: 2 },
  C04: { tall: ['flamCab', 'flamCab', 'corrCab', 'corrCab', 'shelf'], benches: 'none' },
  CH03: { tall: ['glovebox', 'hood', 'ovenStack', 'cabinet'], tops: ['manifold', 'stirrer', 'balance', 'tubeFurnace', 'oven', 'ballMill', 'instrument'], benches: 'all', chairs: 2, decor: ['o2'] },
  // circulation
  X02: { benches: 'none', decor: ['eyewash', 'eyewash', 'extinguisher', 'notice', 'extinguisher'] },
  X03: { benches: 'none', decor: ['notice', 'extinguisher'] },
  // the Life commons, after the owner's reference (2026-10-27): lockers, a whiteboard, a tall plant, an upholstered bench
  X05: { tall: ['lockerBank'], benches: 'none', decor: ['seats', 'tallPlant', 'notice', 'whiteboard', 'leaflets', 'eyewash', 'extinguisher'] },
  X06: { benches: 'none', decor: ['notice', 'extinguisher', 'eyewash'] },
}

// ── geometry helpers ───────────────────────────────────────────────────────

interface Rect {
  minX: number
  minZ: number
  maxX: number
  maxZ: number
}
interface Wall {
  a: Vec2
  t: Vec2
  n: Vec2
  length: number
  /** window spans along the wall */
  windows: [number, number][]
  /** door spans along the wall */
  doors: [number, number][]
}

const fakeWidth = (fd: (typeof FAKE_DOORS)[number]) => (fd.double ? DOOR_W * 1.5 : DOOR_W)
const rectOf = (pts: Vec2[]): Rect => ({
  minX: Math.min(...pts.map((p) => p[0])),
  minZ: Math.min(...pts.map((p) => p[1])),
  maxX: Math.max(...pts.map((p) => p[0])),
  maxZ: Math.max(...pts.map((p) => p[1])),
})
const overlap = (a: Rect, b: Rect, m = 0) => a.minX < b.maxX - m && a.maxX > b.minX + m && a.minZ < b.maxZ - m && a.maxZ > b.minZ + m
const wp = (w: Wall, s: number, q: number): Vec2 => [w.a[0] + w.t[0] * s + w.n[0] * q, w.a[1] + w.t[1] * s + w.n[1] * q]
const stripRect = (w: Wall, s0: number, s1: number, q0: number, q1: number) => rectOf([wp(w, s0, q0), wp(w, s1, q0), wp(w, s1, q1), wp(w, s0, q1)])

function wallsOf(zone: Zone): Wall[] {
  return zoneWalls(zone)
    .filter((e) => (Math.abs(e.t[0]) > 0.999 || Math.abs(e.t[1]) > 0.999) && e.length > 0.5)
    .map((e) => {
      const project = (c: Vec2) => (c[0] - e.a[0]) * e.t[0] + (c[1] - e.a[1]) * e.t[1]
      const off = (c: Vec2) => Math.abs((c[0] - e.a[0]) * e.n[0] + (c[1] - e.a[1]) * e.n[1])
      const windows = WINDOWS.filter((w) => w.zone === zone.id && off(w.center) < 0.06).map((w): [number, number] => [project(w.center) - w.width / 2, project(w.center) + w.width / 2])
      const doors = DOORS.filter((d) => (d.a === zone.id || d.b === zone.id) && off(d.center) < Math.max(d.thickness, 0.05) + 0.02).map((d): [number, number] => [
        project(d.center) - doorWidth(d) / 2,
        project(d.center) + doorWidth(d) / 2,
      ])
      for (const fd of FAKE_DOORS) if (fd.zone === zone.id && off(fd.center) < 0.08) doors.push([project(fd.center) - fakeWidth(fd) / 2, project(fd.center) + fakeWidth(fd) / 2])
      return { a: e.a, t: e.t, n: e.n, length: e.length, windows, doors }
    })
}

/** Free spans along a wall for a strip `depth` deep, avoiding blockers and staying inside the room. */
function freeSpans(zone: Zone, w: Wall, depth: number, blockers: Rect[]): [number, number][] {
  const cuts: [number, number][] = []
  for (const r of blockers) {
    const corners: Vec2[] = [
      [r.minX, r.minZ],
      [r.maxX, r.minZ],
      [r.maxX, r.maxZ],
      [r.minX, r.maxZ],
    ]
    const s = corners.map((c) => (c[0] - w.a[0]) * w.t[0] + (c[1] - w.a[1]) * w.t[1])
    const q = corners.map((c) => (c[0] - w.a[0]) * w.n[0] + (c[1] - w.a[1]) * w.n[1])
    if (Math.max(...q) <= 0.005 || Math.min(...q) >= depth - 0.005) continue
    cuts.push([Math.min(...s), Math.max(...s)])
  }
  // keep the strip inside the (possibly concave) room
  for (let s = 0.05; s < w.length; s += 0.1) {
    const p = wp(w, s, depth - 0.03)
    if (!polygonContains(zone.floor, p[0], p[1])) cuts.push([s - 0.1, s + 0.1])
  }
  cuts.sort((x, y) => x[0] - y[0])
  const spans: [number, number][] = []
  let at = 0
  for (const [c0, c1] of cuts) {
    if (c0 > at) spans.push([at, Math.min(c0, w.length)])
    at = Math.max(at, c1)
  }
  if (at < w.length) spans.push([at, w.length])
  return spans.filter(([a, b]) => b - a > 0.05)
}

// ── allocator ─────────────────────────────────────────────────────────────

interface RoomPlan {
  zone: Zone
  walls: Wall[]
  /** doorway approach zones: nothing is ever placed here */
  keepClear: Rect[]
  /** in front of windows: no tall fixtures */
  windowClear: Rect[]
  placed: Rect[]
  runs: { run: BenchRun; length: number; sink?: [number, number]; island?: boolean }[]
  mainDoor: Vec2 | null
  /** knee spaces still owed to chairs; past that, a knee slot becomes a cupboard (no empty voids) */
  kneesLeft: number
}

function planRoom(zone: Zone): RoomPlan {
  const keepClear: Rect[] = []
  let mainDoor: Vec2 | null = null
  for (const d of DOORS) {
    if (d.a !== zone.id && d.b !== zone.id) continue
    const into: Vec2 = d.a === zone.id ? [-d.normal[0], -d.normal[1]] : d.normal
    const t: Vec2 = [-d.normal[1], d.normal[0]]
    const half = doorWidth(d) / 2 + 0.12
    const q0 = d.thickness / 2
    const depth = d.kind === 'opening' ? 1.1 : Math.max(1.15, leafWidth(d) + 0.25)
    const at = (u: number, q: number): Vec2 => [d.center[0] + t[0] * u + into[0] * q, d.center[1] + t[1] * u + into[1] * q]
    keepClear.push(rectOf([at(-half, q0), at(half, q0), at(half, q0 + depth), at(-half, q0 + depth)]))
    const other = d.a === zone.id ? d.b : d.a
    if (!mainDoor && CIRCULATION.has(ZONES[other]?.room?.kind ?? (other === 'hall' ? 'circulation' : 'lab'))) mainDoor = d.center
  }
  // exterior doors (entrance, escape, deliveries) need the same approach space
  for (const fd of FAKE_DOORS) {
    if (fd.zone !== zone.id) continue
    const t: Vec2 = [-fd.normal[1], fd.normal[0]]
    const half = fakeWidth(fd) / 2 + 0.12
    const at = (u: number, q: number): Vec2 => [fd.center[0] + t[0] * u + fd.normal[0] * q, fd.center[1] + t[1] * u + fd.normal[1] * q]
    keepClear.push(rectOf([at(-half, 0), at(half, 0), at(half, 1.2), at(-half, 1.2)]))
  }
  const windowClear: Rect[] = []
  for (const w of WINDOWS) {
    if (w.zone !== zone.id) continue
    const t: Vec2 = [-w.normal[1], w.normal[0]]
    const at = (u: number, q: number): Vec2 => [w.center[0] + t[0] * u + w.normal[0] * q, w.center[1] + t[1] * u + w.normal[1] * q]
    windowClear.push(rectOf([at(-w.width / 2 - 0.05, 0), at(w.width / 2 + 0.05, 0), at(w.width / 2 + 0.05, 0.9), at(-w.width / 2 - 0.05, 0.9)]))
  }
  return { zone, walls: wallsOf(zone), keepClear, windowClear, placed: [], runs: [], mainDoor, kneesLeft: 0 }
}

/**
 * The module rhythm's knee slots go to chairs, in the order the chairs are
 * later seated (perimeter runs, then the island). Once every chair has its
 * knee space, the remaining slots are cupboards rather than open voids.
 */
function claimKnee(p: RoomPlan, kind: ModuleKind): ModuleKind {
  if (kind !== 'knee') return kind
  if (p.kneesLeft <= 0) return 'door2'
  p.kneesLeft--
  return kind
}

/** Walls ordered for tall fixtures: no doors first, then the wall facing away from the main door, then longest. */
function tallWallOrder(p: RoomPlan) {
  const away = (w: Wall) => {
    if (!p.mainDoor) return 0
    const mid = wp(w, w.length / 2, 0)
    return Math.hypot(mid[0] - p.mainDoor[0], mid[1] - p.mainDoor[1])
  }
  return [...p.walls].sort((x, y) => x.doors.length - y.doors.length || away(y) - away(x) || y.length - x.length)
}

interface Slot {
  wall: Wall
  s: number
  w: number
  d: number
}

/**
 * Claim a stretch of wall. Floor-standing items keep out of doorway approaches
 * (and tall ones out of windows); wall-mounted ones only keep clear of the
 * door openings themselves.
 */
function placeOnWall(p: RoomPlan, w: number, d: number, kind: 'tall' | 'floor' | 'mounted'): Slot | null {
  for (const wall of tallWallOrder(p)) {
    const jambs = wall.doors.map(([s0, s1]) => stripRect(wall, s0 - 0.12, s1 + 0.12, 0, 0.5))
    const block = kind === 'mounted' ? [...p.placed, ...jambs] : [...p.keepClear, ...p.placed, ...(kind === 'tall' ? p.windowClear : [])]
    for (const [s0, s1] of freeSpans(p.zone, wall, d, block)) {
      if (s1 - s0 >= w + 0.04) {
        const s = s0 + 0.02
        p.placed.push(stripRect(wall, s, s + w, 0, d))
        return { wall, s, w, d }
      }
    }
  }
  return null
}

function moduleRun(p: RoomPlan, length: number, sink: boolean): { modules: { kind: ModuleKind; w: number }[]; sink?: [number, number] } {
  const n = Math.max(2, Math.round(length / 0.7))
  const w = length / n
  const cycle: ModuleKind[] = ['drawers4', 'door2', 'knee', 'door2', 'drawers4', 'knee']
  const sinkAt = sink && n >= 3 ? Math.min(n - 1, 1) : -1
  const modules = Array.from({ length: n }, (_, i) => ({ kind: i === sinkAt ? 'sink' as ModuleKind : claimKnee(p, cycle[i % cycle.length]), w }))
  const span: [number, number] | undefined = sinkAt >= 0 ? [sinkAt * w, (sinkAt + 1) * w] : undefined
  return { modules, sink: span }
}

function addBenchRuns(ctx: LabCtx, p: RoomPlan, r: Recipe) {
  const mode = r.benches ?? 'all'
  if (mode === 'none') return
  const bb = rectOf(p.zone.floor)
  const narrow = Math.min(bb.maxX - bb.minX, bb.maxZ - bb.minZ) < 2.7
  let walls = [...p.walls].sort((x, y) => y.length - x.length)
  // with an island the end walls stay free for tall fixtures and the aisles
  const long = mode === 'long' || Boolean(r.center?.includes('island'))
  if (mode === 'one') walls = walls.slice(0, 1)
  else if (long || narrow) walls = walls.slice(0, narrow ? 1 : 2)
  let sinkLeft = Boolean(r.sink)
  let uppers = r.uppers ? 2 : 0
  for (const wall of walls) {
    for (const [s0, s1] of freeSpans(p.zone, wall, BENCH_D + 0.02, [...p.keepClear, ...p.placed])) {
      const a = s0 + 0.01
      const b = s1 - 0.01
      const len = b - a
      if (len < 1.15) continue
      const dir: Vec2 = [wall.n[1], -wall.n[0]]
      const along = dir[0] * wall.t[0] + dir[1] * wall.t[1] > 0
      const start = along ? wp(wall, a, 0) : wp(wall, b, 0)
      const { modules, sink } = moduleRun(p, len, sinkLeft)
      if (sink) sinkLeft = false
      const atWallEnd = (s: number) => s < 0.05 || s > wall.length - 0.05
      const leftOpen = !atWallEnd(along ? a : b)
      const rightOpen = !atWallEnd(along ? b : a)
      const underWindow = wall.windows.some(([w0, w1]) => w1 > a && w0 < b)
      const run: BenchRun = {
        id: `${p.zone.id}:run${p.runs.length}`,
        zone: p.zone.id,
        start,
        dir,
        depth: BENCH_D,
        modules,
        ends: { left: leftOpen, right: rightOpen },
        uppers: uppers > 0 && !underWindow && len >= 1.5 ? { from: 0.04, to: len - 0.04 } : undefined,
      }
      if (run.uppers) uppers--
      buildBench(ctx, run)
      p.placed.push(stripRect(wall, a, b, 0, BENCH_D + 0.02))
      p.runs.push({ run, length: len, sink })
    }
  }
}

const grow = (r: Rect, m: number): Rect => ({ minX: r.minX - m, minZ: r.minZ - m, maxX: r.maxX + m, maxZ: r.maxZ + m })

/**
 * Free floor spot for a W×D item nearest the room's middle: the item plus an
 * `aisle` all round stays inside the room and off placed furniture; the
 * `core` (default: the whole item) also stays out of the doorway approaches.
 */
function findSpot(p: RoomPlan, W: number, D: number, aisle: number, core?: [number, number]): Rect | null {
  const bb = rectOf(p.zone.floor)
  const cx = (bb.minX + bb.maxX) / 2
  const cz = (bb.minZ + bb.maxZ) / 2
  const cands: Vec2[] = []
  for (let x = bb.minX + W / 2; x <= bb.maxX - W / 2 + 1e-6; x += 0.1) for (let z = bb.minZ + D / 2; z <= bb.maxZ - D / 2 + 1e-6; z += 0.1) cands.push([x, z])
  cands.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cz) - Math.hypot(b[0] - cx, b[1] - cz))
  const [cw, cd] = core ?? [W, D]
  for (const [x, z] of cands) {
    const r: Rect = { minX: x - W / 2, maxX: x + W / 2, minZ: z - D / 2, maxZ: z + D / 2 }
    const c: Rect = { minX: x - cw / 2, maxX: x + cw / 2, minZ: z - cd / 2, maxZ: z + cd / 2 }
    const g = grow(r, aisle)
    if (!insideRoom(p.zone, g) || p.placed.some((q) => overlap(q, g)) || p.keepClear.some((q) => overlap(q, c))) continue
    return r
  }
  return null
}

function insideRoom(zone: Zone, r: Rect) {
  const pts: Vec2[] = [
    [r.minX + 0.02, r.minZ + 0.02],
    [r.maxX - 0.02, r.minZ + 0.02],
    [r.maxX - 0.02, r.maxZ - 0.02],
    [r.minX + 0.02, r.maxZ - 0.02],
    [(r.minX + r.maxX) / 2, (r.minZ + r.maxZ) / 2],
  ]
  return pts.every((q) => polygonContains(zone.floor, q[0], q[1]))
}

function island(ctx: LabCtx, p: RoomPlan) {
  // longest island that leaves a 0.9 aisle (about 1.1 m) to the wall benches, along the room's long axis first
  const bb = rectOf(p.zone.floor)
  const longX = bb.maxX - bb.minX >= bb.maxZ - bb.minZ
  const depth = 0.66
  let r: Rect | null = null
  let alongX = longX
  search: for (let L = 4.2; L >= 1.6; L -= 0.3) {
    for (const ax of [longX, !longX]) {
      r = ax ? findSpot(p, L, depth * 2, 0.9) : findSpot(p, depth * 2, L, 0.9)
      if (r) {
        alongX = ax
        break search
      }
    }
  }
  if (!r) {
    console.warn(`[furnish] ${p.zone.id}: no room for island`)
    return
  }
  const L = alongX ? r.maxX - r.minX : r.maxZ - r.minZ
  const cx = (r.minX + r.maxX) / 2
  const cz = (r.minZ + r.maxZ) / 2
  for (const side of [1, -1] as const) {
    // each half faces outwards from the shared spine
    const inward: Vec2 = alongX ? [0, side] : [side, 0]
    const dir: Vec2 = [inward[1], -inward[0]]
    const start: Vec2 = alongX ? [cx - (dir[0] * L) / 2, cz] : [cx, cz - (dir[1] * L) / 2]
    const n = Math.max(2, Math.round(L / 0.7))
    const cycle: ModuleKind[] = ['drawers4', 'door2', 'knee', 'door2']
    const run: BenchRun = {
      id: `${p.zone.id}:island${side}`,
      zone: p.zone.id,
      start,
      dir,
      depth,
      modules: Array.from({ length: n }, (_, i) => ({ kind: claimKnee(p, cycle[i % cycle.length]), w: L / n })),
      ends: { left: true, right: true },
    }
    buildBench(ctx, run)
    p.runs.push({ run, length: L, island: true })
  }
  // service spine down the middle: reagent shelf on uprights (York "service beam")
  const b = ctx.batch[p.zone.id]
  b.at(cx, BENCH_TOP, cz, alongX ? 0 : Math.PI / 2, () => {
    for (const x of [-L / 2 + 0.06, 0, L / 2 - 0.06]) b.box('steel', x, 0.25, 0, 0.03, 0.5, 0.03)
    b.span('laminate', -L / 2 + 0.03, 0.44, -0.12, L / 2 - 0.03, 0.465, 0.12, { color: OFFWHITE })
    b.span('laminate', -L / 2 + 0.03, 0.1, -0.03, L / 2 - 0.03, 0.42, 0.0, { color: '#dfe2e5' })
    const rand = rng(Math.round(cx * 100 + cz * 7))
    for (let x = -L / 2 + 0.15; x < L / 2 - 0.15; x += 0.13 + rand() * 0.12) {
      if (rand() < 0.6) b.at(x, 0.465, 0, 0, () => bottle(b, 0, 0, 0.032, 0.12 + rand() * 0.05, rand() > 0.5 ? '#1f5fd1' : '#0f766e'))
      else b.at(x, 0.465, 0, 0, () => carton(b, 0, 0, 0.1, 0.08, 0.08))
    }
  })
  ctx.collider(r.minX, r.minZ, r.maxX, r.maxZ)
  ctx.occluder(p.zone.id, [r.minX, 0, r.minZ], [r.maxX, BENCH_TOP + 0.5, r.maxZ])
  p.placed.push(r)
}

// ── fixture builders (local frame: x across, z from the wall into the room) ──

function tallSize(kind: Tall): [number, number, number] {
  switch (kind) {
    case 'hood': return [1.5, 0.85, 2.4]
    case 'hood2': return [1.85, 0.85, 2.4]
    case 'walkInHood': return [1.5, 0.95, 2.55]
    case 'bsc': return [1.35, 0.82, 2.15]
    case 'fridge': case 'freezer20': case 'chemFridge': return [0.66, 0.78, 1.95]
    case 'freezer80': return [0.85, 0.9, 1.98]
    case 'shelf': return [0.9, 0.5, 1.86]
    case 'cabinet': case 'bookcase': return [0.95, 0.55, 2.05]
    case 'flamCab': case 'corrCab': return [0.95, 0.5, 1.75]
    case 'autoclave': return [0.95, 0.85, 1.65]
    case 'washer': return [0.62, 0.66, 0.86]
    case 'incubators': return [0.75, 0.78, 1.95]
    case 'fplc': return [0.85, 0.72, 1.98]
    case 'floorInst': return [1.1, 0.8, 1.4]
    case 'floorInstTall': return [0.9, 0.75, 1.75]
    case 'glovebox': return [1.9, 0.85, 2.0]
    case 'xrd': return [1.5, 0.95, 2.05]
    case 'gasRack': return [1.4, 0.4, 1.7]
    case 'dewars': return [1.0, 0.55, 1.1]
    case 'lockers': return [1.2, 0.5, 1.9]
    case 'lockerBank': return [2.4, 0.45, 1.85]
    case 'ovenStack': return [0.75, 0.65, 1.7]
    case 'tissueProc': return [0.75, 0.75, 1.3]
    case 'chest80': return [1.25, 0.72, 0.92]
    case 'iceMachine': return [0.6, 0.7, 1.5]
    case 'nitrogenGen': return [0.55, 0.6, 1.0]
    case 'coatHooks': return [0.8, 0.3, 1.9]
    case 'cryostat': return [0.75, 0.75, 1.2]
    case 'shaker': return [0.9, 0.75, 1.3]
    case 'centrifugeFloor': return [0.8, 0.75, 1.05]
    case 'icp': return [1.0, 0.85, 1.55]
    case 'balanceTable': return [1.2, 0.7, 0.85]
    case 'radioBench': return [1.8, 0.78, 1.5]
  }
}

function screen(b: Batch, x: number, y: number, z: number, w: number, h: number) {
  b.box('plastic', x, y, z, w + 0.02, h + 0.02, 0.008, { color: '#1b2430', radius: 0.004 })
  b.decal('instrument', x, y, z + 0.0045, w, h, 0, 'screen', 1.25)
}

const TALL_POWER:Record<Tall,'manual'|'delegated'|'mains'>={
  'hood':'mains',
  'hood2':'mains',
  'walkInHood':'mains',
  'bsc':'mains',
  'fridge':'mains',
  'freezer20':'mains',
  'freezer80':'mains',
  'chemFridge':'mains',
  'shelf':'manual',
  'cabinet':'manual',
  'autoclave':'mains',
  'washer':'mains',
  'incubators':'delegated',
  'fplc':'mains',
  'floorInst':'mains',
  'floorInstTall':'mains',
  'glovebox':'mains',
  'xrd':'mains',
  'flamCab':'manual',
  'corrCab':'manual',
  'gasRack':'manual',
  'dewars':'manual',
  'lockers':'manual',
  'lockerBank':'manual',
  'ovenStack':'delegated',
  'tissueProc':'mains',
  'chest80':'mains',
  'iceMachine':'mains',
  'nitrogenGen':'mains',
  'coatHooks':'manual',
  'cryostat':'mains',
  'shaker':'mains',
  'centrifugeFloor':'mains',
  'bookcase':'manual',
  'icp':'mains',
  'balanceTable':'delegated',
  'radioBench':'delegated'
}

function buildTall(b: Batch, kind: Tall, w: number, d: number, h: number, rand: () => number) {
  if(kind==='incubators'||kind==='ovenStack')return b.at(0,0,.075,0,()=>buildTallGeometry(b,kind,w,d-.075,h,rand))
  if(TALL_POWER[kind]!=='mains')return buildTallGeometry(b,kind,w,d,h,rand)
  const fixed=["autoclave","bsc","glovebox","hood","hood2","icp","nitrogenGen","walkInHood","washer","xrd"].includes(kind)
  if(fixed) appliance(b,kind,()=>buildTallGeometry(b,kind,w,d,h,rand),'fixed')
  else b.at(0,0,.075,0,()=>appliance(b,kind,()=>buildTallGeometry(b,kind,w,d-.075,h,rand)))
}

function buildTallGeometry(b: Batch, kind: Tall, w: number, d: number, h: number, rand: () => number) {
  switch (kind) {
    case 'hood':
    case 'hood2':
    case 'walkInHood': {
      const base = kind === 'walkInHood' ? 0.12 : 0.9
      if (kind !== 'walkInHood') {
        b.span('laminate', -w / 2, 0.1, 0.02, w / 2, 0.86, d - 0.025, { color: '#ebe9e4' })
        b.span('frame', -w / 2 + 0.02, 0, 0.04, w / 2 - 0.02, 0.1, d - 0.08, { color: '#8d9196' })
        const lockers = kind === 'hood2' ? 4 : 2
        for (let i = 0; i < lockers; i++) {
          const x0 = -w / 2 + (w * i) / lockers
          b.span('laminate', x0 + 0.004, 0.105, d - 0.025, x0 + w / lockers - 0.004, 0.855, d - 0.006, { color: '#f1efea', radius: 0.003 })
          b.box('steel', x0 + w / lockers / 2, 0.8, d - 0.002, 0.08, 0.012, 0.012)
          // coloured position markers (York: one per work position)
          b.box('gloss', x0 + w / lockers / 2, 0.7, d - 0.003, 0.05, 0.05, 0.004, { color: ['#e11d48', '#2563eb', '#16a34a', '#f59e0b'][i % 4] })
        }
        b.decal('flammable', 0, 0.45, d - 0.0045, 0.3, 0.13)
        b.span('worktop', -w / 2, 0.86, 0, w / 2, 0.9, d, { radius: 0.004, bake: ['+y', '+z'] })
      } else {
        b.span('frame', -w / 2, 0, 0.02, w / 2, 0.12, d, { color: '#8d9196' })
      }
      const post = 0.14
      for (const sx of [-1, 1]) b.span('gloss', sx * (w / 2 - post / 2) - post / 2, base, 0, sx * (w / 2 - post / 2) + post / 2, h, d, { color: WHITE })
      b.span('gloss', -w / 2, h - 0.4, 0, w / 2, h, d, { color: WHITE })
      b.span('gloss', -w / 2 + post, base, 0, w / 2 - post, h - 0.4, 0.06, { color: '#e2e5e8' })
      for (const sx of [-1, 1]) b.span('gloss', sx * (w / 2 - post) - sx * 0.004, base, 0.06, sx * (w / 2 - post), h - 0.4, d - 0.08, { color: '#e6e9ec' })
      b.span('glow', -w / 2 + post + 0.05, h - 0.445, d - 0.2, w / 2 - post - 0.05, h - 0.44, d - 0.12, { color: new THREE.Color(3.2, 3.2, 3.1) })
      const sy0 = base + 0.38
      const sy1 = h - 0.46
      b.span('steel', -w / 2 + post, sy0 - 0.03, d - 0.05, w / 2 - post, sy0, d - 0.02)
      b.span('steel', -w / 2 + post, sy1, d - 0.05, w / 2 - post, sy1 + 0.03, d - 0.02)
      b.plane('glass', 0, (sy0 + sy1) / 2, d - 0.035, w - post * 2, sy1 - sy0)
      if (kind === 'hood2') b.span('steel', -0.015, sy0, d - 0.05, 0.015, sy1, d - 0.02)
      b.span('steel', -w / 2 + post, base, d - 0.06, w / 2 - post, base + 0.025, d + 0.01, { radius: 0.006 })
      b.span('gloss', -w / 2, h - 0.4, d - 0.001, w / 2, h - 0.26, d + 0.004, { color: '#f4f5f6' })
      b.decal('hoodMonitor', 0, h - 0.33, d + 0.0055, 0.1, 0.064, 0, 'screen', 1.3)
      b.cyl('steel', 0, h + 0.15, d * 0.45, 0.17, 0.17, 0.3, { seg: 24 })
      if (kind === 'walkInHood') {
        // distillation frame inside
        for (const x of [-0.3, 0.3]) b.box('steel', x, 1.2, 0.3, 0.02, 2.0, 0.02)
        b.box('steel', 0, 1.6, 0.3, 0.7, 0.02, 0.02)
        b.sphere('bottle', -0.15, 0.55, 0.35, 0.12, '#f4f7fa')
        b.cyl('bottle', 0.05, 1.05, 0.35, 0.03, 0.03, 0.75, { rz: -0.5 })
      }
      return
    }
    case 'bsc': {
      // Class II biological safety cabinet on its stand
      for (const sx of [-1, 1]) for (const sz of [0.1, d - 0.1]) b.box('steel', sx * (w / 2 - 0.06), 0.36, sz, 0.04, 0.72, 0.04)
      b.span('laminate', -w / 2, 0.72, 0, w / 2, 0.76, d, { color: GREY })
      b.span('gloss', -w / 2, 0.76, 0, w / 2, h, 0.08, { color: '#e4e7ea' })
      for (const sx of [-1, 1]) b.span('gloss', sx * (w / 2) - (sx > 0 ? 0.06 : 0), 0.76, 0, sx * (w / 2) + (sx > 0 ? 0 : 0.06), h, d, { color: WHITE })
      b.span('gloss', -w / 2, h - 0.38, 0, w / 2, h, d, { color: WHITE })
      b.span('steel', -w / 2 + 0.06, 0.76, 0.08, w / 2 - 0.06, 0.95, d - 0.04)
      b.span('rubber', -w / 2 + 0.08, 0.95, d - 0.09, w / 2 - 0.08, 0.97, d - 0.04, { color: '#3a3d42' })
      b.within(new THREE.Matrix4().makeRotationX(-0.17).setPosition(0, 1.38, d - 0.05), () => b.plane('glass', 0, 0, 0, w - 0.14, 0.75))
      b.span('gloss', -w / 2, h - 0.38, d - 0.002, w / 2, h - 0.3, d + 0.006, { color: BLUE })
      screen(b, w / 2 - 0.25, h - 0.2, d + 0.006, 0.14, 0.05)
      b.span('glow', -w / 2 + 0.1, h - 0.4, d - 0.25, w / 2 - 0.1, h - 0.395, d - 0.15, { color: new THREE.Color(2.4, 2.5, 2.6) })
      return
    }
    case 'fridge':
    case 'freezer20':
    case 'chemFridge':
    case 'freezer80': {
      const label = kind === 'freezer80' ? '-80' : kind === 'freezer20' ? '-20' : '+4'
      b.box('gloss', 0, h / 2 + 0.03, d / 2, w - 0.01, h - 0.06, d, { color: '#f1f2f3', radius: 0.012 })
      b.box('gloss', 0, (h - 0.25) / 2 + 0.25, d + 0.012, w - 0.03, h - 0.3, 0.025, { color: '#f6f7f8', radius: 0.008 })
      b.box('rubber', 0, 0.15, d + 0.006, w - 0.06, 0.2, 0.01, { color: '#2a2d31' })
      b.box('steel', w / 2 - 0.07, 1.15, d + 0.045, 0.025, 0.42, 0.03, { radius: 0.01 })
      b.box('plastic', 0, h - 0.33, d + 0.026, 0.2, 0.13, 0.008, { color: '#0e2552', radius: 0.008 })
      b.decal(`disp${label}` as 'disp+4', 0, h - 0.33, d + 0.0305, 0.17, 0.104, 0, 'screen', 1.5)
      if (kind === 'chemFridge') b.decal('flammable', 0, 1.0, d + 0.026, 0.26, 0.11)
      b.shadow(0, 0, d / 2, w, d, 0.6)
      return
    }
    case 'shelf':
      b.at(0, 0, d / 2, 0, () => wireShelf(b, w, d, h, [0.12, 0.55, 0.98, 1.4, 1.84], false, rand))
      return
    case 'cabinet':
    case 'bookcase':
    case 'flamCab':
    case 'corrCab':
    case 'lockers': {
      const color = kind === 'flamCab' ? '#f2c230' : kind === 'corrCab' ? '#3b6fd1' : kind === 'lockers' ? '#8ea2b5' : '#f3f4f5'
      carcass(b, -w/2, w/2, 0.04, h, d)
      const doors = kind === 'lockers' ? 4 : 2
      for (let i = 0; i < doors; i++) {
        const x0 = -w/2+(w*i)/doors, x1 = x0+w/doors
        const right = kind !== 'lockers' && i % 2 === 1
        movableStorage(b, `tall:${kind}:${right}:${w.toFixed(5)}:${h.toFixed(5)}:${d.toFixed(5)}`, 'door', new THREE.Vector3(right ? x1 : x0, 0.06, d), right ? Math.PI/2 : -Math.PI/2, model => {
          model.span('gloss', x0+0.006, 0.06, d, x1-0.006, h-0.04, d+0.01, { color, radius: 0.004 })
          const hx = right ? x0+0.05 : x1-0.05
          model.box('steel', hx, h*0.55, d+0.02, 0.016, 0.16, 0.016, { radius: 0.006 })
          if (kind === 'lockers') for (let v=0; v<4; v++) model.box('rubber', (x0+x1)/2, h-0.25-v*0.04, d+0.011, w/doors-0.12, 0.012, 0.002, { color: '#56687a' })
          if (kind === 'flamCab') model.decal('flammable', (x0+x1)/2, h*0.7, d+0.012, Math.min(0.3,w/doors-0.04), 0.16)
        })
      }
      if (kind === 'bookcase') for (let y = 0.4; y < h - 0.2; y += 0.42) for (let x = -w / 2 + 0.08; x < w / 2 - 0.08; x += 0.07 + rand() * 0.06) b.box('plastic', x, y + 0.13, d - 0.12, 0.04, 0.24 + rand() * 0.06, 0.18, { color: ['#1d4ed8', '#b91c1c', '#e5e7eb', '#0f766e', '#334155'][Math.floor(rand() * 5)] })
      return
    }
    case 'autoclave': {
      b.box('steel', 0, h / 2, d / 2, w, h, d)
      b.cyl('steel', 0, 0.85, d + 0.04, 0.32, 0.32, 0.08, { rx: Math.PI / 2, seg: 32 })
      b.cyl('chrome', 0, 0.85, d + 0.09, 0.08, 0.08, 0.05, { rx: Math.PI / 2, seg: 18 })
      b.box('plastic', 0, 1.42, d + 0.005, w - 0.1, 0.22, 0.01, { color: '#1b2430' })
      screen(b, -0.18, 1.42, d + 0.012, 0.22, 0.12)
      return
    }
    case 'washer':
      b.box('gloss', 0, h / 2, d / 2, w, h, d, { color: WHITE, radius: 0.01 })
      b.box('steel', 0, 0.42, d + 0.008, w - 0.06, 0.62, 0.012)
      screen(b, 0, h - 0.08, d + 0.012, 0.18, 0.05)
      return
    case 'incubators':
      b.span('steel', -w / 2, 0, 0.05, w / 2, 0.25, d - 0.05)
      for (const y0 of [0.27, 1.12]) {
        appliance(b,'stacked incubator',()=>b.box('gloss', 0, y0 + 0.4, d / 2, w, 0.8, d, { color: '#eef0f2', radius: 0.01 }))
        b.box('gloss', 0, y0 + 0.4, d + 0.012, w - 0.05, 0.74, 0.02, { color: '#f7f8f9', radius: 0.006 })
        screen(b, w / 2 - 0.15, y0 + 0.66, d + 0.025, 0.12, 0.06)
        b.box('steel', -w / 2 + 0.07, y0 + 0.4, d + 0.04, 0.02, 0.3, 0.025)
      }
      return
    case 'fplc':
      b.box('gloss', 0, h / 2, d / 2, w, h, d, { color: '#eef0f2', radius: 0.01 })
      b.plane('glass', 0, 1.05, d + 0.012, w - 0.1, 1.5)
      for (const y of [0.55, 0.95, 1.35]) b.box('gloss', 0, y, d / 2, w - 0.12, 0.22, d - 0.15, { color: y === 0.95 ? '#dfe7f5' : '#e7eaee' })
      for (let i = 0; i < 4; i++) b.cyl('bottle', -0.25 + i * 0.16, 1.63, d / 2, 0.035, 0.035, 0.18, { color: '#f4f7fa' })
      b.decal('brand-thermo', 0, h - 0.12, d + 0.013, 0.12, 0.03)
      return
    case 'centrifugeFloor': {
      // A floor centrifuge has a control shoulder and a thin separate lid, not a round pad on a generic cabinet.
      b.at(0, 0, d / 2, 0, () => {
        b.add('plastic', instrumentCasingGeometry({ width: w, depth: d, deckHeight: h - 0.05, frontHeight: h - 0.22, shoulderDepth: 0.16, baseHeight: 0.06, holes: [{ x: 0, z: -0.065, radius: w * 0.3 }], segments: b.detail === 'full' ? 28 : 20 }), undefined, WHITE)
        b.box('rubber', 0, 0.045, 0, w - 0.012, 0.03, d - 0.012, { color: '#535e65', radius: 0.002 })
        b.box('rubber', 0, h - 0.048, -0.065, w - 0.096, 0.004, 0.534, { color: '#343d42', radius: 0.001 })
        b.box('plastic', 0, h - 0.0335, -0.065, w - 0.1, 0.025, 0.53, { color: OFFWHITE, radius: 0.002 })
        b.within(new THREE.Matrix4().makeRotationX(-Math.atan2(0.16, 0.17)).setPosition(0, h - 0.135, d / 2 - 0.08), () => {
          b.box('plastic', 0, 0, 0.002, w - 0.08, 0.2, 0.003, { color: '#dfe5e7', radius: 0.001 })
          b.decal('microfuge', -0.13, 0.027, 0.004, 0.23, 0.06, 0, 'screen', 0.85)
          for (const x of [0.13, 0.25]) b.cyl('plastic', x, -0.02, 0.014, 0.02, 0.02, 0.018, { color: '#28699a', rx: Math.PI / 2, seg: 20 })
        })
        for (const side of [-1, 1]) {
          b.box('rubber', side * (w / 2 + 0.0002), h * 0.43, -0.12, 0.001, h * 0.36, d * 0.48, { color: '#3a454c' })
          for (let i = 0; i < 19; i++) b.box('plastic', side * (w / 2 + 0.0008), h * 0.26 + i * h * 0.018, -0.12, 0.0015, 0.008, d * 0.48 + 0.002, { color: WHITE })
          for (const end of [-1, 1]) b.cyl('rubber', side * (w / 2 - 0.06), 0.015, end * (d / 2 - 0.06), 0.022, 0.022, 0.03, { color: '#303a40', seg: 12 })
        }
        b.shadow(0, 0, 0, w, d, 0.6)
      })
      return
    }
    case 'floorInst':
    case 'floorInstTall':
    case 'shaker':
    case 'tissueProc':
    case 'cryostat':
    case 'nitrogenGen':
    case 'iceMachine': {
      const color = kind === 'iceMachine' ? '#cfd4d9' : kind === 'nitrogenGen' ? '#d8dde2' : WHITE
      const mat = kind === 'iceMachine' ? 'steel' : 'gloss'
      b.box(mat, 0, h / 2, d / 2, w, h, d, { color, radius: 0.015 })
      b.box('gloss', 0, h - 0.06, d / 2, w + 0.005, 0.03, d + 0.005, { color: kind === 'cryostat' ? '#2b6cb0' : '#3c4652' })
      screen(b, w / 2 - 0.16, h - 0.22, d + 0.006, 0.16, 0.09)
      if (kind === 'shaker') b.plane('glass', 0, h * 0.6, d + 0.006, w - 0.12, h * 0.5)
      if (kind === 'cryostat') b.plane('glass', 0, h - 0.12, d * 0.5, w - 0.12, d - 0.1, 0, undefined, -Math.PI / 2)
      for (let i = 0; i < 3; i++) b.box('rubber', -w / 2 + 0.12 + i * 0.05, 0.12, d + 0.004, 0.02, 0.06, 0.004, { color: '#55606d' })
      b.shadow(0, 0, d / 2, w, d, 0.6)
      return
    }
    case 'glovebox': {
      for (const sx of [-1, 1]) for (const sz of [0.12, d - 0.12]) b.box('steel', sx * (w / 2 - 0.25), 0.4, sz, 0.05, 0.8, 0.05)
      b.span('steel', -w / 2 + 0.2, 0.8, 0.02, w / 2 - 0.25, 1.65, d)
      b.within(new THREE.Matrix4().makeRotationX(-0.25).setPosition(-0.025, 1.24, d + 0.02), () => {
        b.plane('glass', 0, 0, 0, w - 0.6, 0.72)
        // glove ports: rings on the window, gloves hanging inside the box
        for (const x of [-0.3, 0.3]) {
          b.cyl('rubber', x, -0.05, 0.005, 0.1, 0.1, 0.03, { rx: Math.PI / 2, color: '#16181b', seg: 24 })
          b.cyl('rubber', x, -0.2, -0.22, 0.06, 0.085, 0.4, { rx: 0.5, color: '#1f2226', seg: 16 })
        }
      })
      b.cyl('steel', w / 2 - 0.12, 1.15, d / 2, 0.16, 0.16, 0.45, { rz: Math.PI / 2, seg: 24 })
      b.box('gloss', 0, 1.85, d / 2, w - 0.5, 0.35, d - 0.2, { color: '#d9dde1' })
      screen(b, 0.3, 1.85, d - 0.09, 0.2, 0.1)
      return
    }
    case 'xrd': {
      b.box('gloss', 0, h / 2, d / 2, w, h, d, { color: '#eceff2', radius: 0.012 })
      b.plane('glass', -0.15, 1.15, d + 0.012, w - 0.5, 1.1)
      b.box('rubber', -0.15, 1.15, d - 0.02, w - 0.55, 1.05, 0.02, { color: '#22262c' })
      b.cyl('steel', -0.15, 1.15, d - 0.25, 0.12, 0.12, 0.3, { rx: Math.PI / 2, seg: 20 })
      b.box('gloss', w / 2 - 0.2, h - 0.12, d + 0.01, 0.12, 0.06, 0.02, { color: '#f59e0b' })
      b.cyl('glow', w / 2 - 0.2, h + 0.06, d * 0.5, 0.04, 0.04, 0.1, { color: new THREE.Color(2.4, 1.2, 0.2) })
      return
    }
    case 'gasRack': {
      b.span('steel', -w / 2, 1.05, 0.02, w / 2, 1.1, 0.06)
      b.span('steel', -w / 2, 0.35, 0.02, w / 2, 0.4, 0.06)
      const cols = ['#2f855a', '#475569', '#b91c1c', '#e5e7eb', '#1e3a8a']
      for (let i = 0; i < 5; i++) {
        const x = -w / 2 + 0.16 + i * ((w - 0.32) / 4)
        b.cyl('gloss', x, 0.75, 0.2, 0.11, 0.11, 1.5, { color: cols[i], seg: 18 })
        b.sphere('gloss', x, 1.5, 0.2, 0.11, cols[i], 0.6)
        b.cyl('chrome', x, 1.62, 0.2, 0.03, 0.03, 0.1)
        b.box('chrome', x, 1.69, 0.24, 0.05, 0.04, 0.08)
      }
      return
    }
    case 'dewars': {
      for (let i = 0; i < 3; i++) {
        const x = -w / 2 + 0.18 + i * ((w - 0.36) / 2)
        const r = i === 1 ? 0.22 : 0.16
        b.cyl('steel', x, 0.06, d / 2, r + 0.03, r + 0.03, 0.06, { seg: 20 })
        b.cyl('chrome', x, 0.06 + (h - 0.2) / 2, d / 2, r, r, h - 0.2, { seg: 24 })
        b.cyl('steel', x, h - 0.08, d / 2, r * 0.5, r * 0.6, 0.12, { seg: 16 })
      }
      return
    }
    case 'ovenStack':
      b.span('steel', -w / 2, 0, 0.05, w / 2, 0.3, d - 0.05)
      for (const y0 of [0.32, 1.0]) {
        appliance(b,'stacked oven',()=>b.box('gloss', 0, y0 + 0.32, d / 2, w, 0.64, d, { color: '#eef0f2', radius: 0.01 }))
        b.box('steel', -0.08, y0 + 0.32, d + 0.01, w - 0.3, 0.54, 0.012)
        screen(b, w / 2 - 0.13, y0 + 0.48, d + 0.012, 0.1, 0.05)
      }
      return
    case 'chest80':
      b.box('gloss', 0, h / 2, d / 2, w, h, d, { color: '#f3f4f5', radius: 0.02 })
      b.box('gloss', 0, h + 0.01, d / 2, w - 0.02, 0.03, d - 0.02, { color: '#e8eaec' })
      screen(b, w / 2 - 0.2, h - 0.15, d + 0.006, 0.14, 0.06)
      return
    case 'icp':
      // ICP-OES with its own extraction snorkel over the torch box
      b.box('gloss', 0, 0.55, d / 2, w, 1.1, d, { color: WHITE, radius: 0.015 })
      b.box('gloss', -0.18, 0.9, d + 0.006, 0.4, 0.3, 0.012, { color: '#2f3640' })
      b.plane('glass', -0.18, 0.9, d + 0.013, 0.34, 0.24)
      screen(b, w / 2 - 0.18, 0.95, d + 0.006, 0.18, 0.1)
      b.cyl('steel', -0.18, 1.32, d * 0.4, 0.09, 0.09, 0.44, { seg: 16 })
      b.cyl('steel', -0.18, 1.98, d * 0.4, 0.06, 0.06, 0.9, { seg: 14 })
      b.shadow(0, 0, d / 2, w, d, 0.6)
      return
    case 'balanceTable':
      // stone weighing table: microbalance and 5 dp balance, away from the hood
      for (const sx of [-1, 1]) b.box('steel', sx * (w / 2 - 0.08), 0.36, d / 2, 0.06, 0.72, d - 0.1)
      // the same resin as the benches, baked like them (not a near-black tint)
      b.span('worktop', -w / 2, 0.72, 0, w / 2, 0.8, d, { radius: 0.004, bake: ['+y', '+z'] })
      b.at(-0.28, 0.8, d / 2, 0, () => buildTop(b, 'balance', rand))
      b.at(0.25, 0.8, d / 2, 0, () => {
        appliance(b,'analytical balance',()=>b.box('gloss', 0, 0.05, 0, 0.3, 0.1, 0.36, { color: WHITE, radius: 0.012 }))
        b.box('glass', 0, 0.25, -0.02, 0.26, 0.3, 0.26)
        screen(b, 0, 0.05, 0.181, 0.12, 0.04)
      })
      return
    case 'radioBench': {
      // designated isotope bench: drip tray, acrylic beta shield, monitor, counter beside, trefoil sign
      b.span('laminate', -w / 2, 0.1, 0.02, w / 2, BENCH_TOP - 0.04, d - 0.03, { color: '#eceef0' })
      b.span('frame', -w / 2 + 0.02, 0, 0.04, w / 2 - 0.02, 0.1, d - 0.08, { color: '#8d9196' })
      b.span('worktop', -w / 2, BENCH_TOP - 0.04, 0, w / 2, BENCH_TOP, d, { radius: 0.004, bake: ['+y', '+z'] })
      b.span('gloss', -w / 2 + 0.06, BENCH_TOP, 0.06, 0.3, BENCH_TOP + 0.03, d - 0.06, { color: '#f7d117' })
      b.within(new THREE.Matrix4().makeRotationX(-0.12).setPosition(-0.25, BENCH_TOP + 0.28, d - 0.2), () => b.box('glass', 0, 0, 0, 0.7, 0.5, 0.02, { color: '#dbeafe' }))
      b.at(0.55, BENCH_TOP, d / 2, 0, () => buildTop(b, 'counter', rand))
      b.box('gloss', -0.55, BENCH_TOP + 0.06, d - 0.15, 0.12, 0.12, 0.08, { color: '#f7d117', radius: 0.01 })
      b.box('plastic', 0, 1.62, 0.006, 0.19, 0.23, 0.012, { color: '#1b1b1b' })
      b.decal('radiation', 0, 1.62, 0.0125, 0.18, 0.22)
      b.shadow(0, 0, d / 2, w, d, 0.55)
      return
    }
    case 'lockerBank': {
      // two-tier steel lockers: louvred doors, a recessed latch and a number tag each, on a dark plinth
      const cols = Math.max(1, Math.round(w / 0.3))
      const grey = '#b9bec2'
      const mid = 0.1 + (h - 0.1) / 2
      b.span('frame', -w / 2 + 0.01, 0, 0.03, w / 2 - 0.01, 0.1, d - 0.03, { color: '#34373a' })
      b.span('gloss', -w / 2, 0.1, 0, w / 2, h, d - 0.016, { color: grey })
      for (let i = 0; i < cols; i++) {
        const x0 = -w / 2 + (w * i) / cols + 0.004
        const x1 = -w / 2 + (w * (i + 1)) / cols - 0.004
        for (const [y0, y1] of [[0.104, mid - 0.004], [mid + 0.004, h - 0.012]]) {
          b.span('gloss', x0, y0, d - 0.016, x1, y1, d - 0.006, { color: grey, radius: 0.002 })
          for (let k = 0; k < 5; k++) b.box('rubber', (x0 + x1) / 2, y1 - 0.07 - k * 0.024, d - 0.005, (x1 - x0) * 0.55, 0.009, 0.002, { color: '#6d7378' })
          b.box('steel', x1 - 0.045, (y0 + y1) / 2 - 0.05, d - 0.004, 0.028, 0.1, 0.006, { color: '#8c9196', radius: 0.003 })
          b.box('plastic', (x0 + x1) / 2, y0 + 0.16, d - 0.005, 0.05, 0.026, 0.002, { color: '#f4f5f5' })
        }
      }
      return
    }
    case 'coatHooks': {
      b.span('laminate', -w / 2, 1.62, 0, w / 2, 1.72, 0.03, { color: '#dde1e5' })
      const n = 3
      for (let i = 0; i < n; i++) {
        const x = -w / 2 + 0.15 + (i * (w - 0.3)) / (n - 1)
        b.cyl('steel', x, 1.67, 0.06, 0.01, 0.01, 0.08, { rx: Math.PI / 2 })
        b.box('plastic', x, 1.22, 0.1, 0.42, 0.85, 0.08, { color: i % 2 ? '#f5f6f7' : '#e8ecf3', radius: 0.03 })
      }
      return
    }
  }
}

// ── bench-top instruments (local frame: on the worktop, +z towards the user) ──

const TOP_W: Record<Top, number> = {
  pc: 0.6, microscope: 0.3, stereo: 0.28, balance: 0.36, stirrer: 0.26, rotavap: 0.6, phMeter: 0.24, spec: 0.5, plateReader: 0.5,
  microfuge: 0.3, vortex: 0.16, thermocycler: 0.3, instrument: 0.5, instrumentTall: 0.45, hplc: 0.45, gc: 0.65, ms: 0.7,
  bottles: 0.32, waterBath: 0.45, oven: 0.5, tubeFurnace: 0.7, gelTank: 0.32, bioreactor: 0.45, counter: 0.6, shield: 0.6,
  tips: 0.3, racks: 0.3, tlcLamp: 0.3, sonicator: 0.32, digester: 0.5, flash: 0.55, pcrHood: 0.9, microtome: 0.42, stainer: 0.8,
  analyser: 0.6, ecg: 0.35, organBath: 0.7, meltingPoint: 0.3, polarimeter: 0.6, ftir: 0.42, potentiostat: 0.4, calorimeter: 0.45,
  colonyCounter: 0.36, cellCounter: 0.25, ballMill: 0.4, manifold: 1.0, beakers: 0.3,
}

function box(b: Batch, w: number, h: number, d: number, color = WHITE, scr?: [number, number, number, number]) {
  b.box('gloss', 0, h / 2, 0, w, h, d, { color, radius: Math.min(0.02, h / 4) })
  if (scr) screen(b, scr[0], scr[1], d / 2 + 0.004, scr[2], scr[3])
  b.shadow(0, 0, 0, w, d, 0.55)
}

const TOP_POWER:Record<Top,'manual'|'delegated'|'mains'|'external-dc'>={
  'pc':'delegated',
  'microscope':'delegated',
  'stereo':'delegated',
  'balance':'mains',
  'stirrer':'mains',
  'rotavap':'mains',
  'phMeter':'mains',
  'spec':'mains',
  'plateReader':'delegated',
  'microfuge':'delegated',
  'vortex':'delegated',
  'thermocycler':'delegated',
  'instrument':'mains',
  'instrumentTall':'mains',
  'hplc':'mains',
  'gc':'mains',
  'ms':'mains',
  'bottles':'manual',
  'waterBath':'mains',
  'oven':'mains',
  'tubeFurnace':'mains',
  'gelTank':'external-dc',
  'bioreactor':'mains',
  'counter':'mains',
  'shield':'manual',
  'tips':'manual',
  'racks':'manual',
  'tlcLamp':'mains',
  'sonicator':'mains',
  'digester':'mains',
  'flash':'mains',
  'pcrHood':'mains',
  'microtome':'manual',
  'stainer':'mains',
  'analyser':'mains',
  'ecg':'mains',
  'organBath':'mains',
  'meltingPoint':'mains',
  'polarimeter':'mains',
  'ftir':'mains',
  'potentiostat':'mains',
  'calorimeter':'mains',
  'colonyCounter':'mains',
  'cellCounter':'mains',
  'ballMill':'mains',
  'manifold':'manual',
  'beakers':'manual'
}

function buildTop(b: Batch, kind: Top, rand: () => number) {
  if(TOP_POWER[kind]!=='mains')return buildTopGeometry(b,kind,rand)
  appliance(b,kind,()=>buildTopGeometry(b,kind,rand),'plug')
  if(kind==='hplc')for(let i=1;i<4;i++)powerInlet(b,`hplc module ${i+1}`,0,.08+i*.16,-.212)
}

function buildTopGeometry(b: Batch, kind: Top, rand: () => number) {
  switch (kind) {
    case 'pc':
      b.at(-0.05, 0, -0.08, 0, () => monitor(b))
      b.at(0.38, 0, -0.12, 0, () => pcTower(b))
      return
    case 'microscope': return compoundMicroscope(b)
    case 'stereo': return stereoMicroscope(b)
    case 'microfuge': return microfuge(b)
    case 'vortex': return vortex(b)
    case 'thermocycler': return thermocycler(b)
    case 'tips': return tipBox(b, 0, 0, ['#38bdf8', '#f8fafc', '#facc15'][Math.floor(rand() * 3)])
    case 'racks': return tubeRack(b, 0, 0, ['#ec4899', '#38bdf8', '#a3e635'][Math.floor(rand() * 3)], 8, 4)
    case 'balance':
      box(b, 0.22, 0.08, 0.32, WHITE, [0, 0.04, 0.1, 0.03])
      b.box('glass', 0, 0.2, -0.03, 0.2, 0.22, 0.2)
      b.box('frame', 0, 0.315, -0.03, 0.21, 0.01, 0.21, { color: OFFWHITE })
      return
    case 'stirrer':
      box(b, 0.18, 0.09, 0.26, WHITE)
      b.box('gloss', 0, 0.1, -0.03, 0.17, 0.01, 0.17, { color: '#d9dde1' })
      b.cyl('gloss', 0, 0.05, 0.131, 0.015, 0.015, 0.01, { rx: Math.PI / 2, color: '#dc2626' })
      b.lathe('bottle', [[0.0001, 0], [0.05, 0], [0.05, 0.11], [0.055, 0.12]], 0, 0.105, -0.03, '#f4f7fa')
      b.cyl('liquid', 0, 0.15, -0.03, 0.046, 0.046, 0.08, { color: ['#bfdbfe', '#fde68a', '#fbcfe8'][Math.floor(rand() * 3)], seg: 14 })
      return
    case 'rotavap':
      box(b, 0.32, 0.06, 0.34, WHITE)
      b.cyl('steel', 0.1, 0.03, 0.02, 0.13, 0.13, 0.12, { seg: 20 })
      b.cyl('liquid', 0.1, 0.09, 0.02, 0.12, 0.12, 0.004, { color: '#9cc6e8', seg: 20 })
      b.box('gloss', -0.18, 0.35, -0.08, 0.06, 0.7, 0.06, { color: OFFWHITE })
      b.box('gloss', -0.08, 0.5, -0.05, 0.2, 0.1, 0.1, { color: OFFWHITE, rz: -0.6 })
      b.sphere('bottle', 0.1, 0.18, 0.02, 0.08, '#f4f7fa')
      b.cyl('bottle', -0.05, 0.62, -0.06, 0.045, 0.045, 0.35, { color: '#f4f7fa', rz: 0.15 })
      b.sphere('bottle', -0.12, 0.25, 0.08, 0.07, '#f4f7fa')
      return
    case 'phMeter':
      box(b, 0.16, 0.05, 0.2, WHITE, [0, 0.03, 0.09, 0.03])
      b.cyl('steel', 0.1, 0.18, -0.06, 0.006, 0.006, 0.34)
      b.box('steel', 0.06, 0.32, -0.04, 0.09, 0.01, 0.01)
      b.cyl('glass', 0.02, 0.22, -0.04, 0.006, 0.006, 0.18)
      return
    case 'plateReader': return plateReader(b)
    case 'spec':
      box(b, TOP_W[kind] - 0.04, 0.22, 0.42, WHITE, [-0.1, 0.13, 0.14, 0.07])
      b.box('gloss', 0.12, 0.08, 0.215, 0.18, 0.05, 0.01, { color: '#d6dbe0' })
      return
    case 'instrument':
      box(b, 0.46, 0.25 + rand() * 0.12, 0.42, rand() > 0.5 ? WHITE : '#e4e8ec', [0.1, 0.16, 0.12, 0.07])
      return
    case 'instrumentTall':
      box(b, 0.42, 0.55, 0.45, WHITE, [0, 0.42, 0.18, 0.1])
      return
    case 'hplc': {
      const tiers = 4
      for (let i = 0; i < tiers; i++) {
        b.box('gloss', 0, 0.08 + i * 0.16, 0, 0.36, 0.15, 0.42, { color: i % 2 ? '#e9ecef' : WHITE, radius: 0.008 })
        b.box('rubber', 0.12, 0.08 + i * 0.16, 0.212, 0.06, 0.012, 0.004, { color: '#22c55e' })
      }
      for (let i = 0; i < 4; i++) bottle(b, -0.12 + i * 0.08, 0, 0.03, 0.14, '#1f2937', i % 2 ? '#e0f2fe' : undefined, false)
      b.at(0, tiers * 0.16, 0, 0, () => {
        for (let i = 0; i < 4; i++) bottle(b, -0.12 + i * 0.08, 0, 0.03, 0.14, '#1f2937', i % 2 ? '#e0f2fe' : undefined, false)
      })
      b.shadow(0, 0, 0, 0.36, 0.42, 0.55)
      return
    }
    case 'gc':
      box(b, 0.6, 0.48, 0.5, '#eef0f2', [0.2, 0.36, 0.12, 0.08])
      b.box('steel', -0.08, 0.24, 0.252, 0.36, 0.34, 0.008)
      b.cyl('chrome', -0.18, 0.52, 0.05, 0.03, 0.03, 0.08)
      return
    case 'ms':
      box(b, 0.65, 0.5, 0.55, WHITE, [0.2, 0.38, 0.12, 0.08])
      b.box('gloss', -0.15, 0.25, 0.28, 0.2, 0.2, 0.01, { color: '#cbd5e1' })
      return
    case 'bottles':
      for (let i = 0; i < 4; i++) bottle(b, -0.12 + i * 0.08, (i % 2) * 0.05, 0.035 + rand() * 0.01, 0.14 + rand() * 0.06, rand() > 0.3 ? '#1f5fd1' : '#0f766e', rand() > 0.5 ? '#e0f2fe' : undefined)
      return
    case 'beakers':
      for (let i = 0; i < 3; i++) {
        const x = -0.1 + i * 0.1
        b.add('bottle',beakerGeometry(.04,.105,b.detail==='full'?40:24),new THREE.Matrix4().makeTranslation(x,0,0),'#edf3ef')
        b.cyl('liquid', x, 0.03, 0, 0.037, 0.037, 0.05, { color: ['#bae6fd', '#fde68a', '#fecaca'][i], seg: 12 })
      }
      return
    case 'waterBath':
      box(b, 0.42, 0.24, 0.34, '#e8eaec', [-0.07, 0.1, 0.09, 0.034])
      b.box('steel', 0, 0.245, -0.02, 0.36, 0.02, 0.26, { radius: 0.01 })
      return
    case 'oven':
    case 'digester':
      box(b, 0.46, 0.42, 0.45, kind === 'oven' ? '#e8eaec' : WHITE, [0.14, 0.32, 0.1, 0.05])
      b.box('steel', -0.06, 0.2, 0.228, 0.26, 0.26, 0.008)
      return
    case 'tubeFurnace':
      box(b, 0.36, 0.14, 0.32, '#e8eaec', [0, 0.08, 0.12, 0.05])
      b.cyl('gloss', 0, 0.28, 0, 0.12, 0.12, 0.42, { rz: Math.PI / 2, color: '#f2f3f4', seg: 24 })
      b.cyl('glass', 0, 0.28, 0, 0.03, 0.03, 0.9, { rz: Math.PI / 2 })
      return
    case 'gelTank':
      b.box('bottle', 0, 0.06, 0, 0.26, 0.11, 0.13, { color: '#eef6ff' })
      b.box('gloss', 0, 0.12, 0, 0.28, 0.015, 0.14, { color: '#bfd7ff' })
      // The tank uses DC from its own mains-powered supply, rather than a wall plug on the lid.
      b.at(0,0,-.13,0,()=>appliance(b,'electrophoresis supply',()=>{
        b.box('plastic',0,.04,0,.20,.08,.08,{color:'#e9ecee',radius:.003})
        b.decal('psu',-.035,.05,.041,.08,.026,0,'screen',1.2)
        b.cyl('rubber',.066,.05,.043,.009,.009,.008,{rx:Math.PI/2,seg:12})
      }))
      for(const [x,color] of [[-.09,'#cf262a'],[.09,'#1d2428']] as const) {
        b.cyl('rubber',x,.133,-.035,.007,.007,.016,{color,seg:10})
        b.cyl('rubber',x,.025,-.086,.006,.006,.012,{color,rx:Math.PI/2,seg:10})
        b.tube('rubber',[new THREE.Vector3(x,.141,-.035),new THREE.Vector3(x,.16,-.067),new THREE.Vector3(x,.065,-.078),new THREE.Vector3(x,.025,-.080)],.0025,color)
      }
      return
    case 'bioreactor':
      box(b, 0.2, 0.3, 0.3, '#e8eaec', [0, 0.22, 0.1, 0.06])
      b.cyl('bottle', 0.2, 0.22, 0, 0.09, 0.09, 0.44, { color: '#f4f7fa' })
      b.cyl('liquid', 0.2, 0.15, 0, 0.085, 0.085, 0.28, { color: '#fde68a', seg: 16 })
      b.cyl('steel', 0.2, 0.46, 0, 0.1, 0.1, 0.04)
      return
    case 'counter':
    case 'analyser':
      box(b, TOP_W[kind] - 0.04, 0.38, 0.5, WHITE, [0.15, 0.28, 0.14, 0.08])
      b.box('gloss', -0.12, 0.39, 0, 0.22, 0.02, 0.3, { color: '#cfd6dd' })
      return
    case 'shield':
      b.box('frame', 0, 0.01, 0, 0.56, 0.02, 0.3, { color: '#9aa1a9' })
      b.within(new THREE.Matrix4().makeRotationX(-0.12).setPosition(0, 0.3, 0.12), () => b.box('glass', 0, 0, 0, 0.5, 0.55, 0.03, { color: '#fde68a' }))
      return
    case 'tlcLamp':
      box(b, 0.24, 0.16, 0.2, '#2b2f36')
      b.box('glow', 0, 0.02, 0.06, 0.18, 0.004, 0.08, { color: new THREE.Color(0.6, 0.4, 2.4) })
      return
    case 'sonicator':
      box(b, 0.28, 0.2, 0.22, '#e8eaec', [0.08, 0.1, 0.06, 0.03])
      b.box('steel', 0, 0.205, 0, 0.24, 0.01, 0.18)
      return
    case 'flash':
      box(b, 0.5, 0.45, 0.45, WHITE, [0.12, 0.33, 0.14, 0.09])
      for (let i = 0; i < 6; i++) b.cyl('bottle', -0.18 + i * 0.07, 0.06, 0.28, 0.012, 0.012, 0.11, { color: '#f4f7fa' })
      return
    case 'pcrHood':
      b.box('frame', 0, 0.01, 0, 0.86, 0.02, 0.55, { color: '#d9dde1' })
      b.box('glass', -0.42, 0.33, 0, 0.01, 0.62, 0.55)
      b.box('glass', 0.42, 0.33, 0, 0.01, 0.62, 0.55)
      b.box('glass', 0, 0.33, -0.27, 0.86, 0.62, 0.01)
      b.box('gloss', 0, 0.66, 0, 0.88, 0.05, 0.57, { color: WHITE })
      b.box('glow', 0, 0.63, 0, 0.6, 0.004, 0.06, { color: new THREE.Color(0.4, 0.3, 2.2) })
      b.at(-0.15, 0.02, -0.05, 0, () => tipBox(b, 0, 0, '#f8fafc'))
      return
    case 'microtome':
      box(b, 0.36, 0.28, 0.4, '#e8eaec')
      b.cyl('steel', 0.2, 0.15, 0, 0.12, 0.12, 0.03, { rz: Math.PI / 2, seg: 24 })
      return
    case 'stainer':
      box(b, 0.76, 0.32, 0.45, WHITE, [0.25, 0.22, 0.14, 0.07])
      b.plane('glass', -0.12, 0.33, 0, 0.45, 0.35, 0, undefined, -Math.PI / 2)
      return
    case 'ecg':
      box(b, 0.3, 0.12, 0.25, WHITE, [0, 0.07, 0.2, 0.06])
      return
    case 'organBath':
      box(b, 0.62, 0.08, 0.3, '#e8eaec')
      for (let i = 0; i < 4; i++) {
        b.cyl('bottle', -0.22 + i * 0.15, 0.25, 0, 0.04, 0.04, 0.3, { color: '#f4f7fa' })
        b.cyl('steel', -0.22 + i * 0.15, 0.55, -0.05, 0.006, 0.006, 0.3)
      }
      return
    case 'meltingPoint':
      box(b, 0.26, 0.18, 0.28, WHITE, [0, 0.11, 0.12, 0.05])
      return
    case 'polarimeter':
      box(b, 0.56, 0.2, 0.28, '#e8eaec', [0.18, 0.12, 0.1, 0.05])
      return
    case 'ftir':
      box(b, 0.38, 0.22, 0.32, '#2f3640', [0.1, 0.14, 0.1, 0.05])
      b.cyl('steel', -0.1, 0.24, 0.06, 0.03, 0.03, 0.04)
      return
    case 'potentiostat':
      box(b, 0.24, 0.08, 0.2, DARK)
      b.box('frame', 0.12, 0.2, -0.05, 0.25, 0.38, 0.25, { color: '#9aa1a9' })
      return
    case 'calorimeter':
      box(b, 0.42, 0.34, 0.4, '#e8eaec', [0.12, 0.25, 0.1, 0.06])
      b.cyl('steel', -0.08, 0.36, 0, 0.08, 0.08, 0.06)
      return
    case 'colonyCounter':
      box(b, 0.32, 0.16, 0.3, '#e8eaec')
      b.cyl('glow', 0, 0.165, 0, 0.1, 0.1, 0.004, { color: new THREE.Color(1.8, 1.8, 1.7) })
      return
    case 'cellCounter':
      box(b, 0.2, 0.18, 0.22, WHITE, [0, 0.11, 0.14, 0.08])
      return
    case 'ballMill':
      box(b, 0.36, 0.3, 0.36, '#e8eaec', [0.12, 0.22, 0.08, 0.04])
      return
    case 'manifold':
      for (const y of [0.45, 0.55]) b.cyl('bottle', 0, y, -0.15, 0.025, 0.025, 0.95, { rz: Math.PI / 2, color: '#f4f7fa' })
      for (let i = 0; i < 5; i++) b.cyl('steel', -0.36 + i * 0.18, 0.5, -0.1, 0.012, 0.012, 0.12, { rx: Math.PI / 2 })
      for (const x of [-0.45, 0.45]) b.box('steel', x, 0.3, -0.2, 0.02, 0.6, 0.02)
      return
  }
}

// ── centrepieces ───────────────────────────────────────────────────────────

function centerSize(kind: Center): [number, number] {
  switch (kind) {
    case 'island': return [0, 0]
    case 'nmr': return [2.8, 2.8]
    case 'opticalTable': return [1.8, 1.2]
    case 'laserEnclosure': return [2.6, 1.9]
    case 'confocal': return [1.6, 1.1]
    case 'confocalBay': return [2.2, 1.8]
    case 'ephys': return [1.7, 1.5]
    case 'hubConsole': return [2.6, 2.6]
    case 'desks': return [2.0, 1.5]
    case 'bench': return [1.4, 0.45]
  }
}

function buildCenter(b: Batch, kind: Center, w: number, d: number, ctx: LabCtx) {
  switch (kind) {
    case 'nmr': {
      // magnet on its legs, 5-gauss line taped on the floor
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2
        b.box('steel', Math.cos(a) * 0.32, 0.2, Math.sin(a) * 0.32, 0.06, 0.4, 0.06)
      }
      b.cyl('gloss', 0, 1.0, 0, 0.48, 0.48, 1.25, { color: '#eef1f4', seg: 40 })
      b.cyl('gloss', 0, 1.66, 0, 0.3, 0.42, 0.12, { color: '#e5e9ee', seg: 32 })
      b.cyl('steel', 0, 1.82, 0, 0.12, 0.12, 0.2, { seg: 18 })
      for (const a of [0.4, 2.5, 4.2]) b.cyl('steel', Math.cos(a) * 0.22, 1.95, Math.sin(a) * 0.22, 0.04, 0.04, 0.12, { seg: 10 })
      b.cyl('gloss', 0, 1.2, 0, 0.485, 0.485, 0.08, { color: BLUE, seg: 40 })
      powerInlet(b,'NMR services',0,.65,-.482,'fixed')
      const R = 1.35
      for (let i = 0; i < 28; i++) {
        if (i % 2) continue
        const a = (i / 28) * Math.PI * 2
        b.box('gloss', Math.cos(a) * R, 0.002, Math.sin(a) * R, 0.26, 0.003, 0.05, { color: '#d9a400', ry: -a + Math.PI / 2 })
      }
      return
    }
    case 'opticalTable': {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box('steel', sx * (w / 2 - 0.12), 0.36, sz * (d / 2 - 0.12), 0.12, 0.72, 0.12)
      b.box('steel', 0, 0.78, 0, w, 0.12, d)
      const lasers = [[-0.33, 0.15, 0.22], [-0.08, -0.25, 0.15], [0.25, 0.2, 0.13]]
      for (const [x,z,l] of lasers) appliance(b,'optical table laser',()=>b.box('gloss',x*w,.92,z*d,l*w,.14,.14,{color:x<0?'#1e293b':'#e5e7eb'}))
      for (let i = 0; i < 6; i++) b.cyl('steel', (-0.4 + i * 0.16) * w, 0.92, 0.0, 0.02, 0.02, 0.16)
      b.box('glass', 0, 1.2, 0, w - 0.05, 0.7, d - 0.05, { color: '#f97316' })
      return
    }
    case 'confocal': {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box('steel', sx * (w / 2 - 0.1), 0.36, sz * (d / 2 - 0.1), 0.1, 0.72, 0.1)
      b.box('steel', 0, 0.76, 0, w, 0.08, d)
      b.at(0.2, 0.8, 0, 0, () => compoundMicroscope(b))
      appliance(b,'confocal laser/controller',()=>b.box('gloss',-.45,1,-.15,.45,.4,.4,{color:'#e5e7eb',radius:.02}))
      b.at(0.35, 0.8, 0.35, 0, () => monitor(b))
      return
    }
    case 'ephys': {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box('steel', sx * 0.55, 0.36, sz * 0.45, 0.1, 0.72, 0.1)
      b.box('steel', 0, 0.76, 0, 1.25, 0.08, 1.05)
      b.at(0, 0.8, 0, 0, () => compoundMicroscope(b))
      // Faraday cage
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box('frame', sx * 0.7, 1.3, sz * 0.6, 0.03, 1.8, 0.03, { color: '#7c8591' })
      for (const y of [0.4, 2.2]) {
        b.box('frame', 0, y, -0.6, 1.4, 0.03, 0.03, { color: '#7c8591' })
        b.box('frame', 0, y, 0.6, 1.4, 0.03, 0.03, { color: '#7c8591' })
        b.box('frame', -0.7, y, 0, 0.03, 0.03, 1.2, { color: '#7c8591' })
        b.box('frame', 0.7, y, 0, 0.03, 0.03, 1.2, { color: '#7c8591' })
      }
      b.box('glass', 0, 1.3, -0.6, 1.4, 1.8, 0.004, { color: '#8a93a0' })
      b.box('glass', -0.7, 1.3, 0, 0.004, 1.8, 1.2, { color: '#8a93a0' })
      b.box('glass', 0.7, 1.3, 0, 0.004, 1.8, 1.2, { color: '#8a93a0' })
      return
    }
    case 'laserEnclosure':
    case 'confocalBay': {
      // dark curtains on a ceiling-hung rail round the instrument; the near side is drawn back
      const inner: [number, number] = kind === 'laserEnclosure' ? [1.8, 1.2] : [1.6, 1.1]
      b.at(0, 0, 0, 0, () => buildCenter(b, kind === 'laserEnclosure' ? 'opticalTable' : 'confocal', inner[0], inner[1], ctx))
      const rail = 2.35
      const x0 = w / 2 - 0.05
      const z0 = d / 2 - 0.05
      for (const [ax, az, bx, bz] of [[-x0, -z0, x0, -z0], [x0, -z0, x0, z0], [-x0, z0, x0, z0], [-x0, -z0, -x0, z0]]) {
        b.box('steel', (ax + bx) / 2, rail, (az + bz) / 2, Math.abs(bx - ax) + 0.03, 0.03, Math.abs(bz - az) + 0.03)
      }
      for (const [x, z] of [[-x0, -z0], [x0, -z0], [x0, z0], [-x0, z0]]) b.box('steel', x, rail / 2, z, 0.03, rail, 0.03)
      const cloth = kind === 'laserEnclosure' ? '#2a2f36' : '#30353d'
      // pleated drops: narrow panels alternately in and out so they read as fabric
      const drop = (ax: number, az: number, bx: number, bz: number) => {
        const L = Math.hypot(bx - ax, bz - az)
        const n = Math.max(3, Math.round(L / 0.16))
        for (let i = 0; i < n; i++) {
          const f = (i + 0.5) / n
          const off = i % 2 ? 0.018 : -0.018
          const x = ax + (bx - ax) * f + (az === bz ? 0 : off)
          const z = az + (bz - az) * f + (az === bz ? off : 0)
          const sx = az === bz ? L / n + 0.012 : 0.02
          const sz = az === bz ? 0.02 : L / n + 0.012
          b.box('rubber', x, rail / 2 + 0.03, z, sx, rail - 0.08, sz, { color: cloth })
        }
      }
      drop(-x0, -z0, x0, -z0)
      drop(x0, -z0, x0, z0)
      drop(-x0, -z0, -x0, z0)
      // the near side is drawn back and bunched at one end
      for (let i = 0; i < 4; i++) b.box('rubber', -x0 + 0.08 + i * 0.07, rail / 2 + 0.03, z0 + (i % 2 ? 0.03 : -0.01), 0.07, rail - 0.08, 0.05, { color: cloth })
      if (kind === 'laserEnclosure') {
        appliance(b,'laser warning indicator',()=>b.box('gloss', x0 - 0.15, rail + 0.12, z0, 0.16, 0.1, 0.06, { color: '#2b2f36' }))
        b.box('glow', x0 - 0.15, rail + 0.12, z0 + 0.031, 0.12, 0.06, 0.004, { color: new THREE.Color(2.6, 0.5, 0.2) })
      }
      return
    }
    case 'hubConsole': {
      // round information desk with the institute map and course screens
      b.cyl('gloss', 0, 0.45, 0, 1.0, 1.05, 0.9, { color: WHITE, seg: 48 })
      b.cyl('worktop', 0, 0.92, 0, 1.08, 1.08, 0.04, { seg: 48 })
      b.cyl('gloss', 0, 0.98, 0, 0.55, 0.55, 0.08, { color: '#e5e8eb', seg: 32 })
      b.decal('notice', 0, 1.025, 0, 0.8, 0.55, 0, 'paper', 1, -Math.PI / 2)
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + Math.PI / 6
        b.at(Math.cos(a) * 0.75, 0.94, Math.sin(a) * 0.75, -a + Math.PI / 2, () => {
          b.box('plastic', 0, 0.05, 0, 0.1, 0.1, 0.08, { color: DARK })
          b.within(new THREE.Matrix4().makeRotationX(-0.5).setPosition(0, 0.24, 0.04), () => {
            b.box('plastic', 0, 0, 0, 0.62, 0.38, 0.03, { color: '#131417', radius: 0.008 })
            b.decal('tv', 0, 0, 0.016, 0.58, 0.34, 0, 'screen', 1.1)
          })
        })
      }
      powerInlet(b,'information console',0,.3,-1.03)
      return
    }
    case 'desks': {
      for (const sz of [-1, 1]) {
        b.at(0, 0, sz * 0.42, sz > 0 ? 0 : Math.PI, () => {
          b.box('worktop', 0, 0.74, 0, w - 0.2, 0.03, 0.75, { bake: ['+y', '+z', '-z'] })
          for (const sx of [-1, 1]) b.box('steel', sx * (w / 2 - 0.15), 0.37, 0, 0.04, 0.72, 0.7)
          for (const x of [-0.6, 0.6]) {
            b.at(x, 0.755, -0.15, 0, () => monitor(b))
            // Leave the castor base enough clearance to slide between desk legs.
            b.at(x * 0.8, 0, 0.75, Math.PI, () => chair(b, ctx))
          }
        })
      }
      return
    }
    case 'bench':
      b.box('worktop', 0, 0.44, 0, w, 0.05, d)
      for (const sx of [-1, 1]) b.box('steel', sx * (w / 2 - 0.1), 0.21, 0, 0.05, 0.42, d - 0.05)
      return
    case 'island':
      return
  }
}

/**
 * Autoclaves set into the wall shared with `other`. Both rooms compute the
 * same world positions (the shared stretch minus door openings), so their
 * halves meet back to back like one pass-through unit.
 */
function passThrough(ctx: LabCtx, p: RoomPlan, other: ZoneId, count: number, rand: () => number) {
  const b = ctx.batch[p.zone.id]
  const nb = ZONES[other]
  if (!nb) return
  for (const wall of p.walls) {
    // which part of this wall has the other room behind it
    let s0 = Infinity
    let s1 = -Infinity
    for (let s = 0.05; s < wall.length; s += 0.05) {
      const q = wp(wall, s, -0.3)
      if (polygonContains(nb.floor, q[0], q[1])) {
        s0 = Math.min(s0, s)
        s1 = Math.max(s1, s)
      }
    }
    if (s1 - s0 < 1) continue
    // world coordinate along the wall, so both rooms agree
    const along = Math.abs(wall.t[0]) > 0.5 ? 0 : 1
    const world = (s: number) => wp(wall, s, 0)[along]
    let free: [number, number][] = [[Math.min(world(s0), world(s1)), Math.max(world(s0), world(s1))]]
    const shared = DOORS.filter((d) => (d.a === p.zone.id && d.b === other) || (d.b === p.zone.id && d.a === other))
    for (const d of shared) {
      const c = d.center[along]
      const half = doorWidth(d) / 2 + 0.15
      free = free.flatMap(([f0, f1]) => (c + half <= f0 || c - half >= f1 ? [[f0, f1]] : [[f0, c - half], [c + half, f1]].filter(([g0, g1]) => g1 - g0 > 0.05)) as [number, number][])
    }
    free.sort((x, y) => y[1] - y[0] - (x[1] - x[0]))
    const [f0, f1] = free[0] ?? [0, 0]
    const W = 0.95
    const gap = 0.1
    const n = Math.min(count, Math.floor((f1 - f0 + gap) / (W + gap)))
    if (n < 1) {
      console.warn(`[furnish] ${p.zone.id}: no room for the pass-through autoclave`)
      return
    }
    const mid = (f0 + f1) / 2
    for (let i = 0; i < n; i++) {
      const cw = mid + (i - (n - 1) / 2) * (W + gap)
      // back to wall-local s for this room
      const sC = (cw - wall.a[along]) / wall.t[along]
      const [, , h] = tallSize('autoclave')
      const D = 0.85
      const c = wp(wall, sC, 0)
      b.at(c[0], 0, c[1], yawFor(wall.n), () => buildTall(b, 'autoclave', W, D, h, rand))
      const box = stripRect(wall, sC - W / 2, sC + W / 2, 0, D)
      p.placed.push(box)
      ctx.collider(box.minX, box.minZ, box.maxX, box.maxZ)
      ctx.occluder(p.zone.id, [box.minX, 0, box.minZ], [box.maxX, h, box.maxZ])
    }
    return
  }
  console.warn(`[furnish] ${p.zone.id}: no wall shared with ${other}`)
}

// ── room assembly ──────────────────────────────────────────────────────────

function furnishRoom(ctx: LabCtx, zone: Zone, r: Recipe) {
  const b = ctx.batch[zone.id]
  const p = planRoom(zone)
  const rand = rng(zone.id.split('').reduce((h, c) => h * 31 + c.charCodeAt(0), 7) >>> 0)

  // 1. centrepieces claim their floor (and aisle) first: they are the reason the room exists
  for (const kind of r.center ?? []) {
    if (kind === 'island') continue
    const [w, d] = centerSize(kind)
    const bb = rectOf(zone.floor)
    const longX = bb.maxX - bb.minX >= bb.maxZ - bb.minZ
    // the NMR's 5-gauss circle may reach into a doorway approach; the magnet may not
    const aisle = kind === 'nmr' ? 0 : kind === 'laserEnclosure' || kind === 'confocalBay' ? 0.45 : 0.6
    const core: [number, number] | undefined = kind === 'nmr' ? [1.1, 1.1] : undefined
    let rect: Rect | null = null
    let rot = false
    let order = (w >= d) === longX ? [false, true] : [true, false]
    // curtained bays: prefer the footprint whose open (local +z) side can face the way in
    if ((kind === 'laserEnclosure' || kind === 'confocalBay') && p.mainDoor) {
      const dx = Math.abs(p.mainDoor[0] - (bb.minX + bb.maxX) / 2)
      const dz = Math.abs(p.mainDoor[1] - (bb.minZ + bb.maxZ) / 2)
      order = dx > dz ? [true, false] : [false, true]
    }
    for (const r0 of order) {
      rect = r0 ? findSpot(p, d, w, aisle, core) : findSpot(p, w, d, aisle, core)
      if (rect) {
        rot = r0
        break
      }
    }
    if (!rect) {
      console.warn(`[furnish] ${zone.id}: no room for ${kind}`)
      continue
    }
    const cx = (rect.minX + rect.maxX) / 2
    const cz = (rect.minZ + rect.maxZ) / 2
    let yaw = rot ? Math.PI / 2 : 0
    // curtained bays turn their open side towards the way in
    if ((kind === 'laserEnclosure' || kind === 'confocalBay') && p.mainDoor && Math.sin(yaw) * (p.mainDoor[0] - cx) + Math.cos(yaw) * (p.mainDoor[1] - cz) < 0) yaw += Math.PI
    b.at(cx, 0, cz, yaw, () => buildCenter(b, kind, w, d, ctx))
    p.placed.push(grow(rect, kind === 'nmr' ? 0.2 : aisle))
    if (kind === 'nmr') {
      ctx.collider(cx - 0.55, cz - 0.55, cx + 0.55, cz + 0.55)
      ctx.occluder(zone.id, [cx - 0.5, 0, cz - 0.5], [cx + 0.5, 2.0, cz + 0.5])
    } else if (kind === 'hubConsole') {
      // a round desk casts a round shadow, not its square footprint's
      ctx.collider(rect.minX, rect.minZ, rect.maxX, rect.maxZ)
      ctx.occluderDisc(zone.id, cx, cz, 1.06, 0.94)
    } else {
      ctx.collider(rect.minX, rect.minZ, rect.maxX, rect.maxZ)
      ctx.occluder(zone.id, [rect.minX, 0, rect.minZ], [rect.maxX, 1.2, rect.maxZ])
    }
  }

  // 2. pass-through autoclaves in the wall shared with the clean side
  if (r.passThrough) passThrough(ctx, p, r.passThrough.zone, r.passThrough.count, rand)

  // Where people pass through, the seating and notices take the door-free end
  // wall first (a bench under the noticeboard, a plant beside it) and tall
  // fixtures such as lockers line a side wall; in labs, tall fixtures come first.
  const circulation = CIRCULATION.has(zone.room?.kind ?? '')
  if (circulation) for (const item of r.decor ?? []) decor(ctx, p, item)

  // 3. tall fixtures against the walls
  for (const kind of r.tall ?? []) {
    const [w, d, h] = tallSize(kind)
    const slot = placeOnWall(p, w, d, kind === 'coatHooks' ? 'mounted' : kind === 'balanceTable' || kind === 'radioBench' ? 'floor' : 'tall')
    if (!slot) {
      console.warn(`[furnish] ${zone.id}: no wall space for ${kind} (${w.toFixed(2)} m)`)
      continue
    }
    const c = wp(slot.wall, slot.s + w / 2, 0)
    b.at(c[0], 0, c[1], yawFor(slot.wall.n), () => buildTall(b, kind, w, d, h, rand))
    const box = stripRect(slot.wall, slot.s, slot.s + w, 0, d)
    if (kind !== 'coatHooks') {
      ctx.collider(box.minX, box.minZ, box.maxX, box.maxZ)
      // the isotope bench is open above its worktop (a glass shield, a counter with its own occluder)
      const body = kind === 'radioBench' ? BENCH_TOP : h
      ctx.occluder(zone.id, [box.minX, 0, box.minZ], [box.maxX, body, box.maxZ])
    }
  }

  // 4. perimeter casework, then an island in what is left
  p.kneesLeft = r.chairs ?? 0
  addBenchRuns(ctx, p, r)
  if (r.center?.includes('island')) island(ctx, p)

  // 4. bench-top instruments, spread round-robin over the runs
  const cursors = p.runs.map(() => 0.22)
  const tops = r.tops ?? []
  let ri = 0
  for (const kind of tops) {
    const w = TOP_W[kind]
    for (let tries = 0; tries < p.runs.length; tries++) {
      const i = (ri + tries) % p.runs.length
      const run = p.runs[i]
      let s = cursors[i] + w / 2
      if (run.sink && s + w / 2 > run.sink[0] - 0.05 && s - w / 2 < run.sink[1] + 0.05) s = run.sink[1] + 0.08 + w / 2
      if (s + w / 2 > run.length - 0.12) continue
      const [x, z] = benchPoint(run.run, s, run.run.depth * 0.45)
      b.at(x, BENCH_TOP, z, benchYaw(run.run), () => buildTop(b, kind, rand))
      cursors[i] = s + w / 2 + 0.22
      ri = i + 1
      break
    }
  }
  // a few small consumables on any leftover worktop
  p.runs.forEach((run, i) => {
    const s = cursors[i] + 0.15
    if (s < run.length - 0.4 && rand() < 0.7) {
      const [x, z] = benchPoint(run.run, s, run.run.depth * 0.4)
      b.at(x, BENCH_TOP, z, benchYaw(run.run), () => (rand() < 0.5 ? carton(b, 0, 0, 0.16, 0.1, 0.12) : bottle(b, 0, 0, 0.04, 0.16, '#1f5fd1')))
    }
  })

  // 5. chairs at knee spaces
  let chairs = r.chairs ?? 0
  for (const run of p.runs) {
    if (chairs <= 0) break
    let s = 0
    for (const m of run.run.modules) {
      if (m.kind === 'knee' && chairs > 0) {
        let [x, z] = benchPoint(run.run, s + m.w / 2, run.run.depth + 0.32)
        // A knee space beside a corner can put its chair inside the adjoining
        // bench's footprint. Pull only those chairs into the nearest clear spot.
        const clear = (px: number, pz: number) => polygonContains(zone.floor, px, pz)
          && !p.keepClear.some((q) => px > q.minX && px < q.maxX && pz > q.minZ && pz < q.maxZ)
          && !ctx.colliders.some((q) => px > q.minX - 0.025 && px < q.maxX + 0.025 && pz > q.minZ - 0.025 && pz < q.maxZ + 0.025)
        if (!clear(x, z)) {
          let found = false
          for (let radius = 0.1; radius <= 0.7 && !found; radius += 0.1) {
            for (let i = 0; i < 16; i++) {
              const angle = benchYaw(run.run) + i * Math.PI / 8
              const px = x + Math.sin(angle) * radius
              const pz = z + Math.cos(angle) * radius
              if (!clear(px, pz)) continue
              x = px
              z = pz
              found = true
              break
            }
          }
        }
        if (polygonContains(zone.floor, x, z) && !p.keepClear.some((q) => x > q.minX && x < q.maxX && z > q.minZ && z < q.maxZ)) {
          b.at(x, 0, z, benchYaw(run.run) + Math.PI + (rand() - 0.5) * 0.4, () => chair(b, ctx))
          chairs--
        }
      }
      s += m.w
    }
  }

  // 6. outlets above wall runs
  for (const run of p.runs) {
    if (run.island) continue
    b.at(run.run.start[0], 0, run.run.start[1], benchYaw(run.run), () => {
      for (let s = 0.4; s < run.length - 0.2; s += 1.2) outlet(b, s, 1.1)
    })
  }

  // 7. decor on free wall stretches
  if (!circulation) for (const item of r.decor ?? []) decor(ctx, p, item)

  // 8. a card reader beside the latch of every door off a corridor, lobby or commons
  if (CIRCULATION.has(zone.room?.kind ?? '')) {
    for (const d of DOORS) {
      if (d.kind === 'opening' || (d.a !== zone.id && d.b !== zone.id)) continue
      const into: Vec2 = d.a === zone.id ? [-d.normal[0], -d.normal[1]] : d.normal
      const along: Vec2 = [-d.normal[1], d.normal[0]]
      const hinge = doorFrame(d, d.hingeSide).hinge
      const toHinge = Math.sign((hinge[0] - d.center[0]) * along[0] + (hinge[1] - d.center[1]) * along[1]) || 1
      const off = doorWidth(d) / 2 + 0.17
      const at: Vec2 = [d.center[0] - along[0] * toHinge * off + into[0] * (d.thickness / 2), d.center[1] - along[1] * toHinge * off + into[1] * (d.thickness / 2)]
      if (!polygonContains(zone.floor, at[0] + into[0] * 0.05, at[1] + into[1] * 0.05)) continue
      b.at(at[0], 0, at[1], yawFor(into), () => {
        b.box('plastic', 0, 1.1, 0.012, 0.055, 0.1, 0.024, { color: '#1a1c1f', radius: 0.004 })
        b.box('glow', 0, 1.135, 0.025, 0.008, 0.008, 0.002, { color: new THREE.Color(0.2, 1.6, 0.4) })
      })
    }
  }

  // 9. a bin in every lab
  if (!CIRCULATION.has(zone.room?.kind ?? '')) {
    const slot = placeOnWall(p, 0.36, 0.36, 'floor')
    if (slot) {
      const c = wp(slot.wall, slot.s + 0.18, 0.2)
      b.at(c[0], 0, c[1], yawFor(slot.wall.n), () => trashCan(b))
    }
  }

  // 10. the reflection probe must see the room, not the inside of a fixture
  const [px, py, pz] = zone.probe
  if (p.placed.some((q) => px > q.minX && px < q.maxX && pz > q.minZ && pz < q.maxZ)) {
    const spot = findSpot(p, 0.3, 0.3, 0.15)
    if (spot) zone.probe = [(spot.minX + spot.maxX) / 2, py, (spot.minZ + spot.maxZ) / 2]
  }
}

/** Wall-mounted fittings in any free wall stretch (q = 0.25 deep keeps them off benches). */
function decor(ctx: LabCtx, p: RoomPlan, item: NonNullable<Recipe['decor']>[number]) {
  const b = ctx.batch[p.zone.id]
  if (item === 'seats' || item === 'plant' || item === 'tallPlant') {
    const [w, d] = item === 'seats' ? [1.4, 0.45] : item === 'tallPlant' ? [0.6, 0.6] : [0.5, 0.5]
    const slot = placeOnWall(p, w, d + 0.05, 'floor')
    if (!slot) return
    const c = wp(slot.wall, slot.s + w / 2, item === 'seats' ? 0.3 : 0.3)
    b.at(c[0], 0, c[1], yawFor(slot.wall.n), () => {
      if (item === 'plant') plant(b, 1.3)
      else if (item === 'tallPlant') plant(b, 2.6)
      else {
        // upholstered bench: a black vinyl pad on a brushed steel frame
        b.box('upholstery', 0, 0.455, 0, w, 0.075, d, { color: '#232629', radius: 0.02 })
        b.box('satinSteel', 0, 0.405, 0, w - 0.12, 0.028, d - 0.1)
        for (const sx of [-1, 1]) {
          const x = sx * (w / 2 - 0.12)
          for (const sz of [-1, 1]) b.cyl('satinSteel', x, 0.205, sz * (d / 2 - 0.07), 0.014, 0.014, 0.39, { seg: 12 })
          b.box('satinSteel', x, 0.012, 0, 0.03, 0.024, d - 0.08)
        }
        b.shadow(0, 0, 0, w, d, 0.5)
      }
    })
    const box = stripRect(slot.wall, slot.s, slot.s + w, 0, d + 0.05)
    ctx.collider(box.minX, box.minZ, box.maxX, box.maxZ)
    return
  }
  const widths = { notice: 1.1, extinguisher: 0.35, eyewash: 0.6, ppe: 0.6, handwash: 0.6, clock: 0.35, o2: 0.2, pressure: 0.2, whiteboard: 1.2, leaflets: 0.3 }
  const w = widths[item]
  const slot = placeOnWall(p, w + 0.2, 0.3, 'mounted')
  if (!slot) return
  const c = wp(slot.wall, slot.s + (w + 0.2) / 2, 0)
  b.at(c[0], 0, c[1], yawFor(slot.wall.n), () => {
    switch (item) {
      case 'notice':
        b.box('frame', 0, 1.45, 0.015, 1.1, 0.8, 0.03, { color: '#9aa0a6' })
        b.decal('notice', 0, 1.45, 0.0305, 1.04, 0.74)
        return
      case 'extinguisher':
        b.box('gloss', 0, 0.95, 0.09, 0.32, 0.7, 0.18, { color: '#f2f2f0', radius: 0.01 })
        b.cyl('gloss', 0, 0.9, 0.12, 0.07, 0.07, 0.42, { color: '#c81e1e' })
        b.plane('glass', 0, 0.95, 0.182, 0.26, 0.6)
        return
      case 'eyewash':
        // combination emergency shower and eyewash on one supply pipe
        b.cyl('gloss', 0, 1.18, 0.06, 0.022, 0.022, 2.36, { color: '#d6dade', seg: 12 })
        b.box('gloss', 0, 2.36, 0.25, 0.04, 0.04, 0.42, { color: '#d6dade' })
        b.cyl('gloss', 0, 2.3, 0.46, 0.06, 0.15, 0.1, { color: '#16a34a', seg: 24 })
        // pull rod with its triangle handle
        b.cyl('steel', 0, 2.0, 0.33, 0.006, 0.006, 0.7)
        b.box('gloss', 0, 1.62, 0.33, 0.12, 0.08, 0.012, { color: '#16a34a' })
        // eyewash bowl and push paddle
        b.box('gloss', 0, 1.0, 0.18, 0.04, 0.04, 0.24, { color: '#d6dade' })
        b.cyl('gloss', 0, 1.02, 0.34, 0.15, 0.06, 0.08, { color: '#16a34a', seg: 24 })
        b.box('gloss', 0.17, 0.98, 0.3, 0.14, 0.03, 0.05, { color: '#16a34a' })
        b.box('gloss', 0.32, 2.0, 0.003, 0.2, 0.2, 0.004, { color: '#16a34a' })
        return
      case 'ppe':
        b.at(-0.15, 1.3, 0, 0, () => gloveDispenser(b))
        b.box('gloss', 0.2, 1.5, 0.05, 0.25, 0.35, 0.1, { color: '#f6f6f4', radius: 0.01 })
        return
      case 'handwash':
        b.box('steel', 0, 0.85, 0.22, 0.5, 0.06, 0.4)
        b.box('steel', 0, 0.65, 0.05, 0.3, 0.4, 0.06)
        b.cyl('chrome', 0, 1.0, 0.1, 0.012, 0.012, 0.25, { rx: Math.PI / 2 })
        b.at(0.35, 1.2, 0, 0, () => soapDispenser(b))
        return
      case 'clock':
        b.cyl('rubber', 0, 2.2, 0.02, 0.17, 0.17, 0.04, { rx: Math.PI / 2, color: '#1b1c1f', seg: 32 })
        b.roundDecal('clock', 0, 2.2, 0.0425, 0.3)
        return
      case 'o2':
        b.box('gloss', 0, 1.55, 0.025, 0.13, 0.17, 0.05, { color: '#eef0f2', radius: 0.008 })
        b.decal('o2', 0, 1.55, 0.0505, 0.12, 0.15)
        b.box('gloss', 0, 2.05, 0.03, 0.08, 0.08, 0.06, { color: '#f59e0b', radius: 0.02 })
        return
      case 'whiteboard':
        // magnetic whiteboard: aluminium frame, marker tray, a few magnets holding sheets
        b.box('frame', 0, 1.45, 0.012, 1.2, 0.85, 0.024, { color: '#c4c9cd', radius: 0.004 })
        b.box('laminate', 0, 1.45, 0.0245, 1.16, 0.81, 0.002, { color: '#f6f7f7' })
        b.box('frame', 0, 1.015, 0.035, 0.9, 0.018, 0.05, { color: '#c4c9cd' })
        for (const [x, c] of [[-0.3, '#1f2937'], [-0.24, '#b91c1c'], [-0.18, '#1d4ed8']] as const) b.cyl('plastic', x, 1.035, 0.035, 0.008, 0.008, 0.12, { rz: Math.PI / 2, color: c, seg: 8 })
        for (const [x, y, c] of [[-0.42, 1.68, '#dc2626'], [-0.05, 1.7, '#2563eb'], [0.33, 1.62, '#16a34a']] as const) {
          b.box('plastic', x, y - 0.12, 0.027, 0.2, 0.27, 0.002, { color: '#fdfdfb' })
          b.cyl('plastic', x, y, 0.031, 0.014, 0.014, 0.008, { rx: Math.PI / 2, color: c, seg: 14 })
        }
        return
      case 'leaflets':
        // clear acrylic leaflet holder
        b.box('frame', 0, 1.25, 0.01, 0.24, 0.32, 0.02, { color: '#d4d8dc' })
        for (let k = 0; k < 2; k++) {
          b.box('plastic', 0, 1.2 + k * 0.13, 0.03, 0.2, 0.15, 0.004, { color: k ? '#e8f0fe' : '#fef3c7' })
          b.box('glass', 0, 1.16 + k * 0.13, 0.045, 0.22, 0.1, 0.004)
        }
        return
      case 'pressure':
        b.box('frame', 0, 1.6, 0.012, 0.17, 0.17, 0.024, { color: '#9aa0a6' })
        b.cyl('plastic', 0, 1.6, 0.03, 0.07, 0.07, 0.03, { rx: Math.PI / 2, color: '#1f2937', seg: 28 })
        b.decal('pressure', 0, 1.6, 0.0455, 0.13, 0.13)
        return
    }
  })
}

/** Door plates on the corridor side and switches inside, for every generated room. */
function signage(ctx: LabCtx) {
  const kindOf = (z: ZoneId) => (z === 'hall' ? 'circulation' : ZONES[z]?.room?.kind ?? 'lab')
  for (const d of DOORS) {
    const t: Vec2 = [-d.normal[1], d.normal[0]]
    const half = doorWidth(d) / 2
    for (const [room, corridor, sign] of [
      [d.b, d.a, 1],
      [d.a, d.b, -1],
    ] as const) {
      const roomDef = ZONES[room]?.room
      if (!roomDef || HAND_BUILT.has(room)) continue
      if (CIRCULATION.has(kindOf(room)) && !CIRCULATION.has(kindOf(corridor))) continue
      if (CIRCULATION.has(kindOf(room))) continue
      // plate on the corridor face, latch side
      const latch = d.kind === 'single' || d.kind === undefined ? -d.hingeSide : 1
      const into: Vec2 = sign > 0 ? [-d.normal[0], -d.normal[1]] : d.normal
      const face = d.thickness / 2 + 0.004
      const px = d.center[0] + t[0] * latch * (half + 0.22) + into[0] * face
      const pz = d.center[1] + t[1] * latch * (half + 0.22) + into[1] * face
      const b = ctx.batch[corridor]
      b.at(px, 1.55, pz, yawFor(into), () => {
        b.box('plastic', 0, 0, -0.002, 0.29, 0.11, 0.006, { color: '#2b3440' })
        b.decal(`room-${roomDef.roomId}`, 0, 0, 0.0015, 0.28, 0.1)
      })
      // light switch just inside, latch side
      const inward: Vec2 = [-into[0], -into[1]]
      const sx = d.center[0] + t[0] * latch * (half + 0.18) + inward[0] * face
      const sz = d.center[1] + t[1] * latch * (half + 0.18) + inward[1] * face
      const rb = ctx.batch[room]
      if (polygonContains(ZONES[room].floor, sx + inward[0] * 0.05, sz + inward[1] * 0.05)) rb.at(sx, 1.2, sz, yawFor(inward), () => wallPlate(rb, 'switch'))
    }
  }
  // wayfinding over the hub's doorways
  const way: Record<string, 'way-life' | 'way-chem' | 'way-entrance'> = { 'd-hub-x01': 'way-life', 'd-hub-x02': 'way-chem', 'd-hub-c02': 'way-entrance' }
  for (const d of DOORS) {
    const name = way[d.id]
    if (!name) continue
    const into: Vec2 = d.a === 'C01' ? [-d.normal[0], -d.normal[1]] : d.normal
    const face = d.thickness / 2 + 0.006
    const b = ctx.batch.C01
    b.at(d.center[0] + into[0] * face, DOOR_H + 0.32, d.center[1] + into[1] * face, yawFor(into), () => {
      b.box('plastic', 0, 0, 0, 1.5, 0.21, 0.02, { color: '#2b3440' })
      b.decal(name, 0, 0, 0.011, 1.46, 0.19, 0, 'screen', 1.15)
    })
  }
}

/** Furnish every generated room. */
export function furnishFacility(ctx: LabCtx) {
  for (const id of Object.keys(ZONES)) {
    if (HAND_BUILT.has(id)) continue
    const zone = ZONES[id]
    const recipe = RECIPES[zone.room?.roomId ?? id]
    if (recipe) furnishRoom(ctx, zone, recipe)
  }
  signage(ctx)
}

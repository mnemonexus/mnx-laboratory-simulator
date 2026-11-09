// Modular lab casework: base cabinets (drawer stacks, doors, knee spaces,
// sink), epoxy worktops, upper cabinets (solid or glazed) with an under-cabinet
// LED strip, and the duplex outlets on the wall above each bench.
import * as THREE from 'three'
import { registerSocket, fixedFeed } from './powerRecords'
import { movableStorage } from './storage'
import type { LabCtx } from './context'
import type { Batch, FaceName } from './kit'
import { BENCH_TOP, UPPER_BOTTOM, UPPER_DEPTH, UPPER_TOP, benchLength, benchYaw, type BenchRun } from './layout'

// Neutral white fronts. Behind them a dark skin on the carcass face, so the
// 4 mm reveals read as crisp shadow lines like real casework.
const CARCASS = '#c9ccd0'
const FRONT = '#eff1f2'
const PLINTH = '#383b3f'
const GAP = 0.004
const FRONT_T = 0.019
/**
 * Under-cabinet strip: baked as spots this far apart, with this intensity per
 * metre. Warm white (about 3300 K), bright enough to wash the backsplash cream
 * under the uppers like the look target (2026-10-27).
 */
const STRIP_STEP = 0.3
const STRIP_I: [number, number, number] = [0.98, 0.78, 0.56]
/** Visible strip lens, warm: clips to white-gold but stays under the bloom threshold. */
const STRIP_GLOW = 2.8
const STRIP_GLOW_TINT: [number, number, number] = [1, 0.86, 0.66]

/** D-shaped bar pull on a front facing +z, centred at (x, y). */
export function barPull(b: Batch, x: number, y: number, z: number, vertical: boolean, len = 0.128) {
  const half = len / 2
  const off = 0.032
  if (vertical) {
    b.rod('steel', { x, y: y - half, z: z + off }, { x, y: y + half, z: z + off }, 0.007)
    for (const s of [-1, 1]) b.rod('steel', { x, y: y + s * (half - 0.012), z }, { x, y: y + s * (half - 0.012), z: z + off }, 0.0055)
  } else {
    b.rod('steel', { x: x - half, y, z: z + off }, { x: x + half, y, z: z + off }, 0.007)
    for (const s of [-1, 1]) b.rod('steel', { x: x + s * (half - 0.012), y, z }, { x: x + s * (half - 0.012), y, z: z + off }, 0.0055)
  }
}

function front(b: Batch, x0: number, x1: number, y0: number, y1: number, zFace: number) {
  b.span('laminate', x0 + GAP, y0 + GAP, zFace - FRONT_T, x1 - GAP, y1 - GAP, zFace, { color: FRONT, radius: 0.003, bake: ['+z'] })
}

function panel(b: Batch, x0: number, x1: number, y0: number, y1: number, z: number, drawer = false, right = false, longPull = false) {
  const width = x1 - x0, height = y1 - y0
  const pivot = new THREE.Vector3(drawer ? x0 : right ? x1 : x0, y0, z)
  const key = [drawer, right, longPull, width.toFixed(5), height.toFixed(5)].join(':')
  movableStorage(b, key, drawer ? 'drawer' : 'door', pivot, drawer ? 0.36 : right ? Math.PI / 2 : -Math.PI / 2, model => {
    front(model, x0, x1, y0, y1, z)
    barPull(model, drawer ? (x0+x1)/2 : right ? x0+0.045 : x1-0.045,
      drawer ? y1-0.05 : longPull ? y0+0.19 : y1-0.12, z, !drawer, longPull ? 0.26 : 0.128)
    if (drawer) {
      // Open-topped drawer box, revealed as it slides clear of the carcass.
      const depth = 0.40, bottom = y0 + 0.025, top = y1 - 0.035
      model.span('laminate', x0+0.025, bottom, z-depth, x1-0.025, bottom+0.012, z-FRONT_T, { color: '#dadddf' })
      for (const x of [x0+0.025, x1-0.037]) model.span('laminate', x, bottom, z-depth, x+0.012, top, z-FRONT_T, { color: '#dadddf' })
      model.span('laminate', x0+0.025, bottom, z-depth, x1-0.025, top, z-depth+0.012, { color: '#dadddf' })
    }
  })
}

function drawerStack(b: Batch, x0: number, x1: number, zFace: number) {
  let y = 0.108
  for (const height of [0.2, 0.2, 0.19, 0.162]) {
    panel(b, x0, x1, y, y+height, zFace, true)
    y += height
  }
}

function doorPair(b: Batch, x0: number, x1: number, zFace: number, single = false) {
  if (single) panel(b, x0, x1, 0.108, 0.862, zFace)
  else {
    const m = (x0+x1)/2
    panel(b, x0, m, 0.108, 0.862, zFace)
    panel(b, m, x1, 0.108, 0.862, zFace, false, true)
  }
}

function drawerOverDoor(b: Batch, x0: number, x1: number, zFace: number) {
  const split = 0.862-0.17
  panel(b, x0, x1, split, 0.862, zFace, true)
  panel(b, x0, x1, 0.108, split, zFace)
}

export // Baked like the room: the cabinet's occluder encloses these faces, so the
// bake keeps the interior and the reveals between fronts in shadow.
function carcass(b: Batch, x0: number, x1: number, y0: number, y1: number, depth: number) {
  const t = 0.019
  b.span('laminate', x0, y0, 0, x1, y0+t, depth, { color: CARCASS, bake: ['+y', '+z'] })
  b.span('laminate', x0, y1-t, 0, x1, y1, depth, { color: CARCASS, bake: ['-y', '+z'] })
  b.span('laminate', x0, y0, 0, x1, y1, 0.012, { color: CARCASS, bake: ['+z'] })
  for (const x of [x0, x1-t]) b.span('laminate', x, y0, 0, x+t, y1, depth, { color: CARCASS, bake: ['+x', '-x', '+z'] })
  b.span('laminate', x0+t, (y0+y1)/2, 0.012, x1-t, (y0+y1)/2+0.016, depth-0.012, { color: '#e4e7ea', bake: ['+y', '-y', '+z'] })
}

function sinkTop(ctx: LabCtx, b: Batch, x0: number, x1: number, D: number, topFace: string) {
  const bw = 0.5
  const bd = 0.36
  const cx = (x0 + x1) / 2
  const cz = D * 0.52
  const y0 = BENCH_TOP - 0.03
  const y1 = BENCH_TOP
  const top = (a: number, c: number, e: number, f: number) => b.span('worktop', a, y0, c, e, y1, f, { radius: 0.003, bake: ['+y', '+z'], topFace })
  top(x0, 0, cx - bw / 2, D + 0.02)
  top(cx + bw / 2, 0, x1, D + 0.02)
  top(cx - bw / 2, 0, cx + bw / 2, cz - bd / 2)
  top(cx - bw / 2, cz + bd / 2, cx + bw / 2, D + 0.02)
  // stainless basin
  const depth = 0.19
  b.span('steel', cx - bw / 2, y1 - depth, cz - bd / 2, cx + bw / 2, y1 - depth + 0.004, cz + bd / 2)
  b.span('steel', cx - bw / 2, y1 - depth, cz - bd / 2, cx - bw / 2 + 0.003, y1, cz + bd / 2)
  b.span('steel', cx + bw / 2 - 0.003, y1 - depth, cz - bd / 2, cx + bw / 2, y1, cz + bd / 2)
  b.span('steel', cx - bw / 2, y1 - depth, cz - bd / 2, cx + bw / 2, y1, cz - bd / 2 + 0.003)
  b.span('steel', cx - bw / 2, y1 - depth, cz + bd / 2 - 0.003, cx + bw / 2, y1, cz + bd / 2)
  b.cyl('chrome', cx, y1 - depth + 0.006, cz, 0.022, 0.022, 0.004, { seg: 16 })
  // rim
  b.span('steel', cx - bw / 2 - 0.015, y1, cz - bd / 2 - 0.015, cx + bw / 2 + 0.015, y1 + 0.004, cz - bd / 2)
  b.span('steel', cx - bw / 2 - 0.015, y1, cz + bd / 2, cx + bw / 2 + 0.015, y1 + 0.004, cz + bd / 2 + 0.015)
  b.span('steel', cx - bw / 2 - 0.015, y1, cz - bd / 2, cx - bw / 2, y1 + 0.004, cz + bd / 2)
  b.span('steel', cx + bw / 2, y1, cz - bd / 2, cx + bw / 2 + 0.015, y1 + 0.004, cz + bd / 2)
  // gooseneck faucet + wrist-blade handles
  const fz = cz - bd / 2 - 0.06
  b.cyl('chrome', cx, y1 + 0.012, fz, 0.028, 0.03, 0.024, { seg: 16 })
  const pts = [
    new THREE.Vector3(cx, y1 + 0.02, fz),
    new THREE.Vector3(cx, y1 + 0.26, fz),
    new THREE.Vector3(cx, y1 + 0.36, fz + 0.06),
    new THREE.Vector3(cx, y1 + 0.33, fz + 0.15),
    new THREE.Vector3(cx, y1 + 0.27, fz + 0.17),
  ]
  b.tube('chrome', pts, 0.011)
  for (const s of [-1, 1]) {
    b.cyl('chrome', cx + s * 0.13, y1 + 0.03, fz, 0.018, 0.022, 0.05, { seg: 12 })
    b.box('chrome', cx + s * 0.13, y1 + 0.062, fz + 0.04, 0.012, 0.012, 0.1, { radius: 0.005 })
  }
  ctx.occluderLocal(b.zone, x0, 0.1, 0, x1, BENCH_TOP - 0.2, D - 0.02)
}

/** Outlet plate on the wall (local frame faces +z). */
export function outlet(b: Batch, x: number, y: number, z = 0) {
  registerSocket(b,x,y,z)
  b.box('plastic',x,y,z+.004,.146,.086,.008,{color:'#f0f0eb',radius:.0025})
  for(const side of [-1,1]) {
    const px=x+side*.033
    // UK socket: vertical earth above the two horizontal shutter slots.
    b.box('rubber',px,y+.010,z+.0088,.004,.008,.001,{color:'#323839'})
    for(const pin of [-1,1]) b.box('rubber',px+pin*.009,y-.010,z+.0088,.007,.0034,.001,{color:'#323839'})
    b.box('plastic',px+side*.022,y+.014,z+.0095,.010,.021,.002,{color:'#fafaf6',radius:b.detail==='full'?.0006:undefined})
    b.box('plastic',px+side*.022,y+.020,z+.0106,.006,.002,.0005,{color:'#ad3b37'})
  }
  for(const side of [-1,1]) {
    b.cyl('steel',x+side*.0603,y,z+.0088,.0021,.0021,.001,{rx:Math.PI/2,seg:8})
    b.box('rubber',x+side*.0603,y,z+.0094,.0024,.0004,.0002,{color:'#61696c'})
  }
}

function uppers(ctx: LabCtx, b: Batch, a: number, c: number, glazed: boolean) {
  const D = UPPER_DEPTH
  const y0 = UPPER_BOTTOM
  const y1 = UPPER_TOP
  const zFace = D
  const len = c - a
  fixedFeed(b,'cabinet task light',new THREE.Vector3((a+c)/2,y0-.01,.17),new THREE.Vector3((a+c)/2,y0+.025,.17))
  if (glazed) {
    // open box with shelves behind glass doors
    b.span('laminate', a, y0, 0, c, y0 + 0.019, D - FRONT_T, { color: '#eceef0', bake: ['+y', '-y'] })
    b.span('laminate', a, y1 - 0.019, 0, c, y1, D - FRONT_T, { color: '#eceef0', bake: ['-y'] })
    b.span('laminate', a, y0, 0, c, y1, 0.012, { color: '#e4e7ea', bake: ['+z'] })
    const n = Math.max(1, Math.round(len / 0.72))
    for (let i = 0; i <= n; i++) {
      const x = a + (len * i) / n
      b.span('laminate', x - 0.009, y0, 0, x + 0.009, y1, D - FRONT_T, { color: '#eceef0' })
    }
    for (const y of [y0 + (y1 - y0) * 0.36, y0 + (y1 - y0) * 0.68]) b.span('laminate', a, y, 0.012, c, y + 0.016, D - FRONT_T - 0.01, { color: '#eceef0', bake: ['+y'] })
  } else {
    carcass(b, a, c, y0, y1, D-FRONT_T)
  }
  const doors = Math.max(2, Math.round(len / 0.46))
  const dw = len / doors
  for (let i = 0; i < doors; i++) {
    const x0 = a + i * dw
    const x1 = x0 + dw
    const pairLeft = i % 2 === 0 && i + 1 < doors
    const right = !pairLeft
    if (glazed) {
      movableStorage(b, `glass:${right}:${dw.toFixed(5)}:${(y1-y0).toFixed(5)}`, 'door', new THREE.Vector3(right ? x1 : x0, y0, zFace), right ? Math.PI/2 : -Math.PI/2, model => {
        const s = 0.06
        model.span('laminate', x0+GAP, y0+GAP, zFace-FRONT_T, x0+s, y1-GAP, zFace, { color: FRONT, bake: ['+z'] })
        model.span('laminate', x1-s, y0+GAP, zFace-FRONT_T, x1-GAP, y1-GAP, zFace, { color: FRONT, bake: ['+z'] })
        model.span('laminate', x0+s, y0+GAP, zFace-FRONT_T, x1-s, y0+s, zFace, { color: FRONT, bake: ['+z'] })
        model.span('laminate', x0+s, y1-s, zFace-FRONT_T, x1-s, y1-GAP, zFace, { color: FRONT, bake: ['+z'] })
        model.plane('glass', (x0+x1)/2, (y0+y1)/2, zFace-FRONT_T/2, dw-s*2, y1-y0-s*2)
        barPull(model, right ? x0+0.045 : x1-0.045, y0+0.19, zFace, true, 0.26)
      })
    } else panel(b, x0, x1, y0, y1, zFace, false, right, true)
  }
  // light rail + one continuous LED strip, baked as closely spaced spots so the
  // wall wash is even: brightest under the cabinet, fading towards the worktop
  b.span('laminate', a, y0 - 0.02, D - 0.03, c, y0, D, { color: '#eef0f2', bake: ['+z', '-y'] })
  b.span('frame', a + 0.02, y0 - 0.01, 0.15, c - 0.02, y0, 0.19, { color: '#d8d8d4', bake: ['-y'] })
  b.plane('glow', (a + c) / 2, y0 - 0.0105, 0.17, len - 0.05, 0.022, 0, new THREE.Color(STRIP_GLOW * STRIP_GLOW_TINT[0], STRIP_GLOW * STRIP_GLOW_TINT[1], STRIP_GLOW * STRIP_GLOW_TINT[2]), Math.PI / 2)
  const spots = Math.max(3, Math.round(len / STRIP_STEP))
  const I: [number, number, number] = [STRIP_I[0] * (len / spots), STRIP_I[1] * (len / spots), STRIP_I[2] * (len / spots)]
  // aimed mostly down: pools on the worktop, a softer fading wash on the wall
  const d = new THREE.Vector3(0, -1, -0.2).normalize().transformDirection(b.matrix)
  for (let i = 0; i < spots; i++) {
    const p = new THREE.Vector3(a + ((i + 0.5) * len) / spots, y0 - 0.02, 0.17).applyMatrix4(b.matrix)
    ctx.emit(b.zone, { kind: 'spot', p: [p.x, p.y, p.z], d: [d.x, d.y, d.z], exp: 2.5, I, range: 2.2 })
  }
  ctx.occluderLocal(b.zone, a, y0, 0, c, y1, D)
  ctx.occluderLocal(b.zone, a, y0 - 0.02, D - 0.03, c, y0, D)
  // slim uprights from worktop to uppers (frame-system casework)
  const posts = Math.max(1, Math.round(len / 1.5))
  for (let i = 0; i <= posts; i++) {
    const x = Math.min(c - 0.025, Math.max(a + 0.025, a + (len * i) / posts))
    b.span('laminate', x - 0.02, BENCH_TOP, 0, x + 0.02, y0 - 0.02, 0.045, { color: '#eef0f2', bake: ['+z', '-x', '+x'] })
  }
}

export function buildBench(ctx: LabCtx, run: BenchRun) {
  const b = ctx.batch[run.zone]
  const L = benchLength(run)
  const D = run.depth
  const zFace = D - 0.003
  b.at(run.start[0], 0, run.start[1], benchYaw(run), () => {
    // the whole run's top is one lightmap island, so its slabs and the pieces
    // round a sink shade as one continuous surface
    const top = b.sharedTop(run.ends?.left ? -0.03 : 0, run.ends?.right ? L + 0.03 : L, BENCH_TOP, 0, D + 0.02)
    let s = 0
    for (const m of run.modules) {
      const x0 = s
      const x1 = s + m.w
      const cabinet = m.kind !== 'knee' && m.kind !== 'open'
      if (cabinet) {
        carcass(b, x0+0.001, x1-0.001, 0.1, BENCH_TOP-0.03, zFace-FRONT_T-0.001)
        b.span('frame', x0, 0, 0.02, x1, 0.1, D - 0.075, { color: PLINTH, bake: ['+z'] })
        ctx.occluderLocal(run.zone, x0, 0.1, 0, x1, BENCH_TOP - 0.03, zFace)
        ctx.occluderLocal(run.zone, x0, 0, 0.02, x1, 0.1, D - 0.075)
      } else {
        // knee space: modesty panel and a shallow rear rail
        b.span('laminate', x0, 0.1, 0, x1, BENCH_TOP - 0.03, 0.018, { color: '#e9ebed', bake: ['+z'] })
        b.span('laminate', x0, BENCH_TOP - 0.1, 0, x1, BENCH_TOP - 0.03, 0.06, { color: '#e9ebed', bake: ['+z', '-y'] })
        ctx.occluderLocal(run.zone, x0, 0.1, 0, x1, BENCH_TOP - 0.03, 0.02)
      }
      if (m.kind === 'drawers4') drawerStack(b, x0, x1, zFace)
      else if (m.kind === 'door2') doorPair(b, x0, x1, zFace)
      else if (m.kind === 'door1') doorPair(b, x0, x1, zFace, true)
      else if (m.kind === 'drawerDoor') drawerOverDoor(b, x0, x1, zFace)
      // a corner blind is a fixed filler panel: never an open carcass
      else if (m.kind === 'blind') b.span('laminate', x0 + 0.002, 0.108, zFace - FRONT_T, x1 - 0.002, 0.862, zFace, { color: FRONT, bake: ['+z'] })
      else if (m.kind === 'sink') {
        doorPair(b, x0, x1, zFace)
        sinkTop(ctx, b, x0, x1, D, top)
      }
      s = x1
    }
    // finished end panels
    const endH = BENCH_TOP - 0.03
    if (run.ends?.left) b.span('laminate', -0.019, 0, 0, 0, endH, zFace, { color: FRONT, radius: 0.002, bake: ['-x', '+z'] })
    if (run.ends?.right) b.span('laminate', L, 0, 0, L + 0.019, endH, zFace, { color: FRONT, radius: 0.002, bake: ['+x', '+z'] })
    // worktop: one slab per stretch between sink modules (the sink cuts its own)
    let seg0: number | null = null
    let at = 0
    const slab = (a: number, c: number) => {
      const l0 = a === 0 && run.ends?.left ? -0.03 : a
      const l1 = c === L && run.ends?.right ? L + 0.03 : c
      const faces: FaceName[] = ['+y', '+z']
      if (a === 0 && run.ends?.left) faces.push('-x')
      if (c === L && run.ends?.right) faces.push('+x')
      b.span('worktop', l0, BENCH_TOP - 0.03, 0, l1, BENCH_TOP, D + 0.02, { radius: 0.004, bake: faces, topFace: top })
    }
    for (const m of run.modules) {
      if (m.kind === 'sink') {
        if (seg0 !== null) slab(seg0, at)
        seg0 = null
      } else if (seg0 === null) seg0 = at
      at += m.w
    }
    if (seg0 !== null) slab(seg0, L)
    // epoxy upstand along the wall (and the alcove sides)
    if (run.splash) {
      b.span('worktop', 0, BENCH_TOP, 0, L, BENCH_TOP + 0.1, 0.015, { bake: ['+z', '+y'] })
      b.span('worktop', 0, BENCH_TOP, 0, 0.015, BENCH_TOP + 0.1, D, { bake: ['+x'] })
      b.span('worktop', L - 0.015, BENCH_TOP, 0, L, BENCH_TOP + 0.1, D, { bake: ['-x'] })
    }
    ctx.occluderLocal(run.zone, 0, BENCH_TOP - 0.03, 0, L, BENCH_TOP, D + 0.02)
    ctx.colliderLocal(run.zone, -0.03, -0.05, L + 0.03, D + 0.03)
    if (run.uppers) uppers(ctx, b, run.uppers.from, run.uppers.to, Boolean(run.uppers.glazed))
  })
}

/** Duplex outlets along a bench backsplash at the given along-run positions. */
export function benchOutlets(ctx: LabCtx, run: BenchRun, positions: number[], y = 1.12) {
  const b = ctx.batch[run.zone]
  b.at(run.start[0], 0, run.start[1], benchYaw(run), () => {
    for (const s of positions) outlet(b, s, y)
  })
}

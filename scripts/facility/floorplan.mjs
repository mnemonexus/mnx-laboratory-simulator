#!/usr/bin/env node
// Facility master map: validator and floor-plan renderer.
//
// Reads  docs/master-plan/facility/facility.json
// Writes docs/master-plan/facility/floorplan.svg and floorplan.html
//
//   node scripts/facility/floorplan.mjs           validate, report, write outputs
//   node scripts/facility/floorplan.mjs --check   validate and report only (exit 1 on errors)
//
// Coordinates are metres in src/three/lab/layout.ts axes: +x east, +z south
// (−z north), origin at the centre of the Pre-PCR room. A room may be authored
// in a rotated frame (a hub-face frame) so sectors stay rectangular locally.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DIR = path.join(ROOT, 'docs/master-plan/facility')
const DATA = path.join(DIR, 'facility.json')
const CHECK_ONLY = process.argv.includes('--check')

const data = JSON.parse(fs.readFileSync(DATA, 'utf8'))
const errors = []
const warnings = []
const err = (m) => errors.push(m)
const warn = (m) => warnings.push(m)

// ── vector helpers ──────────────────────────────────────────────────────────
const add = (a, b) => [a[0] + b[0], a[1] + b[1]]
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]]
const mul = (a, s) => [a[0] * s, a[1] * s]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1]
const cross = (a, b) => a[0] * b[1] - a[1] * b[0]
const len = (a) => Math.hypot(a[0], a[1])
const norm = (a) => mul(a, 1 / len(a))
const dist = (a, b) => len(sub(a, b))
const deg = (r) => (r * 180) / Math.PI
const rad = (d) => (d * Math.PI) / 180
const r2 = (n) => Math.round(n * 100) / 100

function polyArea(p) {
  let s = 0
  for (let i = 0; i < p.length; i++) s += cross(p[i], p[(i + 1) % p.length])
  return Math.abs(s) / 2
}
function polyCentroid(p) {
  let a = 0, cx = 0, cz = 0
  for (let i = 0; i < p.length; i++) {
    const c = cross(p[i], p[(i + 1) % p.length])
    a += c
    cx += (p[i][0] + p[(i + 1) % p.length][0]) * c
    cz += (p[i][1] + p[(i + 1) % p.length][1]) * c
  }
  return [cx / (3 * a), cz / (3 * a)]
}
function ensureCCW(p) {
  let s = 0
  for (let i = 0; i < p.length; i++) s += cross(p[i], p[(i + 1) % p.length])
  return s < 0 ? [...p].reverse() : p
}
function pointInConvex(pt, poly) {
  let sign = 0
  for (let i = 0; i < poly.length; i++) {
    const c = cross(sub(poly[(i + 1) % poly.length], poly[i]), sub(pt, poly[i]))
    if (Math.abs(c) < 1e-9) continue
    const s = Math.sign(c)
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}
// Separating-axis gap between two convex polygons: > 0 means apart by at
// least that much, < 0 means they overlap by that much on every axis.
function satGap(p, q) {
  let best = -Infinity
  for (const poly of [p, q]) {
    for (let i = 0; i < poly.length; i++) {
      const e = sub(poly[(i + 1) % poly.length], poly[i])
      const ax = norm([-e[1], e[0]])
      let pMin = Infinity, pMax = -Infinity, qMin = Infinity, qMax = -Infinity
      for (const v of p) { const d = dot(v, ax); pMin = Math.min(pMin, d); pMax = Math.max(pMax, d) }
      for (const v of q) { const d = dot(v, ax); qMin = Math.min(qMin, d); qMax = Math.max(qMax, d) }
      best = Math.max(best, Math.max(qMin - pMax, pMin - qMax))
    }
  }
  return best
}

// ── frames ──────────────────────────────────────────────────────────────────
const hub = data.hub
const apothem = hub.acrossFlats / 2
const circumR = apothem / Math.cos(rad(30))
// Face normal angles, measured from +x towards +z (south). Pointy-top hexagon.
const FACE_ANGLE = { E: 0, SE: 60, SW: 120, W: 180, NW: 240, NE: 300 }
const faceMid = (f) => add(hub.center, mul([Math.cos(rad(FACE_ANGLE[f])), Math.sin(rad(FACE_ANGLE[f]))], apothem))
const hubVerts = [30, 90, 150, 210, 270, 330].map((a) => add(hub.center, mul([Math.cos(rad(a)), Math.sin(rad(a))], circumR)))

const frames = { world: { origin: [0, 0], angle: 0 } }
for (const f of Object.keys(FACE_ANGLE)) frames[f] = { origin: faceMid(f), angle: FACE_ANGLE[f] }
// A face frame: a = distance outward from the face, b = lateral (+b to the right
// when facing outward).
function toWorld(frameId, p) {
  const fr = frames[frameId]
  if (!fr) throw new Error(`unknown frame ${frameId}`)
  const ea = [Math.cos(rad(fr.angle)), Math.sin(rad(fr.angle))]
  const eb = [-ea[1], ea[0]]
  return add(fr.origin, add(mul(ea, p[0]), mul(eb, p[1])))
}
function frameDir(frameId, axis) {
  const fr = frames[frameId]
  const ea = [Math.cos(rad(fr.angle)), Math.sin(rad(fr.angle))]
  return axis === 'a' ? ea : [-ea[1], ea[0]]
}

// ── rooms ───────────────────────────────────────────────────────────────────
const rooms = new Map()
for (const r of data.rooms) {
  if (rooms.has(r.id)) err(`duplicate room id ${r.id}`)
  const frame = r.frame || 'world'
  const parts = []
  if (r.hex) parts.push(ensureCCW(hubVerts))
  for (const p of r.parts || []) {
    if (p.rect) {
      const [a0, b0, a1, b1] = p.rect
      if (a1 <= a0 || b1 <= b0) err(`${r.id}: degenerate rect ${JSON.stringify(p.rect)}`)
      parts.push(ensureCCW([[a0, b0], [a1, b0], [a1, b1], [a0, b1]].map((q) => toWorld(frame, q))))
    } else if (p.poly) {
      parts.push(ensureCCW(p.poly.map((q) => toWorld(p.frame || frame, q))))
    }
  }
  if (!parts.length) err(`${r.id}: no geometry`)
  const area = parts.reduce((s, p) => s + polyArea(p), 0)
  rooms.set(r.id, { ...r, frame, parts, area, edges: [] })
}

// Room boundary = part edges minus the stretches shared with another part of
// the same room, with collinear neighbours merged.
function boundary(room) {
  const segs = []
  for (const p of room.parts) for (let i = 0; i < p.length; i++) segs.push([p[i], p[(i + 1) % p.length]])
  const out = []
  for (const [a, b] of segs) {
    const d = norm(sub(b, a))
    const L = dist(a, b)
    let keep = [[0, L]]
    for (const [c, e] of segs) {
      if (c === a && e === b) continue
      const d2 = norm(sub(e, c))
      if (dot(d, d2) > -0.999) continue
      if (Math.abs(cross(d, sub(c, a))) > 1e-4) continue
      const t0 = dot(sub(e, a), d), t1 = dot(sub(c, a), d)
      const lo = Math.min(t0, t1), hi = Math.max(t0, t1)
      keep = keep.flatMap(([s, f]) => {
        if (hi <= s + 1e-6 || lo >= f - 1e-6) return [[s, f]]
        const res = []
        if (lo > s + 1e-6) res.push([s, lo])
        if (hi < f - 1e-6) res.push([hi, f])
        return res
      })
    }
    for (const [s, f] of keep) out.push([add(a, mul(d, s)), add(a, mul(d, f))])
  }
  // merge collinear, touching, same-direction segments
  let merged = true
  while (merged) {
    merged = false
    outer: for (let i = 0; i < out.length; i++) {
      for (let j = 0; j < out.length; j++) {
        if (i === j) continue
        const [a, b] = out[i], [c, e] = out[j]
        if (dist(b, c) < 1e-4 && Math.abs(cross(norm(sub(b, a)), norm(sub(e, c)))) < 1e-6 && dot(sub(b, a), sub(e, c)) > 0) {
          out[i] = [a, e]
          out.splice(j, 1)
          merged = true
          break outer
        }
      }
    }
  }
  return out
}
for (const room of rooms.values()) room.edges = boundary(room)

function pointInRoom(pt, room) {
  return room.parts.some((p) => pointInConvex(pt, p))
}

// ── overlap and wall checks ─────────────────────────────────────────────────
const roomList = [...rooms.values()]
// Two circulation spaces joined by an opening may share a zero-thickness edge.
const openPairs = new Set(data.doors.filter((d) => d.kind === 'opening').map((d) => [...d.rooms].sort().join('|')))
for (let i = 0; i < roomList.length; i++) {
  for (let j = i + 1; j < roomList.length; j++) {
    const A = roomList[i], B = roomList[j]
    let gap = Infinity
    for (const p of A.parts) for (const q of B.parts) gap = Math.min(gap, satGap(p, q))
    if (gap < -0.005) err(`overlap: ${A.id} × ${B.id} (${r2(-gap)} m)`)
    else if (gap < 0.12 && !openPairs.has([A.id, B.id].sort().join('|'))) warn(`thin wall: ${A.id} | ${B.id} only ${r2(gap)} m apart`)
  }
}

// ── room proportions ────────────────────────────────────────────────────────
// Narrowest side of each rectangular part, in metres (furniture is at game scale).
const MIN_WIDTH = { lab: 3.4, shared: 4.0, support: 3.0, foyer: 2.4, circulation: 1.8, hub: 0 }
for (const r of data.rooms) {
  if (r.nonPlayable || r.existing) continue
  for (const p of r.parts || []) {
    if (!p.rect) continue
    const w = Math.min(p.rect[2] - p.rect[0], p.rect[3] - p.rect[1])
    const min = MIN_WIDTH[r.kind] ?? 3.0
    if (w < min - 1e-6) err(`${r.id}: only ${r2(w)} m wide (${r.kind} rooms need ≥ ${min} m)`)
  }
}

// ── reserved hub faces: keep their expansion axis clear ─────────────────────
// A 2.8 m strip running 26 m straight out from each reserved face, so a future
// sector can always grow a corridor along its axis (no wing may creep across it).
const NECK = { length: 26, halfWidth: 1.4 }
const reservedNecks = []
for (const s of data.sectors) {
  if (s.status !== 'reserved') continue
  const poly = ensureCCW([[0, -NECK.halfWidth], [NECK.length, -NECK.halfWidth], [NECK.length, NECK.halfWidth], [0, NECK.halfWidth]].map((q) => toWorld(s.face, q)))
  reservedNecks.push({ sector: s, poly })
  for (const room of roomList) {
    if (room.hex) continue
    for (const p of room.parts) if (satGap(p, poly) < -0.005) err(`${room.id} intrudes into the reserved ${s.face} face's expansion axis`)
  }
}

// ── doors ───────────────────────────────────────────────────────────────────
function findWall(room, c, w) {
  let best = null
  for (const [a, b] of room.edges) {
    const d = norm(sub(b, a))
    const t = dot(sub(c, a), d)
    const L = dist(a, b)
    const off = Math.abs(cross(d, sub(c, a)))
    if (t < w / 2 - 0.05 || t > L - w / 2 + 0.05) continue
    if (off > 0.4) continue
    if (!best || off < best.off) best = { a, b, d, off, outward: [d[1], -d[0]] }
  }
  return best
}
const doors = []
for (const d of data.doors) {
  const [ia, ib] = d.rooms
  const A = rooms.get(ia), B = rooms.get(ib)
  if (!A || !B) { err(`door ${d.id}: unknown room ${!A ? ia : ib}`); continue }
  const c = toWorld(d.frame || 'world', d.at)
  const w = d.width ?? 1.2
  const wa = findWall(A, c, w), wb = findWall(B, c, w)
  if (!wa) { err(`door ${d.id}: not on a wall of ${ia}`); continue }
  if (!wb) { err(`door ${d.id}: not on a wall of ${ib}`); continue }
  // outward normals: CCW polygons in x/z-south coords → (d.z, −d.x) points outward
  if (dot(wa.outward, wb.outward) > -0.99) { err(`door ${d.id}: walls of ${ia} and ${ib} are not facing each other`); continue }
  if (w < 0.9 && d.kind !== 'hatch') err(`door ${d.id}: clear width ${w} m < 0.9 m`)
  const thick = wa.off + wb.off
  doors.push({ ...d, width: w, center: c, normal: wa.outward, tangent: wa.d, thick, A: ia, B: ib })
}
const hatches = doors.filter((d) => d.kind === 'hatch')
const walkDoors = doors.filter((d) => d.kind !== 'hatch')

// ── windows ─────────────────────────────────────────────────────────────────
const windows = []
for (const wdef of data.windows || []) {
  const room = rooms.get(wdef.room)
  if (!room) { err(`window ${wdef.id}: unknown room ${wdef.room}`); continue }
  const c = toWorld(wdef.frame || 'world', wdef.at)
  const wall = findWall(room, c, wdef.width)
  if (!wall) { err(`window ${wdef.id}: not on a wall of ${wdef.room}`); continue }
  const probe = add(c, mul(wall.outward, 0.45))
  const other = roomList.find((r) => r !== room && pointInRoom(probe, r))
  if (wdef.kind === 'exterior' && other) err(`window ${wdef.id}: exterior window looks into ${other.id}`)
  if (wdef.kind === 'observation' && !other) warn(`window ${wdef.id}: observation window looks outside`)
  windows.push({ ...wdef, center: c, normal: wall.outward, tangent: wall.d })
}

// ── exterior doors (building entrance, deliveries, escape) ──────────────────
const exits = []
for (const x of data.exits || []) {
  const room = rooms.get(x.room)
  if (!room) { err(`exit ${x.id}: unknown room ${x.room}`); continue }
  const c = toWorld(x.frame || 'world', x.at)
  const w = x.width ?? 1.2
  const wall = findWall(room, c, w)
  if (!wall) { err(`exit ${x.id}: not on a wall of ${x.room}`); continue }
  const probe = add(c, mul(wall.outward, 0.45))
  const other = roomList.find((r) => r !== room && pointInRoom(probe, r))
  if (other) err(`exit ${x.id}: opens into ${other.id}, not outside`)
  exits.push({ ...x, width: w, center: c, normal: wall.outward, tangent: wall.d })
}

// ── graph checks ────────────────────────────────────────────────────────────
const CIRC = new Set(['hub', 'circulation', 'foyer'])
const HUB_ID = data.rooms.find((r) => r.hex).id
function neighbours(id, allowed, respectOneWay = true) {
  const out = []
  for (const d of walkDoors) {
    if (d.A === id && allowed(d.B)) out.push({ to: d.B, door: d })
    if (d.B === id && allowed(d.A) && !(respectOneWay && d.oneWay)) out.push({ to: d.A, door: d })
  }
  return out
}
function reach(start, allowed, through = () => true) {
  const seen = new Set([start])
  const q = [start]
  while (q.length) {
    const id = q.shift()
    if (id !== start && !through(id)) continue
    for (const { to } of neighbours(id, allowed)) if (!seen.has(to)) { seen.add(to); q.push(to) }
  }
  return seen
}

const PACKS = data.packs.map((p) => p.id)
const installedFor = (combo) => new Set(roomList.filter((r) => !r.nonPlayable && (r.packs.includes('base') || r.packs.some((p) => combo.includes(p)))).map((r) => r.id))
const combos = []
for (let m = 1; m < 1 << PACKS.length; m++) combos.push(PACKS.filter((_, i) => m & (1 << i)))
const packReport = []
for (const combo of combos) {
  const inst = installedFor(combo)
  const seen = reach(HUB_ID, (id) => inst.has(id))
  const missing = [...inst].filter((id) => !seen.has(id))
  if (missing.length) err(`packs [${combo.join(', ')}]: unreachable from the hub: ${missing.join(', ')}`)
  const sealed = walkDoors.filter((d) => inst.has(d.A) !== inst.has(d.B)).length
  const area = [...inst].reduce((s, id) => s + rooms.get(id).area, 0)
  packReport.push({ combo, rooms: inst.size, area, sealed })
}
for (const r of roomList) {
  for (const p of r.packs) if (p !== 'base' && !PACKS.includes(p)) err(`${r.id}: unknown pack ${p}`)
  if (r.parent && !rooms.has(r.parent)) err(`${r.id}: unknown parent ${r.parent}`)
}
// every room reachable at all
{
  const seen = reach(HUB_ID, () => true)
  for (const r of roomList) if (!seen.has(r.id) && !r.nonPlayable) err(`${r.id}: unreachable from the hub`)
}
// neutral access: shared rooms are reachable through circulation only
for (const r of roomList.filter((x) => x.access === 'neutral')) {
  const seen = reach(HUB_ID, () => true, (id) => CIRC.has(rooms.get(id).kind))
  if (!seen.has(r.id)) err(`${r.id}: shared room is not reachable through circulation alone`)
}
// rules
//   noRouteBack: no route from any `from` room to any `to` room that avoids
//                circulation (respecting one-way doors)
//   onlyVia:     every door of `room` leads to one of the `via` rooms
for (const rule of data.rules || []) {
  if (rule.type === 'onlyVia') {
    if (!rooms.has(rule.room)) { err(`rule "${rule.id}": unknown room ${rule.room}`); continue }
    for (const d of walkDoors) {
      const other = d.A === rule.room ? d.B : d.B === rule.room ? d.A : null
      if (other && !rule.via.includes(other)) err(`rule "${rule.id}": ${rule.room} has a door to ${other}`)
    }
    continue
  }
  for (const f of rule.from) {
    const seen = reach(f, (id) => !CIRC.has(rooms.get(id).kind))
    for (const t of rule.to) if (seen.has(t)) err(`rule "${rule.id}": ${f} reaches ${t} without passing through circulation`)
  }
}

// ── walking distances ───────────────────────────────────────────────────────
// Nodes are door centres plus the hub centre; walking inside a room between two
// of its doors costs the straight-line distance.
const nodes = [{ id: 'HUB', p: hub.center, rooms: [HUB_ID] }, ...walkDoors.map((d) => ({ id: d.id, p: d.center, rooms: [d.A, d.B], door: d }))]
function dijkstra(srcIdx) {
  const D = nodes.map(() => Infinity)
  D[srcIdx] = 0
  const done = new Set()
  while (done.size < nodes.length) {
    let u = -1
    for (let i = 0; i < nodes.length; i++) if (!done.has(i) && (u < 0 || D[i] < D[u])) u = i
    if (u < 0 || D[u] === Infinity) break
    done.add(u)
    for (let v = 0; v < nodes.length; v++) {
      if (done.has(v)) continue
      const shared = nodes[u].rooms.find((r) => nodes[v].rooms.includes(r))
      if (!shared) continue
      const nd = D[u] + dist(nodes[u].p, nodes[v].p)
      if (nd < D[v]) D[v] = nd
    }
  }
  return D
}
const fromHub = dijkstra(0)
const roomDist = new Map()
for (const r of roomList) {
  let best = Infinity
  nodes.forEach((n, i) => { if (n.rooms.includes(r.id)) best = Math.min(best, fromHub[i]) })
  roomDist.set(r.id, r.id === HUB_ID ? 0 : best)
}
const MAX_FROM_HUB = data.targets?.maxFromHub ?? 35
for (const r of roomList) {
  if (r.nonPlayable) continue
  if (roomDist.get(r.id) > MAX_FROM_HUB) err(`${r.id}: ${r2(roomDist.get(r.id))} m from the hub centre (target ≤ ${MAX_FROM_HUB} m)`)
}
const allPairs = new Map()
function pathBetween(a, b) {
  let best = Infinity
  nodes.forEach((n, i) => {
    if (!n.rooms.includes(a)) return
    if (!allPairs.has(i)) allPairs.set(i, dijkstra(i))
    const D = allPairs.get(i)
    nodes.forEach((m, j) => { if (m.rooms.includes(b)) best = Math.min(best, D[j]) })
  })
  return a === b ? 0 : best
}
const adjacencyReport = []
for (const adj of data.adjacency || []) {
  const [a, b] = adj.rooms
  if (!rooms.has(a) || !rooms.has(b)) { err(`adjacency ${a}–${b}: unknown room`); continue }
  const d = pathBetween(a, b)
  adjacencyReport.push({ ...adj, d })
  if (adj.max && d > adj.max) err(`adjacency ${a}–${b}: ${r2(d)} m door to door (target ≤ ${adj.max} m)`)
}
const workflowReport = []
for (const wf of data.workflows || []) {
  let total = 0
  for (let i = 0; i + 1 < wf.route.length; i++) {
    const [a, b] = [wf.route[i], wf.route[i + 1]]
    if (!rooms.has(a) || !rooms.has(b)) { err(`workflow ${wf.id}: unknown room ${!rooms.has(a) ? a : b}`); continue }
    total += pathBetween(a, b)
  }
  workflowReport.push({ ...wf, metres: total, cost: total * (wf.frequency ?? 1) })
}

// ── occupancy (share of the 360° around the hub covered by built rooms) ─────
function angleOf(p) {
  const v = sub(p, hub.center)
  return (deg(Math.atan2(v[1], v[0])) + 360) % 360
}
const intervals = []
for (const r of roomList) {
  if (r.hex || r.excludeFromOccupancy) continue
  for (const part of r.parts) {
    const angs = part.map(angleOf).sort((x, y) => x - y)
    // smallest arc containing all vertices
    let bestGap = -1, gi = 0
    for (let i = 0; i < angs.length; i++) {
      const g = (angs[(i + 1) % angs.length] - angs[i] + 360) % 360
      if (g > bestGap) { bestGap = g; gi = i }
    }
    const start = angs[(gi + 1) % angs.length]
    const span = 360 - bestGap
    intervals.push([start, start + span])
  }
}
function unionLen(iv) {
  const flat = []
  for (const [s, e] of iv) {
    if (e <= 360) flat.push([s, e])
    else { flat.push([s, 360]); flat.push([0, e - 360]) }
  }
  flat.sort((a, b) => a[0] - b[0])
  let total = 0, cs = null, ce = null
  for (const [s, e] of flat) {
    if (cs === null) { cs = s; ce = e; continue }
    if (s <= ce) ce = Math.max(ce, e)
    else { total += ce - cs; cs = s; ce = e }
  }
  if (cs !== null) total += ce - cs
  return total
}
const occupancy = unionLen(intervals) / 360
const MAX_OCC = data.targets?.maxOccupancy ?? 0.5
if (occupancy > MAX_OCC) err(`occupancy ${Math.round(occupancy * 100)}% exceeds ${Math.round(MAX_OCC * 100)}%`)

// ── coverage and legacy homes ───────────────────────────────────────────────
for (const row of data.coverage || []) {
  if (!row.rooms?.length) err(`coverage "${row.field}": no rooms`)
  for (const id of row.rooms || []) if (!rooms.has(id)) err(`coverage "${row.field}": unknown room ${id}`)
}
for (const [listName, list] of Object.entries(data.legacy || {})) {
  for (const item of list) {
    if (!item.home?.length) err(`${listName} "${item.item}": no home`)
    for (const id of item.home || []) if (!rooms.has(id)) err(`${listName} "${item.item}": unknown room ${id}`)
  }
}

// ── report ──────────────────────────────────────────────────────────────────
const byGroup = new Map()
for (const r of roomList) byGroup.set(r.group, (byGroup.get(r.group) || 0) + r.area)
const total = roomList.reduce((s, r) => s + r.area, 0)
const far = [...roomList].filter((r) => !r.nonPlayable).sort((a, b) => roomDist.get(b.id) - roomDist.get(a.id)).slice(0, 5)

console.log(`Facility: ${roomList.length} rooms, ${walkDoors.length} doors, ${hatches.length} hatches, ${windows.length} windows, ${exits.length} exterior doors`)
console.log(`Floor area (room interiors): ${Math.round(total)} m²  ·  ${[...byGroup].map(([g, a]) => `${g} ${Math.round(a)}`).join(' · ')}`)
console.log(`Occupancy around the hub: ${Math.round(occupancy * 100)}% (target ≤ ${Math.round(MAX_OCC * 100)}%)`)
console.log(`Farthest rooms from the hub centre: ${far.map((r) => `${r.id} ${r2(roomDist.get(r.id))} m`).join(', ')}`)
console.log('Add-on combinations:')
for (const p of packReport) console.log(`  ${p.combo.join(' + ').padEnd(52)} ${String(p.rooms).padStart(3)} rooms  ${String(Math.round(p.area)).padStart(5)} m²  ${p.sealed} doors sealed as walls`)
if (adjacencyReport.length) {
  console.log('Priority adjacencies (door to door):')
  for (const a of adjacencyReport) console.log(`  ${a.rooms.join(' – ').padEnd(12)} ${String(r2(a.d)).padStart(6)} m  (≤ ${a.max})  ${a.why || ''}`)
}
if (workflowReport.length) {
  console.log('Example workflows:')
  for (const w of workflowReport) console.log(`  ${w.name.padEnd(46)} ${String(r2(w.metres)).padStart(6)} m  × ${w.frequency ?? 1}`)
  console.log(`  Travel cost Σ f·d = ${Math.round(workflowReport.reduce((s, w) => s + w.cost, 0))}`)
}
for (const w of warnings) console.log(`warning: ${w}`)
for (const e of errors) console.log(`ERROR: ${e}`)
console.log(errors.length ? `${errors.length} error(s)` : 'All checks passed.')

if (CHECK_ONLY) process.exit(errors.length ? 1 : 0)

// ── render ──────────────────────────────────────────────────────────────────
const S = 22 // px per metre
const WALL = 0.18
const GROUP = data.groups
let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
for (const r of roomList) for (const p of r.parts) for (const v of p) { minX = Math.min(minX, v[0]); maxX = Math.max(maxX, v[0]); minZ = Math.min(minZ, v[1]); maxZ = Math.max(maxZ, v[1]) }
const sectorReach = 15
for (const s of data.sectors) {
  if (s.status !== 'reserved') continue
  const tip = toWorld(s.face, [sectorReach, 0])
  minX = Math.min(minX, tip[0]); maxX = Math.max(maxX, tip[0]); minZ = Math.min(minZ, tip[1]); maxZ = Math.max(maxZ, tip[1])
}
const M = 3, HEAD = 2.6, FOOT = 3.2
const W = (maxX - minX + 2 * M) * S
const H = (maxZ - minZ + 2 * M + HEAD + FOOT) * S
const X = (x) => r2((x - minX + M) * S)
const Y = (z) => r2((z - minZ + M + HEAD) * S)
const pts = (poly) => poly.map((v) => `${X(v[0])},${Y(v[1])}`).join(' ')
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const svg = []
svg.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r2(W)} ${r2(H)}" width="${r2(W)}" height="${r2(H)}" font-family="Inter, 'Segoe UI', system-ui, sans-serif" class="fp">`)
svg.push(`<defs><pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" class="fp-hatch"/></pattern>
<marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="fp-arrowhead"/></marker></defs>`)
svg.push(`<rect class="fp-bg" x="0" y="0" width="${r2(W)}" height="${r2(H)}"/>`)

// reserved sectors: a wedge from the hub face outward
svg.push('<g class="fp-reserved">')
for (const s of data.sectors) {
  if (s.status !== 'reserved') continue
  const half = apothem * Math.tan(rad(30))
  const near = [toWorld(s.face, [0.3, -half]), toWorld(s.face, [0.3, half])]
  const far = [toWorld(s.face, [sectorReach, half + sectorReach * Math.tan(rad(30))]), toWorld(s.face, [sectorReach, -half - sectorReach * Math.tan(rad(30))])]
  svg.push(`<polygon points="${pts([...near, ...far])}" class="fp-sector"/>`)
  const lp = toWorld(s.face, [sectorReach * 0.8, 0])
  svg.push(`<text x="${X(lp[0])}" y="${Y(lp[1]) - 6}" class="fp-sector-label" text-anchor="middle">RESERVED · ${esc(s.face)}</text>`)
  svg.push(`<text x="${X(lp[0])}" y="${Y(lp[1]) + 10}" class="fp-sector-note" text-anchor="middle">${esc(s.label)}</text>`)
}
svg.push('</g>')

// walls (thick strokes), then floors on top
svg.push('<g class="fp-walls">')
for (const r of roomList) {
  svg.push(`<g data-room="${r.id}">${r.parts.map((p) => `<polygon points="${pts(p)}"/>`).join('')}</g>`)
}
svg.push('</g>')
svg.push('<g class="fp-floors">')
for (const r of roomList) {
  svg.push(`<g data-room="${r.id}" data-group="${r.group}" data-packs="${r.packs.join(' ')}" data-phase="${r.phase ?? ''}" class="fp-room fp-g-${r.group}${r.existing ? ' fp-existing' : ''}${r.nonPlayable ? ' fp-service' : ''}">${r.parts.map((p) => `<polygon points="${pts(p)}"/>`).join('')}</g>`)
}
svg.push('</g>')

// existing-build outline
svg.push('<g class="fp-existing-outline">')
for (const r of roomList.filter((x) => x.existing)) for (const [a, b] of r.edges) svg.push(`<line x1="${X(a[0])}" y1="${Y(a[1])}" x2="${X(b[0])}" y2="${Y(b[1])}"/>`)
svg.push('</g>')

// windows
svg.push('<g class="fp-windows">')
for (const w of windows) {
  const t = w.tangent, n = w.normal
  const c = add(w.center, mul(n, WALL / 2))
  const q = [add(add(c, mul(t, -w.width / 2)), mul(n, -WALL / 2)), add(add(c, mul(t, w.width / 2)), mul(n, -WALL / 2)), add(add(c, mul(t, w.width / 2)), mul(n, WALL / 2)), add(add(c, mul(t, -w.width / 2)), mul(n, WALL / 2))]
  svg.push(`<g data-room="${w.room}" class="fp-window fp-window-${w.kind}"><polygon points="${pts(q)}"/><line x1="${X(add(c, mul(t, -w.width / 2))[0])}" y1="${Y(add(c, mul(t, -w.width / 2))[1])}" x2="${X(add(c, mul(t, w.width / 2))[0])}" y2="${Y(add(c, mul(t, w.width / 2))[1])}"/></g>`)
}
svg.push('</g>')

// doors: opening through the wall, leaf and swing
svg.push('<g class="fp-doors">')
for (const d of doors) {
  const t = d.tangent, n = d.normal
  const depth = d.thick / 2 + 0.04
  const half = d.width / 2
  const c0 = d.center
  const q = [add(add(c0, mul(t, -half)), mul(n, -depth)), add(add(c0, mul(t, half)), mul(n, -depth)), add(add(c0, mul(t, half)), mul(n, depth)), add(add(c0, mul(t, -half)), mul(n, depth))]
  const cls = `fp-door fp-door-${d.kind || 'single'}${d.oneWay ? ' fp-oneway' : ''}`
  let extra = ''
  if (d.kind === 'hatch') {
    extra = `<line class="fp-hatchline" x1="${X(add(c0, mul(t, -half))[0])}" y1="${Y(add(c0, mul(t, -half))[1])}" x2="${X(add(c0, mul(t, half))[0])}" y2="${Y(add(c0, mul(t, half))[1])}"/>`
  } else if (d.kind !== 'opening') {
    const into = d.swing === d.A ? -1 : 1 // side the leaf swings into, along n (n points A→B)
    const leaves = d.kind === 'double' || d.kind === 'airlock' ? [[-1, half / 1], [1, half / 1]] : [[d.hinge === 'right' ? 1 : -1, d.width]]
    for (const [side, lw] of leaves) {
      const L = d.kind === 'double' || d.kind === 'airlock' ? half : lw
      const hingeP = add(c0, mul(t, side * half))
      const edge = add(c0, mul(t, side * half - side * L))
      const tipOpen = add(hingeP, mul(n, into * L))
      const wallFace = mul(n, into * d.thick / 2)
      const hp = add(hingeP, wallFace), ep = add(edge, wallFace), tp = add(tipOpen, wallFace)
      const sweep = cross(sub(ep, hp), sub(tp, hp)) > 0 ? 1 : 0
      extra += `<line class="fp-leaf" x1="${X(hp[0])}" y1="${Y(hp[1])}" x2="${X(tp[0])}" y2="${Y(tp[1])}"/>`
      extra += `<path class="fp-swing" d="M${X(ep[0])},${Y(ep[1])} A${r2(L * S)},${r2(L * S)} 0 0 ${sweep} ${X(tp[0])},${Y(tp[1])}"/>`
    }
  }
  if (d.oneWay) {
    const p0 = add(c0, mul(n, -0.75)), p1 = add(c0, mul(n, 0.75))
    extra += `<line class="fp-oneway-arrow" x1="${X(p0[0])}" y1="${Y(p0[1])}" x2="${X(p1[0])}" y2="${Y(p1[1])}" marker-end="url(#arrow)"/>`
  }
  svg.push(`<g class="${cls}" data-door="${d.id}" data-rooms="${d.A} ${d.B}"><polygon class="fp-gap" points="${pts(q)}"/>${extra}</g>`)
}
for (const x of exits) {
  const t = x.tangent, n = x.normal, half = x.width / 2
  const q = [add(add(x.center, mul(t, -half)), mul(n, -0.1)), add(add(x.center, mul(t, half)), mul(n, -0.1)), add(add(x.center, mul(t, half)), mul(n, 0.3)), add(add(x.center, mul(t, -half)), mul(n, 0.3))]
  const inward = x.kind === 'entrance'
  const p0 = add(x.center, mul(n, inward ? 1.6 : 0.2)), p1 = add(x.center, mul(n, inward ? 0.25 : 1.3))
  svg.push(`<g class="fp-exit fp-exit-${x.kind || 'exit'}" data-room="${x.room}"><polygon class="fp-gap" points="${pts(q)}"/><line class="fp-exit-arrow" x1="${X(p0[0])}" y1="${Y(p0[1])}" x2="${X(p1[0])}" y2="${Y(p1[1])}" marker-end="url(#arrow)"/></g>`)
}
svg.push('</g>')

// labels
const labelPos = new Map()
svg.push('<g class="fp-labels">')
for (const r of roomList) {
  let bestPart = r.parts[0]
  for (const p of r.parts) if (polyArea(p) > polyArea(bestPart)) bestPart = p
  const c = r.labelAt ? toWorld(r.frame, r.labelAt) : polyCentroid(bestPart)
  labelPos.set(r.id, [X(c[0]), Y(c[1])])
  const small = polyArea(bestPart) < 9 || r.kind === 'circulation'
  const lines = (r.short || r.name).split('|')
  const y0 = Y(c[1]) - (lines.length * (small ? 9 : 11)) / 2
  svg.push(`<g data-room="${r.id}" class="fp-label${small ? ' fp-label-small' : ''}"><text x="${X(c[0])}" y="${r2(y0)}" text-anchor="middle"><tspan class="fp-id" x="${X(c[0])}" dy="0">${esc(r.id)}</tspan>${lines.map((l) => `<tspan x="${X(c[0])}" dy="${small ? 9.5 : 11.5}">${esc(l)}</tspan>`).join('')}</text></g>`)
}
svg.push('</g>')

// title, north arrow, scale bar
const tx = 16, ty = 30
svg.push(`<text x="${tx}" y="${ty}" class="fp-title">${esc(data.title)}</text>`)
svg.push(`<text x="${tx}" y="${ty + 20}" class="fp-subtitle">${esc(data.subtitle)}</text>`)
const sbY = H - FOOT * S + 30, sbX = 16
svg.push(`<g class="fp-scale"><rect x="${sbX}" y="${sbY}" width="${5 * S}" height="5"/><rect x="${sbX + 5 * S}" y="${sbY}" width="${5 * S}" height="5" class="fp-scale-alt"/><text x="${sbX}" y="${sbY + 20}">0</text><text x="${sbX + 5 * S}" y="${sbY + 20}" text-anchor="middle">5</text><text x="${sbX + 10 * S}" y="${sbY + 20}" text-anchor="middle">10 m</text></g>`)
const nX = W - 40, nY = 40
svg.push(`<g class="fp-north"><path d="M${nX},${nY - 22} L${nX + 9},${nY + 8} L${nX},${nY + 2} L${nX - 9},${nY + 8} z"/><text x="${nX}" y="${nY + 24}" text-anchor="middle">N</text></g>`)
svg.push('</svg>')
const svgText = svg.join('\n')

const STYLE = `
.fp { --bg:#fbfbf9; --wall:#2b2f36; --ink:#1d2329; --muted:#5d6670; --sector:#94a3b8; --door-gap:#fbfbf9; --glass:#7cc4e4; --existing:#0f766e; --accent:#b45309; }
.fp-bg { fill: var(--bg); }
.fp-hatch { stroke: var(--sector); stroke-width: 1; opacity: .35; }
.fp-sector { fill: url(#hatch); stroke: var(--sector); stroke-dasharray: 4 4; stroke-width: 1; opacity: .8; }
.fp-sector-label { fill: var(--muted); font-size: 12px; font-weight: 650; letter-spacing: .08em; }
.fp-sector-note { fill: var(--muted); font-size: 11px; }
.fp-walls polygon { fill: var(--wall); stroke: var(--wall); stroke-width: ${2 * WALL * S}px; stroke-linejoin: miter; }
.fp-room { --fill: var(--fill-light); }
${Object.entries(GROUP).map(([g, v]) => `.fp-g-${g} { --fill-light: ${v.fill}; --fill-dark: ${v.fillDark}; }`).join('\n')}
.fp-room polygon { fill: var(--fill); stroke: var(--fill); stroke-width: 1.2px; stroke-linejoin: round; }
/* non-playable service space: building fabric, never walked */
.fp-service { --fill-light: #f1f1ee; --fill-dark: #2a2a28; }
.fp-service polygon { stroke: var(--sector); stroke-dasharray: 4 3; stroke-width: 1px; }
.fp-existing-outline line { stroke: var(--existing); stroke-width: 2.2px; stroke-dasharray: 6 3; }
.fp-gap { fill: var(--fill-gap, var(--door-gap)); }
.fp-leaf { stroke: var(--ink); stroke-width: 1.4px; }
.fp-swing { fill: none; stroke: var(--muted); stroke-width: .8px; stroke-dasharray: 3 2; }
.fp-door-opening .fp-gap { fill: var(--door-gap); }
.fp-hatchline { stroke: var(--accent); stroke-width: 3px; }
.fp-oneway-arrow { stroke: var(--accent); stroke-width: 1.6px; }
.fp-exit-arrow { stroke: var(--muted); stroke-width: 1.4px; }
.fp-exit-entrance .fp-exit-arrow { stroke: var(--ink); stroke-width: 2px; }
.fp-arrowhead { fill: var(--accent); }
.fp-window polygon { fill: var(--bg); }
.fp-window line { stroke: var(--glass); stroke-width: 3px; }
.fp-label text { fill: var(--ink); font-size: 10px; }
.fp-label .fp-id { font-weight: 700; font-size: 10.5px; }
.fp-label-small text { font-size: 8.5px; }
.fp-label-small .fp-id { font-size: 9px; }
.fp-title { fill: var(--ink); font-size: 20px; font-weight: 700; }
.fp-subtitle { fill: var(--muted); font-size: 12px; }
.fp-scale rect { fill: var(--ink); } .fp-scale .fp-scale-alt { fill: var(--muted); }
.fp-scale text, .fp-north text { fill: var(--ink); font-size: 11px; }
.fp-north path { fill: var(--ink); }
`

fs.writeFileSync(path.join(DIR, 'floorplan.svg'), svgText.replace('class="fp">', `class="fp"><style>${STYLE}</style>`))

// interactive viewer
const tplPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'viewer.template.html')
if (fs.existsSync(tplPath)) {
  const roomInfo = roomList.map((r) => ({
    id: r.id, name: r.name, group: r.group, kind: r.kind, entry: r.entry || null, parent: r.parent || null,
    shared: r.access === 'neutral', controlled: !!r.controlled, packs: r.packs, phase: r.phase ?? null,
    area: r2(r.area), fromHub: r2(roomDist.get(r.id)), lx: labelPos.get(r.id)[0], ly: labelPos.get(r.id)[1],
    purpose: r.purpose || '', fixed: r.fixed || [], stored: r.stored || '', samplePolicy: r.samplePolicy || '',
    hazards: r.hazards || [], utilities: r.utilities || [], existing: !!r.existing, notes: r.notes || '',
    doors: walkDoors.filter((d) => d.A === r.id || d.B === r.id).map((d) => (d.A === r.id ? d.B : d.A)),
  }))
  const wfInfo = workflowReport.map((w) => ({ id: w.id, name: w.name, route: w.route, metres: r2(w.metres) }))
  const payload = {
    title: data.title, subtitle: data.subtitle, packs: data.packs, groups: data.groups, phases: data.phases,
    sectors: data.sectors, rooms: roomInfo, workflows: wfInfo, occupancy: r2(occupancy), total: Math.round(total),
    installs: packReport.map((p) => ({ combo: p.combo, rooms: p.rooms, area: Math.round(p.area), sealed: p.sealed })),
  }
  // the in-game map (src/components/LabMap.tsx) shows the same plan and room cards
  const K0 = data.anchor.metresPerSceneUnit
  const ZONE_OF0 = { BI02: 'main', BI05: 'post', BI13: 'cold', X01: 'hall' }
  const mapData = {
    groups: data.groups, packs: data.packs, phases: data.phases, workflows: wfInfo, occupancy: r2(occupancy), total: Math.round(total),
    rooms: roomInfo.map((r) => ({ ...r, zone: ZONE_OF0[r.id] ?? r.id, short: (rooms.get(r.id).short || r.name).replace(/\|/g, ' ').replace(/- /g, ''), nonPlayable: !!rooms.get(r.id).nonPlayable })),
  }
  const inner = svgText.slice(svgText.indexOf('>') + 1, svgText.lastIndexOf('</svg>'))
  const mapGen = `// GENERATED by scripts/facility/floorplan.mjs from docs/master-plan/facility/facility.json.
// Do not edit by hand: change facility.json and run \`npm run facility\`.
// The floor plan drawn by the in-game map, plus the room cards. Plan units are
// SVG pixels: x = (metres − minX + margin) × scale, y = (metres − minZ + margin + head) × scale.

export interface MapRoom {
  id: string
  /** 3D zone id (the photo-matched rooms keep their own names) */
  zone: string
  name: string
  short: string
  group: string
  kind: string
  entry: string | null
  parent: string | null
  shared: boolean
  controlled: boolean
  packs: string[]
  phase: string | null
  area: number
  /** walking distance from the hub centre in metres (null for service space) */
  fromHub: number | null
  /** label position in plan units */
  lx: number
  ly: number
  purpose: string
  fixed: string[]
  stored: string
  samplePolicy: string
  hazards: string[]
  utilities: string[]
  existing: boolean
  nonPlayable: boolean
  notes: string
  doors: string[]
}

export const MAP_VIEW = ${JSON.stringify({ width: r2(W), height: r2(H), scale: S, minX: r2(minX), minZ: r2(minZ), margin: M, head: HEAD, metresPerUnit: K0 })}

export const MAP_DATA: {
  groups: Record<string, { name: string; fill: string; fillDark: string }>
  packs: { id: string; name: string }[]
  phases: { id: string; name: string; note: string }[]
  workflows: { id: string; name: string; route: string[]; metres: number }[]
  occupancy: number
  total: number
  rooms: MapRoom[]
} = ${JSON.stringify(mapData, null, 1)}

export const MAP_STYLE = ${JSON.stringify(STYLE)}

export const MAP_SVG = ${JSON.stringify(inner)}
`
  fs.writeFileSync(path.join(ROOT, 'src/three/lab/facilityMap.gen.ts'), mapGen)
  console.log('Wrote src/three/lab/facilityMap.gen.ts')
  const html = fs.readFileSync(tplPath, 'utf8')
    .replace('/*__STYLE__*/', () => STYLE)
    .replace('<!--__SVG__-->', () => svgText)
    .replace('/*__DATA__*/null', () => JSON.stringify(payload).replace(/</g, '\\u003c'))
  fs.writeFileSync(path.join(DIR, 'floorplan.html'), html)
}
console.log(`Wrote ${path.relative(ROOT, path.join(DIR, 'floorplan.svg'))}${fs.existsSync(tplPath) ? ' and floorplan.html' : ''}`)

// ── 3D zone data (src/three/lab/facility.gen.ts) ────────────────────────────
// Everything in scene units (metres ÷ metresPerSceneUnit). The photo-matched
// rooms keep their hand-tuned definitions in layout.ts; only their ids map here.
const K = data.anchor.metresPerSceneUnit
const u = (v) => Math.round((v / K) * 10000) / 10000
const ZONE_OF = { BI02: 'main', BI05: 'post', BI13: 'cold', X01: 'hall' }
const HAND_TUNED = new Set(['BI02', 'BI05', 'BI13'])
const HAND_DOORS = new Set(['entrance', 'post', 'cold'])
const HAND_WINDOWS = new Set(['main-east', 'cold-east', 'cold-obs'])
const zoneOf = (id) => ZONE_OF[id] ?? id

function outline(room) {
  const segs = room.edges.map(([a, b]) => [a, b])
  const loop = [segs[0][0]]
  let cur = segs.shift()
  while (segs.length) {
    const i = segs.findIndex(([a]) => dist(a, cur[1]) < 1e-3)
    if (i < 0) { err(`${room.id}: boundary does not close`); break }
    loop.push(cur[1])
    cur = segs.splice(i, 1)[0]
  }
  return loop
}

function insidePoly(poly, x, z) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}
const insideWithMargin = (poly, x, z, m) => [[0, 0], [m, 0], [-m, 0], [0, m], [0, -m]].every(([dx, dz]) => insidePoly(poly, x + dx, z + dz))

function troffersFor(room, polyU) {
  const out = []
  if (room.hex) {
    out.push({ x: u(hub.center[0]), z: u(hub.center[1]), w: 0.6, d: 0.6 })
    for (let i = 0; i < 6; i++) {
      const a = rad(30 + 60 * i)
      out.push({ x: u(hub.center[0]) + Math.cos(a) * 2.1, z: u(hub.center[1]) + Math.sin(a) * 2.1, w: 0.6, d: 0.6 })
    }
    return out.map((t) => ({ x: r2(t.x * 100) / 100, z: r2(t.z * 100) / 100, w: t.w, d: t.d }))
  }
  for (const part of room.parts) {
    const pu = part.map(([x, z]) => [u(x), u(z)])
    const xs = pu.map((p) => p[0]), zs = pu.map((p) => p[1])
    const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs)
    const W = maxX - minX, D = maxZ - minZ
    if (W * D < 2) continue
    const alongX = W >= D
    const narrow = Math.min(W, D) < 2.2
    const nx = narrow && !alongX ? 1 : Math.max(1, Math.round(W / 2.5))
    const nz = narrow && alongX ? 1 : Math.max(1, Math.round(D / 2.5))
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        const x = minX + (W * (i + 0.5)) / nx
        const z = minZ + (D * (j + 0.5)) / nz
        if (!insideWithMargin(polyU, x, z, 0.5)) continue
        out.push({ x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100, w: narrow && alongX ? 1.2 : 0.6, d: narrow && alongX ? 0.6 : 1.2 })
      }
    }
  }
  return out
}

const genRooms = []
for (const r of roomList) {
  if (HAND_TUNED.has(r.id) || r.nonPlayable) continue
  const loop = outline(r).map(([x, z]) => [u(x), u(z)])
  let big = r.parts[0]
  for (const p of r.parts) if (polyArea(p) > polyArea(big)) big = p
  const c = polyCentroid(big)
  const xs = loop.map((p) => p[0]), zs = loop.map((p) => p[1])
  const circulation = CIRC.has(r.kind)
  genRooms.push({
    id: zoneOf(r.id), roomId: r.id, name: r.name, short: (r.short || r.name).replace(/\|/g, ' ').replace(/- /g, ''), group: r.group, kind: r.kind,
    entry: r.entry ?? null, parent: r.parent ?? null, packs: r.packs, phase: r.phase ?? null, controlled: !!r.controlled,
    floor: loop,
    ceiling: r.hex ? 3.4 : circulation ? 2.7 : 2.75,
    probe: [u(c[0]), r.hex ? 1.7 : 1.45, u(c[1])],
    troffers: troffersFor(r, loop),
    gridOrigin: [Math.min(...xs), Math.min(...zs)],
    // light level relative to the labs: one for every room (owner, 2026-10-27)
    ambient: 1,
  })
}

function hingeFor(d) {
  const swing = rooms.get(d.swing ?? d.B)
  const w = findWall(swing, d.center, d.width)
  if (!w) return -1
  const s = dot(sub(d.center, w.a), w.d)
  const L = dist(w.a, w.b)
  const towardStart = s - d.width / 2 < L - s - d.width / 2
  const dir = towardStart ? mul(w.d, -1) : w.d
  const t = [-d.normal[1], d.normal[0]]
  return dot(dir, t) >= 0 ? 1 : -1
}

const playable = (id) => !rooms.get(id).nonPlayable
const genDoors = doors.filter((d) => d.kind !== 'hatch' && !HAND_DOORS.has(d.id) && playable(d.A) && playable(d.B)).map((d) => ({
  id: d.id,
  a: zoneOf(d.A),
  b: zoneOf(d.B),
  center: [u(d.center[0]), u(d.center[1])],
  normal: [Math.round(d.normal[0] * 1e6) / 1e6, Math.round(d.normal[1] * 1e6) / 1e6],
  width: u(d.width),
  thickness: Math.max(0.04, u(d.thick)),
  kind: d.kind || 'single',
  swingInto: zoneOf(d.swing ?? d.B),
  hingeSide: d.hinge === 'right' ? 1 : d.hinge === 'left' ? -1 : hingeFor(d),
  oneWay: !!d.oneWay,
  interlock: d.interlock ?? null,
}))

const genWindows = windows.filter((w) => !HAND_WINDOWS.has(w.id) && playable(w.room)).map((w) => {
  const hubWin = rooms.get(w.room).hex
  return {
    id: w.id, zone: zoneOf(w.room), center: [u(w.center[0]), u(w.center[1])], normal: [-w.normal[0], -w.normal[1]].map((v) => Math.round(v * 1e6) / 1e6),
    // sill and head are metres in facility.json when a window sets them (full-height glazing)
    width: u(w.width), sill: w.sill !== undefined ? u(w.sill) : hubWin ? 0.45 : 0.98, head: w.head !== undefined ? u(w.head) : hubWin ? 2.95 : 2.36, depth: 0.2, kind: w.kind,
  }
})

const genExits = exits.filter((x) => playable(x.room)).map((x) => ({
  id: x.id, zone: zoneOf(x.room), center: [u(x.center[0]), u(x.center[1])], normal: [-x.normal[0], -x.normal[1]].map((v) => Math.round(v * 1e6) / 1e6),
  width: u(x.width), kind: x.kind || 'exit',
}))

const gen = `// GENERATED by scripts/facility/floorplan.mjs from docs/master-plan/facility/facility.json.
// Do not edit by hand: change facility.json and run \`npm run facility\`.
// Scene units (metres ÷ ${K}); +x east, −z north, origin at the centre of the Pre-PCR room.
// The photo-matched rooms (main, post, cold) keep their hand-tuned zones in layout.ts.

export interface FacilityZone {
  id: string
  roomId: string
  name: string
  short: string
  group: 'hub' | 'circulation' | 'life' | 'core' | 'chem' | 'support'
  kind: string
  entry: string | null
  parent: string | null
  packs: string[]
  phase: string | null
  controlled: boolean
  floor: [number, number][]
  ceiling: number
  probe: [number, number, number]
  troffers: { x: number; z: number; w: number; d: number }[]
  gridOrigin: [number, number]
  ambient: number
}

export interface FacilityDoor {
  id: string
  a: string
  b: string
  center: [number, number]
  /** unit normal from zone a into zone b */
  normal: [number, number]
  /** clear opening width */
  width: number
  thickness: number
  kind: 'single' | 'double' | 'opening'
  swingInto: string
  hingeSide: 1 | -1
  /** only opens from zone a */
  oneWay: boolean
  /** doors sharing a group never stand open together (airlocks) */
  interlock: string | null
}

export interface FacilityWindow {
  id: string
  zone: string
  center: [number, number]
  /** inward normal */
  normal: [number, number]
  width: number
  sill: number
  head: number
  depth: number
  kind: 'exterior' | 'observation'
}

export interface FacilityExit {
  id: string
  zone: string
  center: [number, number]
  /** inward normal */
  normal: [number, number]
  width: number
  kind: 'entrance' | 'escape' | 'delivery' | 'exit'
}

/** Room id (facility.json) → zone id. */
export const ROOM_ZONE: Record<string, string> = ${JSON.stringify(Object.fromEntries(roomList.map((r) => [r.id, zoneOf(r.id)])))}

export const FACILITY_ZONES: FacilityZone[] = ${JSON.stringify(genRooms, null, 1)}

export const FACILITY_DOORS: FacilityDoor[] = ${JSON.stringify(genDoors, null, 1)}

export const FACILITY_WINDOWS: FacilityWindow[] = ${JSON.stringify(genWindows, null, 1)}

export const FACILITY_EXITS: FacilityExit[] = ${JSON.stringify(genExits, null, 1)}
`
fs.writeFileSync(path.join(ROOT, 'src/three/lab/facility.gen.ts'), gen)
console.log(`Wrote src/three/lab/facility.gen.ts (${genRooms.length} zones, ${genDoors.length} doors, ${genWindows.length} windows, ${genExits.length} exterior doors)`)

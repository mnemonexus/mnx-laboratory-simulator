// Walk collision, room detection and portal culling, all derived from the
// floor plan so they can never disagree with the geometry.
import * as THREE from 'three'
import { leafSegment, type DoorRuntime } from './architecture'
import type { Collider } from './context'
import { DOORS, DOOR_H, ZONES, ZONE_IDS, doorWidth, polygonContains, wallHoles, zoneWalls, type DoorDef, type ZoneId } from './layout'

type Seg = [number, number, number, number]

export const PLAYER_RADIUS = 0.22

/** How many open doorways deep the culler looks past the current room. */
const PORTAL_DEPTH = 4
/** How far away a closed door's vision panel still shows the room behind it. */
const CLOSED_DOOR_VIEW = 9

export class Nav {
  private walls: Seg[] = []
  private boxes: Collider[]
  private portals: { door: DoorDef; box: THREE.Box3 }[]
  /** portals touching each zone */
  private byZone = new Map<ZoneId, { door: DoorDef; box: THREE.Box3 }[]>()

  constructor(colliders: Collider[]) {
    this.boxes = colliders
    for (const id of ZONE_IDS) {
      for (const w of zoneWalls(ZONES[id])) {
        const gaps = wallHoles(w).filter((h) => h.kind === 'door')
        let s = 0
        const push = (s0: number, s1: number) => {
          if (s1 - s0 < 1e-3) return
          this.walls.push([w.a[0] + w.t[0] * s0, w.a[1] + w.t[1] * s0, w.a[0] + w.t[0] * s1, w.a[1] + w.t[1] * s1])
        }
        for (const g of gaps) {
          push(s, g.s0 + 0.05)
          s = g.s1 - 0.05
        }
        push(s, w.length)
      }
    }
    this.portals = DOORS.map((d) => {
      const t = [-d.normal[1], d.normal[0]]
      const half = doorWidth(d) / 2
      const box = new THREE.Box3()
      for (const a of [-1, 1]) {
        for (const n of [-1, 1]) {
          for (const y of [0, DOOR_H]) {
            box.expandByPoint(
              new THREE.Vector3(
                d.center[0] + t[0] * a * half + d.normal[0] * n * (d.thickness / 2 + 0.02),
                y,
                d.center[1] + t[1] * a * half + d.normal[1] * n * (d.thickness / 2 + 0.02),
              ),
            )
          }
        }
      }
      return { door: d, box }
    })
    for (const p of this.portals) {
      for (const z of [p.door.a, p.door.b]) {
        const list = this.byZone.get(z) ?? []
        list.push(p)
        this.byZone.set(z, list)
      }
    }
  }

  /** Zones reachable through one doorway, for bake and probe scheduling. */
  neighbours(zone: ZoneId): ZoneId[] {
    return (this.byZone.get(zone) ?? []).map((p) => (p.door.a === zone ? p.door.b : p.door.a))
  }

  zoneAt(x: number, z: number): ZoneId | null {
    for (const id of ZONE_IDS) if (polygonContains(ZONES[id].floor, x, z)) return id
    return null
  }

  isClear(p: THREE.Vector3, doors: DoorRuntime[], r = PLAYER_RADIUS) {
    if (!this.zoneAt(p.x, p.z)) return false
    if (this.walls.some(s => segmentDistanceSq(p, s) < r * r - 1e-6)) return false
    for (const d of doors) {
      if (d.openness > 0.001 && d.openness < 0.999) continue
      const [a, b] = leafSegment(d)
      if (segmentDistanceSq(p, [a[0], a[1], b[0], b[1]]) < (r * 0.8) ** 2 - 1e-6) return false
    }
    return !this.boxes.some(b => {
      const dx = p.x - THREE.MathUtils.clamp(p.x, b.minX, b.maxX)
      const dz = p.z - THREE.MathUtils.clamp(p.z, b.minZ, b.maxZ)
      return dx * dx + dz * dz < r * r - 1e-6
    })
  }

  /** Presets/standing may be occupied after furniture moves; use a nearby clear spot. */
  resolveSpawn(p: THREE.Vector3, doors: DoorRuntime[]) {
    const zone = this.zoneAt(p.x, p.z)
    const origin = p.clone()
    this.resolve(p, doors)
    if (this.zoneAt(p.x, p.z) === zone && this.isClear(p, doors)) return true
    for (let radius = 0.12; radius <= 1.8; radius += 0.12) {
      for (let i = 0; i < 24; i++) {
        const candidate = origin.clone().add(new THREE.Vector3(Math.sin(i * Math.PI / 12) * radius, 0, Math.cos(i * Math.PI / 12) * radius))
        if (this.zoneAt(candidate.x, candidate.z) !== zone || !this.isClear(candidate, doors)) continue
        p.copy(candidate)
        return true
      }
    }
    return false
  }

  /** Push a walking position out of walls, furniture and open door leaves. */
  resolve(p: THREE.Vector3, doors: DoorRuntime[], r = PLAYER_RADIUS, ignore?: Collider) {
    for (let iter = 0; iter < 3; iter++) {
      for (const s of this.walls) pushFromSegment(p, s, r)
      // only leaves at rest block: a swinging door never shoves the player
      for (const d of doors) {
        if (d.openness > 0.001 && d.openness < 0.999) continue
        const [a, b] = leafSegment(d)
        pushFromSegment(p, [a[0], a[1], b[0], b[1]], r * 0.8)
      }
      for (const b of this.boxes) {
        if (b === ignore) continue
        const cx = Math.min(Math.max(p.x, b.minX), b.maxX)
        const cz = Math.min(Math.max(p.z, b.minZ), b.maxZ)
        const dx = p.x - cx
        const dz = p.z - cz
        const d2 = dx * dx + dz * dz
        if (d2 >= r * r) continue
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2)
          p.x += (dx / d) * (r - d)
          p.z += (dz / d) * (r - d)
        } else {
          // centre inside the box: leave by the shallowest side
          const left = p.x - b.minX
          const right = b.maxX - p.x
          const back = p.z - b.minZ
          const front = b.maxZ - p.z
          const m = Math.min(left, right, back, front)
          if (m === left) p.x = b.minX - r
          else if (m === right) p.x = b.maxX + r
          else if (m === back) p.z = b.minZ - r
          else p.z = b.maxZ + r
        }
      }
    }
  }

  /** A short interaction must not carry the player through a wall or furniture. */
  canApproach(from: THREE.Vector3, to: THREE.Vector3, doors: DoorRuntime[], ignore: Collider) {
    const zone = this.zoneAt(from.x, from.z)
    const steps = Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) / 0.025)
    for (let i = 1; i <= steps; i++) {
      const p = from.clone().lerp(to, i / steps)
      if (this.zoneAt(p.x, p.z) !== zone) return false
      const resolved = p.clone()
      this.resolve(resolved, doors, 0.02, ignore)
      if (Math.hypot(p.x - resolved.x, p.z - resolved.z) > 0.001) return false
    }
    return true
  }

  private visible = new Set<ZoneId>()
  private openness = new Map<string, number>()
  private queueZone: ZoneId[] = []
  private queueDepth: number[] = []

  /**
   * Rooms a reflection probe in `zone` sees: the room itself and every room
   * joined to it by leafless openings, on through further openings, so a
   * continuous floor reflects the next room's lights. Rooms behind doors only
   * show through a small vision panel and are left out.
   */
  seenThroughOpenings(zone: ZoneId): Set<ZoneId> {
    const seen = new Set<ZoneId>([zone])
    const queue: [ZoneId, number][] = [[zone, 0]]
    for (let head = 0; head < queue.length; head++) {
      const [at, depth] = queue[head]
      if (depth >= PORTAL_DEPTH) continue
      for (const p of this.byZone.get(at) ?? NO_PORTALS) {
        const other = p.door.a === at ? p.door.b : p.door.a
        if (p.door.kind !== 'opening' || seen.has(other)) continue
        seen.add(other)
        queue.push([other, depth + 1])
      }
    }
    return seen
  }

  /**
   * Rooms worth rendering from this camera: a breadth-first walk through
   * doorways that are open (or leafless) and inside the view frustum.
   * Runs every frame, so it reuses its set and queues; the returned set is
   * overwritten by the next call.
   */
  visibleZones(camera: THREE.Camera, frustum: THREE.Frustum, current: ZoneId | null, doors: DoorRuntime[]): ReadonlySet<ZoneId> {
    const vis = this.visible
    vis.clear()
    if (!current) {
      for (const id of ZONE_IDS) vis.add(id)
      return vis
    }
    vis.add(current)
    const cam = camera.position
    const openness = this.openness
    openness.clear()
    for (const rt of doors) openness.set(rt.def.id, Math.max(openness.get(rt.def.id) ?? 0, rt.openness))
    const zones = this.queueZone, depths = this.queueDepth
    zones.length = 0
    depths.length = 0
    zones.push(current)
    depths.push(0)
    for (let head = 0; head < zones.length; head++) {
      const zone = zones[head], depth = depths[head]
      for (const p of this.byZone.get(zone) ?? NO_PORTALS) {
        const d = p.door
        const other = d.a === zone ? d.b : d.a
        if (vis.has(other)) continue
        const dist = Math.hypot(cam.x - d.center[0], cam.z - d.center[1])
        const open = d.kind === 'opening' || (openness.get(d.id) ?? 0) > 0.01
        // closed doors still show the next room through their clear vision panels
        const see = depth === 0 ? dist < 1.0 || (frustum.intersectsBox(p.box) && (open || dist < CLOSED_DOOR_VIEW)) : open && frustum.intersectsBox(p.box)
        if (!see) continue
        vis.add(other)
        if (open && depth + 1 < PORTAL_DEPTH) {
          zones.push(other)
          depths.push(depth + 1)
        }
      }
    }
    return vis
  }
}

const NO_PORTALS: { door: DoorDef; box: THREE.Box3 }[] = []

function segmentDistanceSq(p: THREE.Vector3, s: Seg) {
  const vx = s[2] - s[0], vz = s[3] - s[1]
  const length = vx * vx + vz * vz
  const t = length > 0 ? THREE.MathUtils.clamp(((p.x - s[0]) * vx + (p.z - s[1]) * vz) / length, 0, 1) : 0
  return (p.x - s[0] - t * vx) ** 2 + (p.z - s[1] - t * vz) ** 2
}

function pushFromSegment(p: THREE.Vector3, s: Seg, r: number) {
  const vx = s[2] - s[0]
  const vz = s[3] - s[1]
  const len2 = vx * vx + vz * vz
  let t = len2 > 0 ? ((p.x - s[0]) * vx + (p.z - s[1]) * vz) / len2 : 0
  t = Math.min(1, Math.max(0, t))
  const cx = s[0] + vx * t
  const cz = s[1] + vz * t
  const dx = p.x - cx
  const dz = p.z - cz
  const d2 = dx * dx + dz * dz
  if (d2 >= r * r || d2 < 1e-12) return
  const d = Math.sqrt(d2)
  p.x += (dx / d) * (r - d)
  p.z += (dz / d) * (r - d)
}

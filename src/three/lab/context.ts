// Shared state handed to every lab builder: one batch per room plus the
// lighting occluders, emitters and walk colliders that the geometry implies.
import * as THREE from 'three'
import type { BakeEmitter, V3 } from './bake'
import { Batch } from './kit'
import type { DecalAtlas } from './decals'
import type { RigidMeshBatch } from './rigidMeshBatch'
import { ZONE_IDS, type ZoneId } from './layout'

export interface Collider {
  minX: number
  minZ: number
  maxX: number
  maxZ: number
}

export interface Seat {
  zone: ZoneId
  position: THREE.Vector3
  yaw: number
  collider: Collider
  home: THREE.Vector3
  offset: number
  /** the chair's part in each of its room's chair batches (one per material) */
  instances: { mesh: RigidMeshBatch; index: number }[]
  /** its shadow from the room's lights, redrawn after a move */
  shadow?: { refresh(): void }
}

export class LabCtx {
  readonly detail: 'reduced' | 'full'
  readonly batch: Record<ZoneId, Batch>
  readonly occluders: Record<ZoneId, number[]>
  readonly emitters: Record<ZoneId, BakeEmitter[]>
  readonly colliders: Collider[] = []
  readonly seats: Seat[] = []

  constructor(detail: 'reduced' | 'full', atlas: DecalAtlas) {
    this.detail = detail
    const b = {} as Record<ZoneId, Batch>
    const o = {} as Record<ZoneId, number[]>
    const e = {} as Record<ZoneId, BakeEmitter[]>
    for (const z of ZONE_IDS) {
      b[z] = new Batch(z, detail, atlas)
      o[z] = []
      e[z] = []
    }
    this.batch = b
    this.occluders = o
    this.emitters = e
  }

  get full() {
    return this.detail === 'full'
  }

  /** Register a chair in the same transformed frame used to build its mesh. */
  seat(b: Batch) {
    const position = new THREE.Vector3().applyMatrix4(b.matrix)
    const forward = new THREE.Vector3(0, 0, 1).transformDirection(b.matrix)
    const collider = { minX: position.x - 0.24, minZ: position.z - 0.24, maxX: position.x + 0.24, maxZ: position.z + 0.24 }
    this.colliders.push(collider)
    this.seats.push({ zone: b.zone, position, home: position.clone(), offset: 0, instances: [], yaw: Math.atan2(forward.x, forward.z), collider })
  }

  /** World-space occluder box. */
  occluder(zone: ZoneId, min: V3, max: V3) {
    this.occluders[zone].push(min[0], min[1], min[2], max[0], max[1], max[2])
  }

  /** A round body (r, height h) as three boxes, an octagon in plan, so its baked shadow is round too. */
  occluderDisc(zone: ZoneId, cx: number, cz: number, r: number, h: number) {
    const a = r * Math.SQRT1_2
    const l = r * Math.cos(Math.PI / 8)
    const s = r * Math.sin(Math.PI / 8)
    this.occluder(zone, [cx - a, 0, cz - a], [cx + a, h, cz + a])
    this.occluder(zone, [cx - l, 0, cz - s], [cx + l, h, cz + s])
    this.occluder(zone, [cx - s, 0, cz - l], [cx + s, h, cz + l])
  }

  /** Occluder given in the batch's current local frame (converted to a world AABB). */
  occluderLocal(zone: ZoneId, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
    const box = localBox(this.batch[zone].matrix, x0, y0, z0, x1, y1, z1)
    this.occluder(zone, [box.min.x, box.min.y, box.min.z], [box.max.x, box.max.y, box.max.z])
  }

  collider(minX: number, minZ: number, maxX: number, maxZ: number) {
    this.colliders.push({ minX: Math.min(minX, maxX), minZ: Math.min(minZ, maxZ), maxX: Math.max(minX, maxX), maxZ: Math.max(minZ, maxZ) })
  }

  /** Walk collider from a box in a batch's local frame. */
  colliderLocal(zone: ZoneId, x0: number, z0: number, x1: number, z1: number) {
    const box = localBox(this.batch[zone].matrix, x0, 0, z0, x1, 1, z1)
    this.collider(box.min.x, box.min.z, box.max.x, box.max.z)
  }

  emit(zone: ZoneId, e: BakeEmitter) {
    this.emitters[zone].push(e)
  }
}

const corner = new THREE.Vector3()
export function localBox(m: THREE.Matrix4, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
  const box = new THREE.Box3()
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) box.expandByPoint(corner.set(x, y, z).applyMatrix4(m))
  return box
}

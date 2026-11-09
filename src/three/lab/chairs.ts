// Movable chairs: one rigid batch per room and material, alongside the static
// batches. Moving a chair rewrites only its own vertices.
import * as THREE from 'three'
import { Batch, type Palette } from './kit'
import type { LabCtx, Seat } from './context'
import type { DecalAtlas } from './decals'
import { ZONES, ZONE_IDS, type ZoneId } from './layout'
import { buildChairModel } from './props'
import { RigidMeshBatch } from './rigidMeshBatch'
import { CHAIR_SHADOW_RES, CHAIR_SHADOW_SIZE, chairShadow } from './chairShadow'
import { CONTACT_SHADOW } from './kit'
import type { Nav } from './nav'
import type { DoorRuntime } from './architecture'

export type ChairDirection = 'in' | 'out'
const STEP = 0.04
const LIMIT = 0.48

export function buildChairInstances(ctx: LabCtx, palette: Palette, atlas: DecalAtlas, zones: Record<ZoneId, THREE.Group>) {
  const batch = new Batch('main', ctx.detail, atlas)
  buildChairModel(batch)
  const model = batch.build(palette, 'chair').group
  for (const zone of ZONE_IDS) {
    const seats = ctx.seats.filter((s) => s.zone === zone)
    if (!seats.length) continue
    for (const source of model.children as THREE.Mesh[]) {
      const material = source.material as THREE.Material
      const items = seats.map((seat) => ({ geometry: source.geometry, matrix: new THREE.Matrix4().makeRotationY(seat.yaw).setPosition(seat.position) }))
      // the contact shadow is the only transparent part; it lies flat on the floor
      const mesh = new RigidMeshBatch(items, material, material.transparent)
      mesh.name = `${zone}:${source.name}`
      // chairs never block their own moves (ChairMover tests storage batches live)
      mesh.userData.chair = true
      mesh.castShadow = source.castShadow
      mesh.receiveShadow = source.receiveShadow
      mesh.renderOrder = source.renderOrder
      seats.forEach((seat, index) => seat.instances.push({ mesh, index }))
      zones[zone].add(mesh)
    }
  }
  buildChairShadows(ctx, zones)
}

/**
 * Each room's chair shadows: one quad per chair over its own tile of an atlas,
 * cast by the room's lights (chairShadow). A chair's tile and quad are redrawn
 * only when it moves, so the shadows cost nothing per frame.
 */
function buildChairShadows(ctx: LabCtx, zones: Record<ZoneId, THREE.Group>) {
  const R = CHAIR_SHADOW_RES, S = CHAIR_SHADOW_SIZE
  for (const zone of ZONE_IDS) {
    const seats = ctx.seats.filter((s) => s.zone === zone)
    if (!seats.length) continue
    const room = { emitters: ctx.emitters[zone], occluders: ctx.occluders[zone] }
    const cols = Math.ceil(Math.sqrt(seats.length)), rows = Math.ceil(seats.length / cols)
    const W = cols * R, H = rows * R
    const alpha = new Uint8Array(W * H)
    const pixels = new Uint8Array(W * H * 4).fill(255)
    const texture = new THREE.DataTexture(pixels, W, H, THREE.RGBAFormat)
    texture.magFilter = texture.minFilter = THREE.LinearFilter
    texture.generateMipmaps = false
    const material = new THREE.MeshBasicMaterial({ name: CONTACT_SHADOW, color: '#000000', map: texture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
    const position = new THREE.BufferAttribute(new Float32Array(seats.length * 12), 3)
    const uv = new THREE.BufferAttribute(new Float32Array(seats.length * 8), 2)
    const index: number[] = []
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', position)
    geometry.setAttribute('uv', uv)
    seats.forEach((seat, i) => {
      const col = i % cols, row = Math.floor(i / cols)
      const corners: [number, number][] = [[-S / 2, -S / 2], [S / 2, -S / 2], [S / 2, S / 2], [-S / 2, S / 2]]
      corners.forEach(([x, z], k) => uv.setXY(i * 4 + k, (col * R + (x / S + 0.5) * R) / W, (row * R + (z / S + 0.5) * R) / H))
      index.push(i * 4, i * 4 + 2, i * 4 + 1, i * 4, i * 4 + 3, i * 4 + 2)
      const refresh = () => {
        const offset = row * R * W + col * R
        chairShadow(room, { x: seat.position.x, z: seat.position.z, yaw: seat.yaw }, alpha, offset, W)
        for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) pixels[(offset + y * W + x) * 4 + 3] = alpha[offset + y * W + x]
        texture.needsUpdate = true
        const cos = Math.cos(seat.yaw), sin = Math.sin(seat.yaw)
        corners.forEach(([x, z], k) => position.setXYZ(i * 4 + k, seat.position.x + cos * x + sin * z, 0.0025, seat.position.z - sin * x + cos * z))
        position.needsUpdate = true
        geometry.computeBoundingSphere()
      }
      seat.shadow = { refresh }
      refresh()
    })
    geometry.setIndex(index)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = `${zone}:chair shadows`
    mesh.renderOrder = 1
    // the mover tests chairs against the room, never against their own shadows
    mesh.userData.chair = true
    zones[zone].add(mesh)
  }
}

// Test the cushion, back and castor base against actual geometry. A broad
// bench walk collider includes knee spaces and cannot decide whether a chair fits.
const POINTS = [
  ...[-0.23, 0, 0.23].flatMap(x => [-0.2, 0.2].map(z => new THREE.Vector3(x, 0.55, z))),
  ...[-0.21, 0, 0.21].flatMap(x => [0.72, 0.735, 0.885, 0.97].flatMap(y => [-0.19, -0.26].map(z => new THREE.Vector3(x, y, z)))),
  ...[-0.27, 0.27].flatMap(x => [-0.27, 0.27].map(z => new THREE.Vector3(x, 0.08, z))),
]

export class ChairMover {
  private nearbyGeometry = new Map<Seat, THREE.Mesh>()
  private collisionMaterial = new THREE.MeshBasicMaterial()
  constructor(private root: THREE.Object3D, private nav: Nav, private seats: Seat[], private doors: DoorRuntime[]) {}

  /** Cache only static triangles within this chair's short travel envelope. */
  private obstacles(seat: Seat) {
    let mesh = this.nearbyGeometry.get(seat)
    if (mesh) return mesh
    const positions: number[] = []
    const box = new THREE.Box3(
      seat.home.clone().add(new THREE.Vector3(-0.85, 0.04, -0.85)),
      seat.home.clone().add(new THREE.Vector3(0.85, 1.02, 0.85)),
    )
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
    const visit = (object: THREE.Object3D) => {
      if (object.name.startsWith('station:') || object.name.startsWith('instruments:')) return
      const source = object as THREE.Mesh
      if (source.isMesh && !(source as THREE.InstancedMesh).isInstancedMesh && !source.userData.rigidBatch) {
        const materials = Array.isArray(source.material) ? source.material : [source.material]
        if (materials.some(m => !m.transparent)) {
          const geometry = source.geometry, vertices = geometry.getAttribute('position'), index = geometry.index
          if (!vertices) return
          for (let i = 0; i < (index?.count ?? vertices.count); i += 3) {
            a.fromBufferAttribute(vertices, index ? index.getX(i) : i).applyMatrix4(source.matrixWorld)
            b.fromBufferAttribute(vertices, index ? index.getX(i + 1) : i + 1).applyMatrix4(source.matrixWorld)
            c.fromBufferAttribute(vertices, index ? index.getX(i + 2) : i + 2).applyMatrix4(source.matrixWorld)
            if (Math.max(a.x, b.x, c.x) < box.min.x || Math.min(a.x, b.x, c.x) > box.max.x
              || Math.max(a.y, b.y, c.y) < box.min.y || Math.min(a.y, b.y, c.y) > box.max.y
              || Math.max(a.z, b.z, c.z) < box.min.z || Math.min(a.z, b.z, c.z) > box.max.z) continue
            positions.push(...a.toArray(), ...b.toArray(), ...c.toArray())
          }
        }
      }
      object.children.forEach(visit)
    }
    this.root.updateMatrixWorld(true)
    const room = this.root.children.find(child => child.name === `zone:${seat.zone}`)
    if (room) visit(room)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.computeBoundingSphere()
    mesh = new THREE.Mesh(geometry, this.collisionMaterial)
    this.nearbyGeometry.set(seat, mesh)
    return mesh
  }

  dispose() {
    for (const mesh of this.nearbyGeometry.values()) mesh.geometry.dispose()
    this.nearbyGeometry.clear()
    this.collisionMaterial.dispose()
  }

  private next(seat: Seat, direction: ChairDirection) {
    const offset = THREE.MathUtils.clamp(seat.offset + (direction === 'in' ? STEP : -STEP), -LIMIT, LIMIT)
    return { offset, position: seat.home.clone().add(new THREE.Vector3(Math.sin(seat.yaw), 0, Math.cos(seat.yaw)).multiplyScalar(offset)) }
  }

  canMove(seat: Seat, direction: ChairDirection, player?: THREE.Vector3) {
    const next = this.next(seat, direction)
    if (Math.abs(next.offset - seat.offset) < 0.001) return false
    if (player) {
      // Pulling towards yourself takes a small step back, provided there is room.
      const original = { ...seat.collider }
      const standing = player.clone()
      try {
        this.bounds(seat, next.position)
        this.nav.resolve(standing, this.doors)
      } finally {
        Object.assign(seat.collider, original)
      }
      if (this.nav.zoneAt(standing.x, standing.z) !== seat.zone || standing.distanceTo(player) > 0.15
        || !this.nav.canApproach(player, standing, this.doors, seat.collider)) return false
    }
    if (this.seats.some(other => other !== seat && Math.abs(other.position.x - next.position.x) < 0.5 && Math.abs(other.position.z - next.position.z) < 0.5)) return false
    const frame = new THREE.Matrix4().makeRotationY(seat.yaw).setPosition(seat.position)
    const delta = next.position.clone().sub(seat.position)
    const distance = delta.length()
    const ray = new THREE.Raycaster(undefined, delta.clone().normalize(), 0, distance + 0.012)
    const obstacles: THREE.Object3D[] = [this.obstacles(seat)]
    // Moving cupboard/drawer vertices must be tested live rather than frozen
    // into the chair's static triangle cache at their first observed position.
    const room = this.root.children.find(child => child.name === `zone:${seat.zone}`)
    if (room) obstacles.push(...room.children.filter(child => child.userData.rigidBatch && !child.userData.chair))
    const doors = this.root.children.find(child => child.name === 'doors')
    if (doors) obstacles.push(doors)
    this.root.updateMatrixWorld(true)
    for (const point of POINTS) {
      const origin = point.clone().applyMatrix4(frame)
      const end = origin.clone().add(delta)
      const startsOutside = this.nav.zoneAt(origin.x, origin.z) !== seat.zone
      if (this.nav.zoneAt(end.x, end.z) !== seat.zone) {
        // Some inherited desk chairs start partly in a wall. Let them escape
        // towards the room, but never increase that existing overlap.
        if (!startsOutside || this.floorDistance(end, seat.zone) >= this.floorDistance(origin, seat.zone) - 0.001) return false
      }
      if (startsOutside) continue
      ray.ray.origin.copy(origin)
      const blocked = ray.intersectObjects(obstacles, true).some(hit => {
        const material = (hit.object as THREE.Mesh).material
        return !material || (Array.isArray(material) ? material.some(m => !m.transparent) : !material.transparent)
      })
      if (blocked) return false
    }
    return true
  }

  private floorDistance(p: THREE.Vector3, zone: ZoneId) {
    const floor = ZONES[zone].floor
    let distance = Infinity
    for (let i = 0; i < floor.length; i++) {
      const a = floor[i], b = floor[(i + 1) % floor.length]
      const dx = b[0] - a[0], dz = b[1] - a[1]
      const t = THREE.MathUtils.clamp(((p.x - a[0]) * dx + (p.z - a[1]) * dz) / (dx * dx + dz * dz), 0, 1)
      distance = Math.min(distance, Math.hypot(p.x - a[0] - t * dx, p.z - a[1] - t * dz))
    }
    return distance
  }

  private bounds(seat: Seat, position: THREE.Vector3) {
    Object.assign(seat.collider, { minX: position.x - 0.24, minZ: position.z - 0.24, maxX: position.x + 0.24, maxZ: position.z + 0.24 })
  }

  move(seat: Seat, direction: ChairDirection, player?: THREE.Vector3) {
    let moved = false
    // Slide as far as the available space permits, checking the entire path.
    for (let i = 0; i < 24 && this.canMove(seat, direction, player); i++) {
      const next = this.next(seat, direction)
      seat.offset = next.offset
      seat.position.copy(next.position)
      this.bounds(seat, seat.position)
      if (player) this.nav.resolve(player, this.doors)
      const matrix = new THREE.Matrix4().makeRotationY(seat.yaw).setPosition(seat.position)
      for (const { mesh, index } of seat.instances) {
        mesh.setMatrixAt(index, matrix)
        mesh.computeBoundingSphere()
      }
      moved = true
    }
    if (moved) seat.shadow?.refresh()
    return moved
  }
}

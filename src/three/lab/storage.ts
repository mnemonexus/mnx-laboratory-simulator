// Hinged casework and drawers, merged into one opaque draw per room/material;
// transparent parts keep sorted BatchedMesh rendering. They are not lightmapped:
// the room's irradiance volume lights them wherever they have moved to, so an
// opened drawer never carries the shadow it had while closed.
import * as THREE from 'three'
import type { Batch, Palette } from './kit'
import type { Collider, LabCtx } from './context'
import { ZONE_IDS, type ZoneId } from './layout'
import { RigidMeshBatch } from './rigidMeshBatch'

export interface StoragePart {
  id: string
  zone: ZoneId
  label: string
  kind: 'door' | 'drawer'
  frame: THREE.Matrix4
  bounds: THREE.Box3
  travel: number
  open: boolean
  amount: number
  instances: { mesh: THREE.InstancedMesh | THREE.BatchedMesh | RigidMeshBatch; index: number }[]
  collider?: Collider
}
interface Recipe { part: StoragePart; key: string; batch: Batch }
const recipes = new WeakMap<Batch, Recipe[]>()

export function movableStorage(b: Batch, key: string, kind: StoragePart['kind'], pivot: THREE.Vector3, travel: number, build: (model: Batch) => void) {
  const frame = b.matrix.clone().multiply(new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z))
  const model = b.forkUnbaked()
  const measured = model.measure(() => model.at(-pivot.x, -pivot.y, -pivot.z, 0, () => build(model)))
  const list = recipes.get(b) ?? []
  const part: StoragePart = {
    id: `${b.zone}:storage:${list.length}`, zone: b.zone,
    label: kind === 'drawer' ? 'Drawer' : pivot.y > 1.2 ? 'Wall cupboard' : 'Cupboard', kind,
    frame,
    bounds: measured.bounds, travel, open: false, amount: 0, instances: [],
  }
  list.push({ part, key, batch: model })
  recipes.set(b, list)
}

export function storageMatrix(part: StoragePart, amount = part.amount) {
  return part.frame.clone().multiply(part.kind === 'drawer'
    ? new THREE.Matrix4().makeTranslation(0, 0, amount * part.travel)
    : new THREE.Matrix4().makeRotationY(amount * part.travel))
}

export function storageBounds(part: StoragePart, amount = part.amount) {
  return part.bounds.clone().applyMatrix4(storageMatrix(part, amount))
}

export function buildStorage(ctx: LabCtx, palette: Palette, zones: Record<ZoneId, THREE.Group>) {
  const parts: StoragePart[] = []
  for (const zone of ZONE_IDS) {
    // every part's meshes, grouped by the material they draw with
    const byMaterial = new Map<THREE.Material, { name: string; source: THREE.Mesh; items: { part: StoragePart; geometry: THREE.BufferGeometry }[] }>()
    for (const recipe of recipes.get(ctx.batch[zone]) ?? []) {
      parts.push(recipe.part)
      if (recipe.part.frame.elements[13] < 1.2) {
        const box = storageBounds(recipe.part)
        const collider = { minX: box.min.x, minZ: box.min.z, maxX: box.max.x, maxZ: box.max.z }
        recipe.part.collider = collider
        ctx.colliders.push(collider)
      }
      for (const source of recipe.batch.build(palette, 'storage').group.children as THREE.Mesh[]) {
        const material = source.material as THREE.Material
        const entry = byMaterial.get(material) ?? { name: source.name, source, items: [] }
        entry.items.push({ part: recipe.part, geometry: source.geometry })
        byMaterial.set(material, entry)
      }
    }
    for (const [material, { name, source, items }] of byMaterial) {
      let vertices = 0
      let indices = 0
      for (const { geometry } of items) {
        vertices += geometry.getAttribute('position').count
        indices += geometry.index?.count ?? 0
      }
      const mesh = material.transparent
        ? new THREE.BatchedMesh(items.length, vertices, indices, material)
        : new RigidMeshBatch(items.map(({ part, geometry }) => ({ geometry, matrix: storageMatrix(part) })), material)
      mesh.name = `${zone}:${name}`
      mesh.castShadow = source.castShadow
      mesh.receiveShadow = source.receiveShadow
      mesh.renderOrder = source.renderOrder
      for (const [i, { part, geometry }] of items.entries()) {
        const index = mesh instanceof THREE.BatchedMesh ? mesh.addInstance(mesh.addGeometry(geometry)) : i
        if (mesh instanceof THREE.BatchedMesh) mesh.setMatrixAt(index, storageMatrix(part))
        part.instances.push({ mesh, index })
        geometry.dispose()
      }
      mesh.computeBoundingSphere()
      zones[zone].add(mesh)
    }
  }
  return parts
}

/** Keep a small clearance around the player throughout a panel's sweep. */
export function storageBlocked(part: StoragePart, player: THREE.Vector3) {
  for (let i = 0; i <= 12; i++) {
    const amount = part.amount + ((part.open ? 0 : 1) - part.amount) * i / 12
    const box = storageBounds(part, amount)
    if (box.min.y > player.y + 0.1) continue
    if (player.x > box.min.x - 0.18 && player.x < box.max.x + 0.18 && player.z > box.min.z - 0.18 && player.z < box.max.z + 0.18) return true
  }
  return false
}

export function updateStorage(parts: StoragePart[], dt: number) {
  let moving = false
  const touched = new Set<THREE.InstancedMesh | THREE.BatchedMesh | RigidMeshBatch>()
  for (const part of parts) {
    const target = part.open ? 1 : 0
    if (part.amount === target) continue
    const step = dt * 2.8
    part.amount = Math.abs(target - part.amount) <= step ? target : part.amount + Math.sign(target - part.amount) * step
    const matrix = storageMatrix(part)
    for (const { mesh, index } of part.instances) {
      mesh.setMatrixAt(index, matrix); touched.add(mesh)
    }
    if (part.collider) {
      const box = storageBounds(part)
      Object.assign(part.collider, { minX: box.min.x, minZ: box.min.z, maxX: box.max.x, maxZ: box.max.z })
    }
    moving = true
  }
  for (const mesh of touched) {
    // a batched mesh flags its own matrix texture in setMatrixAt
    if (mesh instanceof THREE.InstancedMesh) mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
  }
  return moving
}

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { storageBlocked, storageBounds, updateStorage, type StoragePart } from './storage'

function part(kind: 'door' | 'drawer', yaw = 0): StoragePart {
  return { id: 'main:0', label: 'Cupboard', zone: 'main', kind,
    frame: new THREE.Matrix4().makeRotationY(yaw).setPosition(2, 0.1, 3),
    bounds: new THREE.Box3(new THREE.Vector3(0, 0, -0.019), new THREE.Vector3(0.4, 0.7, 0)),
    travel: kind === 'drawer' ? 0.36 : -Math.PI/2, amount: 0, open: false, instances: [],
    collider: { minX: 2, minZ: 3, maxX: 2.4, maxZ: 3 },
  }
}

describe('movable casework', () => {
  it('swings outward about the hinge and returns exactly to its original bounds', () => {
    const s = part('door'), closed = storageBounds(s)
    s.open = true; expect(updateStorage([s], 1)).toBe(true)
    expect(s.amount).toBe(1)
    expect(storageBounds(s).max.z).toBeCloseTo(3.4)
    expect(s.collider?.maxZ).toBeCloseTo(3.4)
    s.open = false; updateStorage([s], 1)
    expect(storageBounds(s).equals(closed)).toBe(true)
    expect(updateStorage([s], 1)).toBe(false)
  })
  it('slides drawers along their transformed local front direction', () => {
    const s = part('drawer', Math.PI/2)
    const closed = storageBounds(s)
    s.open = true; updateStorage([s], 1)
    const open = storageBounds(s)
    expect(open.min.x-closed.min.x).toBeCloseTo(0.36)
    expect(open.min.z-closed.min.z).toBeCloseTo(0)
  })
  it('checks the sweep for a player rather than only the endpoint', () => {
    const s = part('door')
    expect(storageBlocked(s, new THREE.Vector3(2.3, 1.4, 3.2))).toBe(true)
    expect(storageBlocked(s, new THREE.Vector3(2.3, 1.4, 4))).toBe(false)
  })
  it('updates all material instances and settles without idle work', () => {
    const s = part('drawer')
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 1)
    s.instances.push({ mesh, index: 0 }); s.open = true
    updateStorage([s], 0.1)
    expect(s.amount).toBeCloseTo(0.28)
    const matrix = new THREE.Matrix4(); mesh.getMatrixAt(0, matrix)
    expect(matrix.elements[14]).toBeCloseTo(3+0.28*0.36)
    updateStorage([s], 1)
    expect(updateStorage([s], 1)).toBe(false)
    mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); mesh.dispose()
  })
})

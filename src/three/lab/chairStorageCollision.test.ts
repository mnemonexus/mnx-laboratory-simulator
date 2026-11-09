import { expect, it } from 'vitest'
import * as THREE from 'three'
import { ChairMover } from './chairs'
import { Nav } from './nav'
import { RigidMeshBatch } from './rigidMeshBatch'
import type { Seat } from './context'

it('chair collision follows moving storage instead of caching its first position', () => {
  const root = new THREE.Group(), room = new THREE.Group()
  room.name = 'zone:main'; root.add(room)
  const home = new THREE.Vector3()
  const seat: Seat = { zone: 'main', position: home.clone(), home, yaw: 0, offset: 0, instances: [], collider: { minX: -0.24, maxX: 0.24, minZ: -0.24, maxZ: 0.24 } }
  const geometry = new THREE.BoxGeometry(2, 1, 0.02)
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
  const blocking = new THREE.Matrix4().makeTranslation(0, 0.5, 0.31)
  const batch = new RigidMeshBatch([{ geometry, matrix: blocking }], material)
  room.add(batch)
  const mover = new ChairMover(root, new Nav([]), [seat], [])
  expect(mover.canMove(seat, 'in')).toBe(false)
  batch.setMatrixAt(0, new THREE.Matrix4().makeTranslation(3, 0.5, 0.31)); batch.computeBoundingSphere()
  expect(mover.canMove(seat, 'in')).toBe(true)
  batch.setMatrixAt(0, blocking); batch.computeBoundingSphere()
  expect(mover.canMove(seat, 'in')).toBe(false)
  mover.dispose(); batch.geometry.dispose(); geometry.dispose(); material.dispose()
})

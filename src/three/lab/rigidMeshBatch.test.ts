import { expect, it } from 'vitest'
import * as THREE from 'three'
import { RigidMeshBatch } from './rigidMeshBatch'

function fixture() {
  const a = new THREE.BoxGeometry(0.4, 0.7, 0.03), b = new THREE.BoxGeometry(0.3, 0.1, 0.4)
  for (const [i, g] of [a, b].entries()) g.setAttribute('uv1', new THREE.Float32BufferAttribute(Array.from({ length: g.getAttribute('position').count * 2 }, (_, j) => (j + i) / 100), 2))
  return [a, b].map((geometry, i) => ({ geometry, matrix: new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(i * 0.27, i * 0.42, -i * 0.16)).setPosition(i * 2, 1, 0) }))
}

it('retains per-part attributes, indices and baked UVs while matching separate transformed meshes', () => {
  const items = fixture(), batch = new RigidMeshBatch(items, new THREE.MeshStandardMaterial())
  let vertex = 0, index = 0
  for (const item of items) {
    const expected = item.geometry.clone().applyMatrix4(item.matrix)
    for (const [name, attr] of Object.entries(expected.attributes)) {
      const actual = batch.geometry.getAttribute(name)
      for (let j = 0; j < attr.array.length; j++) expect(actual.array[vertex * attr.itemSize + j]).toBe(attr.array[j])
    }
    for (let j = 0; j < expected.index!.count; j++) expect(batch.geometry.index!.getX(index + j)).toBe(vertex + expected.index!.getX(j))
    vertex += expected.getAttribute('position').count; index += expected.index!.count
    expected.dispose()
  }
  expect(batch.geometry.groups).toHaveLength(0)
})

it('moves only the changed part, preserves UVs, bounds and ray hits, and returns without drift', () => {
  const items = fixture(), batch = new RigidMeshBatch(items, new THREE.MeshStandardMaterial())
  const original = batch.geometry.getAttribute('position').array.slice()
  const uv = batch.geometry.getAttribute('uv1').array.slice()
  const moved = new THREE.Matrix4().makeRotationY(-Math.PI / 2).setPosition(3, 1, 0)
  for (let i = 0; i < 20; i++) batch.setMatrixAt(0, moved)
  batch.computeBoundingSphere()
  const positions = batch.geometry.getAttribute('position') as THREE.BufferAttribute
  expect(positions.updateRanges).toEqual([{ start: 0, count: items[0].geometry.getAttribute('position').count * 3 }])
  const firstCount = items[0].geometry.getAttribute('position').count
  expect(positions.array.slice(firstCount * 3)).toEqual(original.slice(firstCount * 3))
  expect(batch.geometry.getAttribute('uv1').array).toEqual(uv)
  const expected = items[0].geometry.clone().applyMatrix4(moved)
  for (let i = 0; i < firstCount; i++) expect(batch.geometry.boundingBox!.containsPoint(new THREE.Vector3().fromBufferAttribute(positions, i))).toBe(true)
  const ray = new THREE.Raycaster(new THREE.Vector3(5, 1, 0), new THREE.Vector3(-1, 0, 0))
  const firstHit = ray.intersectObject(batch)[0]
  expect(batch.geometry.drawRange).toEqual({ start: 0, count: Infinity })
  expect(firstHit.distance).toBeCloseTo(ray.intersectObject(new THREE.Mesh(expected, batch.material))[0].distance)
  expect(batch.geometry.boundingSphere!.containsPoint(firstHit.point)).toBe(true)
  batch.setMatrixAt(0, items[0].matrix)
  expect(positions.array).toEqual(original)
  const read = new THREE.Matrix4(); batch.getMatrixAt(0, read)
  expect(read.equals(items[0].matrix)).toBe(true)
  // A renderer consumes these ranges after upload. An unchanged transform must
  // not dirty the buffer or append an upload on the next idle frame.
  positions.clearUpdateRanges(); const version = positions.version
  batch.setMatrixAt(0, items[0].matrix)
  expect(positions.version).toBe(version)
  expect(positions.updateRanges).toEqual([])
})

it('requires opaque compatible batches and leaves source geometry untouched', () => {
  const items = fixture(), positions = items.map(item => item.geometry.getAttribute('position').array.slice())
  new RigidMeshBatch(items, new THREE.MeshBasicMaterial())
  expect(items.map(item => item.geometry.getAttribute('position').array)).toEqual(positions)
  expect(() => new RigidMeshBatch([], new THREE.MeshBasicMaterial())).toThrow(/opaque/)
  expect(() => new RigidMeshBatch(items, new THREE.MeshBasicMaterial({ transparent: true }))).toThrow(/opaque/)
})

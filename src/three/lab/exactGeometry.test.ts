import { expect, it } from 'vitest'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { exactIndexedGeometry } from './exactGeometry'

function triangleBits(g: THREE.BufferGeometry, name: string) {
  const attribute = g.getAttribute(name) as THREE.BufferAttribute
  const bits = new Uint32Array(attribute.array.buffer, attribute.array.byteOffset, attribute.array.length)
  const indices = g.index?.array ?? Uint32Array.from({ length: attribute.count }, (_, i) => i)
  return Array.from(indices).flatMap(i => Array.from(bits.subarray(i * attribute.itemSize, (i + 1) * attribute.itemSize)))
}

it('keeps every triangle attribute bit-exact, including UV seams, while compacting rounded primitives', () => {
  for (const [w, h, d, radius] of [[0.8, 0.02, 0.3, 0.006], [0.03, 0.2, 0.04, 0.003], [1, 1, 1, 0.1]]) {
    const source = new RoundedBoxGeometry(w, h, d, 2, radius)
    source.computeBoundingBox(); source.computeBoundingSphere()
    const indexed = exactIndexedGeometry(source)
    expect(indexed.constructor).toBe(THREE.BufferGeometry)
    expect(indexed.clone().constructor).toBe(THREE.BufferGeometry)
    expect(indexed.getAttribute('position').count).toBeLessThan(source.getAttribute('position').count / 2)
    for (const name of Object.keys(source.attributes)) expect(triangleBits(indexed, name)).toEqual(triangleBits(source, name))
    expect(indexed.groups).toEqual(source.groups)
    expect(indexed.boundingBox).toEqual(source.boundingBox)
    expect(indexed.boundingSphere).toEqual(source.boundingSphere)
    expect(new THREE.Raycaster(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1)).intersectObject(new THREE.Mesh(indexed)).map(hit => hit.distance)).toEqual(new THREE.Raycaster(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1)).intersectObject(new THREE.Mesh(source)).map(hit => hit.distance))
    source.dispose(); indexed.dispose()
  }
})

it('does not merge distinct normal, UV, signed-zero or colour records or change indexed draw order', () => {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, -0, 0, 0, 0, 0, 0], 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0], 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 0, 0, 0], 2))
  g.setAttribute('color', new THREE.Float32BufferAttribute([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0], 3))
  g.setIndex([3, 2, 1, 1, 0, 3]); g.addGroup(0, 3, 0); g.setDrawRange(1, 3)
  const result = exactIndexedGeometry(g)
  expect(result.getAttribute('position').count).toBe(4)
  for (const name of Object.keys(g.attributes)) expect(triangleBits(result, name)).toEqual(triangleBits(g, name))
  expect(result.groups).toEqual(g.groups)
  expect(result.drawRange).toEqual(g.drawRange)
  expect(result.getAttribute('position').array).not.toBe(g.getAttribute('position').array)
})

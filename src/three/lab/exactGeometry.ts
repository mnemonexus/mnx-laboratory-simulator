import * as THREE from 'three'

/** Index identical Float32 vertex records without quantising positions, normals
 * or UV seams. The result is a plain geometry: cloning procedural subclasses
 * would run their expensive constructor again before copying the cached data.
 * Applied once to small cached primitives, not once per room or per frame.
 */
export function exactIndexedGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const entries = Object.entries(source.attributes).map(([name, attribute]) => {
    if (!(attribute instanceof THREE.BufferAttribute) || !(attribute.array instanceof Float32Array)) throw new Error('Exact primitive indexing requires Float32 buffer attributes')
    return { name, attribute, bits: new Uint32Array(attribute.array.buffer, attribute.array.byteOffset, attribute.array.length) }
  })
  const count = source.getAttribute('position')?.count ?? 0
  if (!count || entries.some(({ attribute }) => attribute.count !== count) || Object.keys(source.morphAttributes).length) throw new Error('Invalid static primitive attributes')
  const records = new Map<string, number>()
  const representatives: number[] = [], remap = new Uint32Array(count)
  for (let i = 0; i < count; i++) {
    let key = ''
    for (const { attribute, bits } of entries) for (let component = 0; component < attribute.itemSize; component++) key += `${bits[i * attribute.itemSize + component]},`
    let index = records.get(key)
    if (index === undefined) { index = representatives.length; representatives.push(i); records.set(key, index) }
    remap[i] = index
  }
  const out = new THREE.BufferGeometry()
  out.name = source.name
  out.userData = { ...source.userData }
  for (const { name, attribute, bits } of entries) {
    const array = new Float32Array(representatives.length * attribute.itemSize)
    const packed = new Uint32Array(array.buffer)
    representatives.forEach((old, index) => packed.set(bits.subarray(old * attribute.itemSize, (old + 1) * attribute.itemSize), index * attribute.itemSize))
    const copy = new THREE.BufferAttribute(array, attribute.itemSize, attribute.normalized)
    copy.name = attribute.name
    copy.setUsage(attribute.usage)
    out.setAttribute(name, copy)
  }
  const sourceIndices = source.index?.array ?? Uint32Array.from({ length: count }, (_, i) => i)
  const indices = representatives.length <= 65536 ? new Uint16Array(sourceIndices.length) : new Uint32Array(sourceIndices.length)
  for (let i = 0; i < sourceIndices.length; i++) indices[i] = remap[sourceIndices[i]]
  out.setIndex(new THREE.BufferAttribute(indices, 1))
  for (const group of source.groups) out.addGroup(group.start, group.count, group.materialIndex)
  out.setDrawRange(source.drawRange.start, source.drawRange.count)
  out.boundingBox = source.boundingBox?.clone() ?? null
  out.boundingSphere = source.boundingSphere?.clone() ?? null
  return out
}

// Collapse the static parts of hand-built instrument models into one mesh per
// distinct material, leaving animated / pickable parts untouched. Instruments
// are modelled as dozens of small meshes; merged they cost a few draw calls.
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

function materialKey(m: THREE.Material) {
  const s = m as THREE.MeshStandardMaterial & THREE.MeshPhysicalMaterial & THREE.MeshBasicMaterial
  return [
    m.type,
    s.color?.getHexString(),
    s.emissive?.getHexString(),
    s.roughness,
    s.metalness,
    s.clearcoat,
    s.transmission,
    m.transparent,
    m.opacity,
    m.side,
    m.depthWrite,
    m.toneMapped,
    m.alphaTest,
    s.vertexColors,
    s.map?.uuid,
    s.normalMap?.uuid,
    s.roughnessMap?.uuid,
    s.alphaMap?.uuid,
  ].join('|')
}

/** Merge every static mesh under `root`; `dynamic` subtrees are left alone. */
export function mergeStaticMeshes(root: THREE.Object3D, dynamic: THREE.Object3D[] = []) {
  root.updateMatrixWorld(true)
  const skip = new Set<THREE.Object3D>()
  for (const d of dynamic) d.traverse((o) => skip.add(o))
  const inv = root.matrixWorld.clone().invert()
  const buckets = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[]; cast: boolean; receive: boolean }>()
  const victims: THREE.Mesh[] = []
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh || skip.has(m) || (m as THREE.InstancedMesh).isInstancedMesh || Array.isArray(m.material)) return
    if (m.userData.pick || m.morphTargetInfluences) return
    const g = m.geometry.index ? m.geometry.clone() : m.geometry.clone().setIndex([...Array(m.geometry.getAttribute('position').count).keys()])
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name)
    if (!g.getAttribute('normal')) g.computeVertexNormals()
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2))
    g.morphAttributes = {}
    g.clearGroups()
    g.applyMatrix4(inv.clone().multiply(m.matrixWorld))
    const key = materialKey(m.material)
    let b = buckets.get(key)
    if (!b) {
      b = { mat: m.material, geos: [], cast: false, receive: false }
      buckets.set(key, b)
    }
    b.geos.push(g)
    b.cast ||= m.castShadow
    b.receive ||= m.receiveShadow
    victims.push(m)
  })
  for (const v of victims) {
    v.parent?.remove(v)
    v.geometry.dispose()
  }
  for (const b of buckets.values()) {
    const merged = mergeGeometries(b.geos, false)
    b.geos.forEach((g) => g.dispose())
    if (!merged) continue
    const mesh = new THREE.Mesh(merged, b.mat)
    mesh.castShadow = b.cast
    mesh.receiveShadow = b.receive
    root.add(mesh)
  }
  return root
}

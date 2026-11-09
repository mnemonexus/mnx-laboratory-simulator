import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

interface Part {
  position: THREE.BufferAttribute
  normal?: THREE.BufferAttribute
  first: number
  matrix: THREE.Matrix4
  localBounds: THREE.Box3
  bounds: THREE.Box3
  drawStart: number
  drawCount: number
}

/** One opaque draw with independent rigid parts. UVs (including baked lighting)
 * remain per vertex. Only a moving part's position/normal ranges are rewritten;
 * idle parts do no transform work and need no matrix texture or custom shader,
 * so every batch with the same material shares one pipeline (small
 * InstancedMeshes each compile their own). Input position/normal arrays remain
 * live as immutable CPU rest data; other attributes are copied by the merge.
 * No input arrays are modified. Transparent parts are allowed only where draw
 * order within the batch cannot matter (`unsorted`, e.g. floor contact shadows).
 */
export class RigidMeshBatch extends THREE.Mesh {
  private readonly parts: Part[] = []
  private readonly partNormalMatrix = new THREE.Matrix3()
  private readonly localRay = new THREE.Ray()
  private readonly inverseWorld = new THREE.Matrix4()

  constructor(items: readonly { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[], material: THREE.Material, unsorted = false) {
    if (!items.length || (material.transparent && !unsorted)) throw new Error('Rigid batches require nonempty opaque geometry')
    const geometry = mergeGeometries(items.map(item => item.geometry), false)
    if (!geometry) throw new Error('Incompatible rigid batch geometry')
    super(geometry, material)
    this.matrixAutoUpdate = false
    this.userData.rigidBatch = true
    const positions = geometry.getAttribute('position') as THREE.BufferAttribute
    const normals = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined
    positions.setUsage(THREE.DynamicDrawUsage)
    normals?.setUsage(THREE.DynamicDrawUsage)
    let first = 0, drawStart = 0
    for (const item of items) {
      const position = item.geometry.getAttribute('position')
      const normal = item.geometry.getAttribute('normal')
      if (!(position instanceof THREE.BufferAttribute) || (normal && !(normal instanceof THREE.BufferAttribute))) throw new Error('Rigid batches require non-interleaved geometry')
      if (!(position.array instanceof Float32Array) || position.normalized || (normal && (!(normal.array instanceof Float32Array) || normal.normalized))) throw new Error('Rigid positions/normals require unnormalised Float32 storage')
      item.geometry.computeBoundingBox()
      const drawCount = item.geometry.index?.count ?? position.count
      this.parts.push({ position, normal, first, matrix: item.matrix.clone(), localBounds: item.geometry.boundingBox!.clone(), bounds: new THREE.Box3(), drawStart, drawCount })
      this.transform(this.parts.length - 1, item.matrix)
      first += position.count
      drawStart += drawCount
    }
    this.computeBoundingSphere()
    // The initial GPU allocation uploads all attributes, without subranges.
    positions.clearUpdateRanges()
    normals?.clearUpdateRanges()
  }

  getMatrixAt(index: number, target: THREE.Matrix4) { target.copy(this.parts[index].matrix) }

  setMatrixAt(index: number, matrix: THREE.Matrix4) {
    if (this.parts[index].matrix.equals(matrix)) return
    this.transform(index, matrix)
  }

  private transform(index: number, matrix: THREE.Matrix4) {
    const part = this.parts[index]
    const positions = this.geometry.getAttribute('position') as THREE.BufferAttribute
    const normals = this.geometry.getAttribute('normal') as THREE.BufferAttribute | undefined
    this.partNormalMatrix.getNormalMatrix(matrix)
    const source = part.position.array, target = positions.array, e = matrix.elements
    const sourceNormals = part.normal?.array, targetNormals = normals?.array, n = this.partNormalMatrix.elements
    for (let i = 0; i < part.position.count; i++) {
      const j = i * 3, k = part.first * 3 + j
      const x = source[j], y = source[j + 1], z = source[j + 2]
      const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15])
      target[k] = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w
      target[k + 1] = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w
      target[k + 2] = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w
      if (sourceNormals && targetNormals) {
        const x = sourceNormals[j], y = sourceNormals[j + 1], z = sourceNormals[j + 2]
        const nx = n[0] * x + n[3] * y + n[6] * z
        const ny = n[1] * x + n[4] * y + n[7] * z
        const nz = n[2] * x + n[5] * y + n[8] * z
        const inverseLength = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1)
        targetNormals[k] = nx * inverseLength
        targetNormals[k + 1] = ny * inverseLength
        targetNormals[k + 2] = nz * inverseLength
      }
    }
    for (const attribute of [positions, normals]) if (attribute) {
      const start = part.first * 3, count = part.position.count * 3
      // A hidden mesh may move repeatedly before its next upload. Keep one
      // dirty range per part rather than accumulating duplicate ranges.
      if (!attribute.updateRanges.some(range => range.start === start && range.count === count)) attribute.addUpdateRange(start, count)
      attribute.needsUpdate = true
    }
    part.matrix.copy(matrix)
    part.bounds.copy(part.localBounds).applyMatrix4(matrix)
    // Vertex storage rounds to Float32 after the double-precision transform.
    // Keep rounded edge vertices inside the broad-phase/culling bounds.
    const { min, max } = part.bounds
    part.bounds.expandByScalar(1e-6 * Math.max(1, Math.abs(min.x), Math.abs(min.y), Math.abs(min.z), Math.abs(max.x), Math.abs(max.y), Math.abs(max.z)))
  }

  /** Conservative bounds from part boxes, without rescanning every vertex. */
  computeBoundingSphere() {
    const box = this.geometry.boundingBox ??= new THREE.Box3()
    box.makeEmpty()
    for (const part of this.parts) box.union(part.bounds)
    box.getBoundingSphere(this.geometry.boundingSphere ??= new THREE.Sphere())
  }

  override raycast(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) {
    this.localRay.copy(raycaster.ray).applyMatrix4(this.inverseWorld.copy(this.matrixWorld).invert())
    const { start, count } = this.geometry.drawRange
    try {
      for (const part of this.parts) {
        if (!this.localRay.intersectsBox(part.bounds)) continue
        const first = Math.max(start, part.drawStart)
        const last = Math.min(start + count, part.drawStart + part.drawCount)
        if (last <= first) continue
        this.geometry.setDrawRange(first, last - first)
        super.raycast(raycaster, intersects)
      }
    } finally { this.geometry.setDrawRange(start, count) }
  }
}

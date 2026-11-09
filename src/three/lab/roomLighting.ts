// Lighting follows the object’s room, never the camera’s room.
import * as THREE from 'three'
import { createEnvBoxUniforms, createVolumeNodes, outlineWalls, patchMaterial, placeholderVolume, updateMaterialEnvironment, type ReflectionPortal, type VolumeNodes } from './lighting'
import { DOORS, DOOR_H, ZONES, doorWidth, zoneBounds, type ZoneId } from './layout'

/** Glossy enough for what lies beyond an opening to show in its reflection. */
const PORTAL_ROUGHNESS = 0.5

export class RoomLighting {
  private rooms = new Map<ZoneId, {
    uniforms: ReturnType<typeof createEnvBoxUniforms>
    materials: Set<THREE.MeshStandardMaterial>
    clones: WeakMap<THREE.Material, THREE.MeshStandardMaterial>
    environment: THREE.Texture
    intensity: number
    volume: VolumeNodes
    portals?: (ReflectionPortal & { zone: ZoneId })[]
  }>()
  private bound = new WeakSet<THREE.Material>()
  private owned = new Set<THREE.Material>()
  private watched = new WeakSet<THREE.Object3D>()
  private volumes = new Set<THREE.Texture>()

  constructor(private fallback: THREE.Texture) {}

  private room(zone: ZoneId) {
    let room = this.rooms.get(zone)
    if (!room) {
      const def = ZONES[zone]
      const b = zoneBounds(def)
      const uniforms = createEnvBoxUniforms()
      uniforms.envBoxMin.value.set(b.minX, 0, b.minZ)
      uniforms.envBoxMax.value.set(b.maxX, def.ceiling, b.maxZ)
      uniforms.envProbePos.value.set(...def.probe)
      uniforms.envWalls = outlineWalls(def.floor)
      const volume = placeholderVolume()
      this.volumes.add(volume)
      room = { uniforms, materials: new Set(), clones: new WeakMap(), environment: this.fallback, intensity: 0.9, volume: createVolumeNodes(volume) }
      this.rooms.set(zone, room)
    }
    return room
  }

  /** The room's leafless openings, each leading reflections on into the next room's box and probe. */
  private portals(zone: ZoneId) {
    const room = this.room(zone)
    room.portals ??= DOORS.filter((d) => d.kind === 'opening' && (d.a === zone || d.b === zone)).map((d) => {
      const other = d.a === zone ? d.b : d.a
      const out = d.a === zone ? 1 : -1
      const next = this.room(other)
      return {
        zone: other,
        center: new THREE.Vector3(d.center[0], 0, d.center[1]),
        normal: new THREE.Vector3(d.normal[0] * out, 0, d.normal[1] * out),
        along: new THREE.Vector3(-d.normal[1], 0, d.normal[0]),
        halfWidth: doorWidth(d) / 2,
        height: DOOR_H,
        next: next.uniforms,
        environment: next.environment,
        lookups: new Set(),
      }
    })
    return room.portals
  }

  /** Shell materials are already unique; retain them so bake updates still apply. */
  register(zone: ZoneId, materials: THREE.MeshStandardMaterial[]) {
    for (const material of materials) this.add(zone, material, true)
  }

  private add(zone: ZoneId, material: THREE.MeshStandardMaterial, baked = false) {
    const room = this.room(zone)
    material.envMap = room.environment
    // lightmapped shells keep their lightmap; everything else reads the room's volume
    // The room's own glossy surfaces (floor, worktops) follow its outline and
    // its openings; objects keep the box. The wall count is part of a shader's
    // code, so outline lookups on every material cost 56 programs (17 s at load).
    const glossy = baked && material.roughness < PORTAL_ROUGHNESS
    const portals = glossy ? this.portals(zone) : undefined
    patchMaterial(material, { baked, boxProject: true, volume: baked ? undefined : room.volume, portals, outline: glossy }, room.uniforms)
    // Node materials cache their built state by a key that sees neither texture
    // identity nor which room's uniforms a node holds: without the room in the
    // key, every room's copy would reuse the first room's volume and box bounds.
    const base = material.customProgramCacheKey.bind(material)
    material.customProgramCacheKey = () => `${base()}|room:${zone}`
    // Explicit envMaps do not inherit scene.environmentIntensity.
    material.envMapIntensity *= room.intensity
    material.userData.roomEnvIntensity = material.envMapIntensity / room.intensity
    room.materials.add(material)
    this.bound.add(material)
    material.addEventListener('dispose', () => {
      room.materials.delete(material)
      this.owned.delete(material)
    })
  }

  /**
   * Bind a room's tree now, and anything added to it later (station objects),
   * through `childadded` events rather than a per-frame traversal.
   */
  watch(zone: ZoneId, root: THREE.Object3D) {
    const attach = (object: THREE.Object3D) => {
      this.bind(zone, object)
      object.traverse((o) => {
        if (this.watched.has(o)) return
        this.watched.add(o)
        o.addEventListener('childadded', onAdded)
      })
    }
    const onAdded = (event: { child: THREE.Object3D }) => attach(event.child)
    attach(root)
  }

  bind(zone: ZoneId, root: THREE.Object3D) {
    const room = this.room(zone)
    const bindMaterial = (source: THREE.Material) => {
      if (!(source as THREE.MeshStandardMaterial).isMeshStandardMaterial || this.bound.has(source)) return source
      let material = room.clones.get(source)
      if (!material) {
        material = source.clone() as THREE.MeshStandardMaterial
        this.add(zone, material)
        room.clones.set(source, material)
        material.addEventListener('dispose', () => room.clones.delete(source))
        this.owned.add(material)
      }
      return material
    }
    root.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(bindMaterial) : bindMaterial(mesh.material)
    })
  }

  /**
   * Install a room's baked irradiance volume (cell 0's centre at `origin`, `dims`
   * cells). The room keeps its one texture object and takes the new data in
   * place: a different texture would change every material's cache key and
   * rebuild them on their next draw.
   */
  setVolume(zone: ZoneId, data: Uint32Array, origin: THREE.Vector3Like, cell: number, dims: THREE.Vector3Like) {
    const v = this.room(zone).volume
    const texture = v.texture.value as THREE.Data3DTexture
    texture.image = { data, width: dims.x, height: dims.y, depth: dims.z * 6 }
    texture.needsUpdate = true
    v.origin.value.set(origin.x, origin.y, origin.z)
    v.cell.value = cell
    v.dims.value.set(dims.x, dims.y, dims.z)
  }

  setEnvironment(zone: ZoneId, texture: THREE.Texture | null) {
    const room = this.room(zone)
    room.environment = texture ?? this.fallback
    room.intensity = texture ? 1 : 0.9
    for (const material of room.materials) {
      updateMaterialEnvironment(material, room.environment)
      material.envMapIntensity = material.userData.roomEnvIntensity * room.intensity
    }
    // reflections in the rooms that open onto this one read its probe too
    for (const other of this.rooms.values()) {
      for (const portal of other.portals ?? []) {
        if (portal.zone !== zone) continue
        portal.environment = room.environment
        for (const lookup of portal.lookups) lookup.value = room.environment
      }
    }
  }

  dispose() {
    for (const material of this.owned) material.dispose()
    for (const texture of this.volumes) texture.dispose()
    this.rooms.clear()
  }
}

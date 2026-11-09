// Lighting model for the lab.
//
// • Room shells (walls, floor, ceiling, cove) are lit only by a baked lightmap;
//   direct lights and diffuse IBL are stripped from their shader so nothing is
//   counted twice. Their specular reflections still come from the room probe.
// • Everything else (doors and drawers, instruments, chairs, props) takes its
//   diffuse light from the room's baked irradiance volume: an ambient cube per
//   cell, from the same baker as the walls, so a part reads like the lightmapped
//   surfaces around it wherever it moves. Specular comes from the room's
//   reflection probe, captured from the baked room itself.
// • Reflections on glossy surfaces are box-projected onto the room's bounds,
//   which puts the troffer highlights in the right place on floors and tops.
import * as THREE from 'three'
import { PhysicalLightingModel, type NodeBuilder, type Node, type PMREMGenerator, type WebGPURenderer, type RenderTarget } from 'three/webgpu'
import { Fn, diffuseColor, materialLightMap, uniform, positionWorld, normalWorld, pmremTexture, min, max, mix, smoothstep, step, vec3, vec4, select, texture3D, float, property, luminance, materialEnvIntensity } from 'three/tsl'
import type { SurfaceSet } from './surfaces'

export interface EnvBoxUniforms {
  envBoxMin: { value: THREE.Vector3 }
  envBoxMax: { value: THREE.Vector3 }
  envProbePos: { value: THREE.Vector3 }
  /**
   * A room that is not its bounding box (an L, a slanted end): its walls, so a
   * reflection leaves through the wall it really reaches. Each wall is two
   * vectors: (start x, start z, outward normal x, z) and (along x, z, length, 0).
   */
  envWalls: [THREE.Vector4, THREE.Vector4][]
}

export function createEnvBoxUniforms(): EnvBoxUniforms {
  return {
    envBoxMin: { value: new THREE.Vector3(-1, 0, -1) },
    envBoxMax: { value: new THREE.Vector3(1, 3, 1) },
    envProbePos: { value: new THREE.Vector3(0, 1.4, 0) },
    envWalls: [],
  }
}

/** The walls of a room outline that does not fill its bounding box (none when it does). */
export function outlineWalls(outline: [number, number][]): [THREE.Vector4, THREE.Vector4][] {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, twice = 0
  outline.forEach(([x, z], i) => {
    const [x2, z2] = outline[(i + 1) % outline.length]
    twice += x * z2 - x2 * z
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
  })
  if (Math.abs(twice) / 2 >= (maxX - minX) * (maxZ - minZ) * 0.995) return []
  // the interior lies left of each edge when the signed area is positive, so outward is right; else left
  const turn = twice > 0 ? 1 : -1
  return outline.map(([ax, az], i) => {
    const [bx, bz] = outline[(i + 1) % outline.length]
    const length = Math.hypot(bx - ax, bz - az)
    const tx = (bx - ax) / length, tz = (bz - az) / length
    return [new THREE.Vector4(ax, az, tz * turn, -tx * turn), new THREE.Vector4(tx, tz, length, 0)]
  })
}

/**
 * The probe's reflection on this pixel, as the material added it (rgb), and
 * how much of what the probe saw that is (a; above 1 where a material boosts
 * its reflections): where SSR finds the real reflection, the post pass swaps
 * the one for the other (gpuPipeline).
 */
export const probeSpecular = property('vec4', 'ProbeSpecular')

/** Keep the probe reflection a material has just added (after its specular occlusion). */
function keepProbeSpecular(builder: NodeBuilder) {
  const { reflectedLight, radiance } = builder.context as { reflectedLight: { indirectSpecular: Node<'vec3'> }; radiance: Node<'vec3'> }
  const specular = reflectedLight.indirectSpecular
  probeSpecular.assign(vec4(specular, luminance(specular).div(max(luminance(radiance), 1e-4)).mul(materialEnvIntensity).min(4)))
}

class BakedLightingModel extends PhysicalLightingModel {
  override direct() {}
  override directRectArea() {}
  override indirect(builder: NodeBuilder) {
    super.indirect(builder)
    const context = builder.context as { reflectedLight: { indirectDiffuse: Node } }
    context.reflectedLight.indirectDiffuse.assign(diffuseColor.rgb.mul(materialLightMap))
    keepProbeSpecular(builder)
  }
}

/**
 * A room's irradiance volume as shader inputs: six ambient-cube directions in
 * z-stacked blocks of one 3-D texture (see bake.ts), cell 0's centre at `origin`.
 */
export interface VolumeNodes {
  texture: ReturnType<typeof texture3D>
  origin: Node<'vec3'> & { value: THREE.Vector3 }
  cell: Node<'float'> & { value: number }
  dims: Node<'vec3'> & { value: THREE.Vector3 }
}

/**
 * A room's volume texture: one mid-grey cell until its bake fills it in place
 * (see RoomLighting.setVolume). Every room needs its own texture object: node
 * materials cache their built state by texture identity, so rooms sharing one
 * placeholder would share one state, and with it one room's volume.
 */
export function placeholderVolume(level = 0.6) {
  const v = Math.round(level * 256)
  // RGB9E5 with exponent 16: value = mantissa / 256
  const t = new THREE.Data3DTexture(new Uint32Array(6).fill(((16 << 27) | (v << 18) | (v << 9) | v) >>> 0), 1, 1, 6)
  t.format = THREE.RGBFormat
  t.type = THREE.UnsignedInt5999Type
  t.magFilter = t.minFilter = THREE.LinearFilter
  t.generateMipmaps = false
  t.needsUpdate = true
  return t
}

export function createVolumeNodes(texture: THREE.Data3DTexture): VolumeNodes {
  return {
    texture: texture3D(texture),
    origin: uniform(new THREE.Vector3()) as unknown as VolumeNodes['origin'],
    cell: uniform(1) as unknown as VolumeNodes['cell'],
    dims: uniform(new THREE.Vector3(1, 1, 1)) as unknown as VolumeNodes['dims'],
  }
}

/** Irradiance for a surface point and normal from the room's ambient cubes (three texture reads). */
function volumeIrradiance(v: VolumeNodes) {
  return Fn(() => {
    const n = normalWorld
    // sample half a cell off the surface, in front of it rather than inside the part
    const g = positionWorld.add(n.mul(v.cell.mul(0.5))).sub(v.origin).div(v.cell)
    const dims = v.dims
    const u = g.x.clamp(0, dims.x.sub(1)).add(0.5).div(dims.x)
    const w = g.y.clamp(0, dims.y.sub(1)).add(0.5).div(dims.y)
    const k = g.z.clamp(0, dims.z.sub(1)).add(0.5)
    const depth = dims.z.mul(6)
    const at = (block: Node<'float'>) => v.texture.sample(vec3(u, w, block.mul(dims.z).add(k).div(depth))).rgb
    const ex = at(select(n.x.greaterThanEqual(0), float(0), float(1)) as Node<'float'>)
    const ey = at(select(n.y.greaterThanEqual(0), float(2), float(3)) as Node<'float'>)
    const ez = at(select(n.z.greaterThanEqual(0), float(4), float(5)) as Node<'float'>)
    return ex.mul(n.x.mul(n.x)).add(ey.mul(n.y.mul(n.y))).add(ez.mul(n.z.mul(n.z)))
  })()
}

/** Diffuse from the room's irradiance volume (no realtime lights), specular from its probe. */
class VolumeLightingModel extends PhysicalLightingModel {
  constructor(private readonly volume: VolumeNodes) {
    super()
  }
  override direct() {}
  override directRectArea() {}
  override indirect(builder: NodeBuilder) {
    super.indirect(builder)
    const context = builder.context as { reflectedLight: { indirectDiffuse: Node } }
    context.reflectedLight.indirectDiffuse.assign(diffuseColor.rgb.mul(volumeIrradiance(this.volume)))
    keepProbeSpecular(builder)
  }
}

const environmentNodes = new WeakMap<THREE.Material, ReturnType<typeof pmremTexture>>()

/**
 * A leafless opening a reflection passes through into the next room: its plane
 * (centre at floor level, normal into the next room, run along the wall), the
 * next room's box and probe, and the lookups reading that probe, which are
 * updated when it is captured.
 */
export interface ReflectionPortal {
  center: THREE.Vector3
  normal: THREE.Vector3
  along: THREE.Vector3
  halfWidth: number
  height: number
  next: EnvBoxUniforms
  environment: THREE.Texture
  lookups: Set<ReturnType<typeof pmremTexture>>
}

type EnvContext = { getUV: () => Node<'vec3'>; getTextureLevel: () => Node<'float'> }

/** Half-width of the blend across an opening's jambs and head, in scene units (about 9 cm). */
const PORTAL_EDGE = 0.075

/**
 * Box projection of a reflection ray that enters the box at `start(ray)`. xyz:
 * the probe direction, where the ray leaves the box seen from the probe. w: the
 * blur scale, the ray's length from the surface over the probe's distance to
 * that point. A probe blurs by angle from where it was captured, so its
 * reflections came out blurrier far from it and sharper right under it than
 * the surface's roughness gives (one room's lights sharp, the next smeared).
 */
function boxProjected(start: (v: Node<'vec3'>) => Node<'vec3'>, low: Node<'vec3'>, high: Node<'vec3'>, probe: Node<'vec3'>, outline: EnvBoxUniforms['envWalls'] = []) {
  const walls = outline.map(([edge, run]) => [uniform(edge), uniform(run)] as const)
  return Fn((builder: NodeBuilder) => {
    const v = (builder.context as EnvContext).getUV()
    // Irradiance uses the surface normal, not a reflection ray. Projecting
    // it makes diffuse lighting depend on tiny camera-space rounding errors.
    if (v === normalWorld) return vec4(v, 1)
    const entry = start(v)
    // Surfaces just outside the room's box (window reveals and frames, door
    // casings in the wall's thickness) are projected from the nearest point
    // inside it: from outside, the exit distance turns negative and the
    // lookup broke down (they rendered black).
    const p = entry.clamp(low, high)
    // Each axis picks its exit face by its own sign. select() casts its
    // condition to one bool (the x component), so a vector condition chose
    // every face by the sign of v.x: where a floor's reflection pointed to
    // -x the ray "left" through the floor and reflected the floor, cutting
    // off every reflection on that half of the screen.
    const toward = step(vec3(0), v) as Node<'vec3'>
    const magnitude = max(v.abs(), 1e-5)
    const face = low.add(high.sub(low).mul(toward))
    const planes = face.sub(p).div(magnitude.mul(toward.mul(2).sub(1)))
    // Parallel axes must not participate in the ray/box exit distance.
    // In particular, 0/0 or a signed zero can otherwise produce NaN/-Inf
    // along an entire flat surface, causing seams and unstable highlights.
    const parallel = step(v.abs(), vec3(1e-5)) as Node<'vec3'>
    const rb = planes.add(parallel.mul(1e10))
    let across: Node<'float'> = min(rb.x, rb.z)
    if (walls.length) {
      // A room that is not its box leaves through the first of its own walls
      // the ray reaches. Its box face can stand a metre past a wall (X02's
      // slanted entrance), which put that wall's doors in the floor a metre off.
      let reached: Node<'float'> = float(1e10)
      for (const [edge, run] of walls) {
        const facing = v.x.mul(edge.z).add(v.z.mul(edge.w))
        const t = edge.x.sub(p.x).mul(edge.z).add(edge.y.sub(p.z).mul(edge.w)).div(max(facing, 1e-4))
        const s = p.x.add(v.x.mul(t)).sub(edge.x).mul(run.x).add(p.z.add(v.z.mul(t)).sub(edge.y).mul(run.y))
        const hits = facing.greaterThan(1e-4).and(t.greaterThanEqual(0)).and(s.greaterThanEqual(0)).and(s.lessThanEqual(run.z))
        reached = min(reached, select(hits, t, float(1e10)))
      }
      across = select(reached.lessThan(1e9), reached, across)
    }
    const distance = max(min(across, rb.y), 0)
    const hit = p.add(v.mul(distance)).sub(probe)
    const reach = hit.length()
    const travelled = entry.sub(positionWorld).length().add(distance)
    // within limits: much sharper exposes the probe's resolution, much blurrier smears the lights
    return vec4(select(reach.greaterThan(1e-4), hit.div(reach), v), travelled.div(max(reach, 1e-3)).clamp(0.5, 2))
  })()
}

/** A probe lookup along a box projection, its blur scaled to the surface's own distance. */
function probeLookup(environment: THREE.Texture, projected: Node<'vec4'>) {
  const level = Fn((builder: NodeBuilder) => (builder.context as EnvContext).getTextureLevel().mul(projected.w))()
  return pmremTexture(environment, projected.xyz, level as Node<'float'>)
}

/** Node graph version of the baked (lightmap or volume) lighting and box-projected reflection model. */
export function patchMaterial(mat: THREE.MeshStandardMaterial, opts: { baked?: boolean; boxProject?: boolean; volume?: VolumeNodes; portals?: ReflectionPortal[]; outline?: boolean }, uniforms: EnvBoxUniforms) {
  const nodes = mat as THREE.MeshStandardMaterial & { setupLightingModel?: () => PhysicalLightingModel; envNode?: Node }
  if (opts.baked) nodes.setupLightingModel = () => new BakedLightingModel()
  else if (opts.volume) {
    const volume = opts.volume
    nodes.setupLightingModel = () => new VolumeLightingModel(volume)
  }
  if (opts.boxProject && mat.envMap) {
    const low = uniform(uniforms.envBoxMin.value), high = uniform(uniforms.envBoxMax.value), probe = uniform(uniforms.envProbePos.value)
    const room = probeLookup(mat.envMap, boxProjected(() => positionWorld, low, high, probe, opts.outline ? uniforms.envWalls : []))
    let environment = room as unknown as Node<'vec3'>
    // A ray leaving through a leafless opening goes on into the next room and
    // reflects that room, from its own probe: a continuous floor shows the next
    // room's lights, not the wall a single probe would put there.
    for (const portal of opts.portals ?? []) {
      const c = uniform(portal.center), n = uniform(portal.normal), along = uniform(portal.along)
      const crossing = (v: Node<'vec3'>) => positionWorld.add(v.mul(c.sub(positionWorld).dot(n).div(max(v.dot(n), 1e-4))))
      const next = probeLookup(portal.environment, boxProjected(crossing, uniform(portal.next.envBoxMin.value), uniform(portal.next.envBoxMax.value), uniform(portal.next.envProbePos.value), portal.next.envWalls))
      portal.lookups.add(next)
      // How much the ray crosses the opening: 1 well inside it, 0 outside, and
      // a blend across its jambs and head. The two probes saw the edge from
      // different places, so a hard switch drew every edge of the opening as a
      // line on the floor (the owner's line between the hub and the lobby); the
      // floor's own roughness blurs that edge anyway. Arithmetic, not select():
      // that would build the lookups in isolation, outside the ray's context.
      const through = Fn((builder: NodeBuilder) => {
        const v = (builder.context as EnvContext).getUV()
        if (v === normalWorld) return float(0)
        const at = crossing(v).sub(c)
        const inside = min(float(portal.halfWidth).sub(at.dot(along).abs()), float(portal.height).sub(at.y))
        return step(1e-4, v.dot(n)).mul(step(0, at.y)).mul(smoothstep(-PORTAL_EDGE, PORTAL_EDGE, inside))
      })()
      environment = mix(environment, next as unknown as Node<'vec3'>, through as Node<'float'>)
    }
    nodes.envNode = environment
    environmentNodes.set(mat, room)
    // its lighting model keeps the probe's reflection for the post pass
    mat.userData.probeSpecular = !!(opts.baked || opts.volume)
  }
  mat.needsUpdate = true
}

export function updateMaterialEnvironment(mat: THREE.MeshStandardMaterial, texture: THREE.Texture) {
  mat.envMap = texture
  const node = environmentNodes.get(mat)
  if (node) node.value = texture
}

/** 1×1 grey lightmap used until the bake arrives (keeps the shader variant stable). */
export function placeholderLightmap(level = 0.8) {
  const v = Math.round(level * 255)
  const t = new THREE.DataTexture(new Uint8Array([v, v, v, 255]), 1, 1)
  t.channel = 1
  t.needsUpdate = true
  return t
}

export interface ShellMaterials {
  wall: THREE.MeshStandardMaterial
  floor: THREE.MeshStandardMaterial
  ceiling: THREE.MeshStandardMaterial
  cove: THREE.MeshStandardMaterial
  /** lightmapped clones of casework materials, keyed by baked material key */
  casework: Record<string, THREE.MeshStandardMaterial>
  /** swap in a freshly baked lightmap */
  setLightmap: (tex: THREE.Texture) => void
  resetLightmap: () => void
  dispose: () => void
}

export function createShellMaterials(
  t: { wall: SurfaceSet; floor: SurfaceSet; ceiling: SurfaceSet },
  normalMaps: boolean,
  uniforms: EnvBoxUniforms,
  casework: Record<string, { material: THREE.Material; reflective: boolean }> = {},
  paint = '#b0aaa1',
): ShellMaterials {
  const placeholder = placeholderLightmap()
  const wall = new THREE.MeshStandardMaterial({
    // the room's paint (roomPaint): taupe grey in the labs, so the white casework stands out
    color: paint,
    map: t.wall.map,
    normalMap: normalMaps ? t.wall.normalMap ?? null : null,
    normalScale: new THREE.Vector2(0.4, 0.4),
    roughness: 0.82,
    metalness: 0,
    lightMap: placeholder,
    envMapIntensity: 0.6,
  })
  const floor = new THREE.MeshStandardMaterial({
    // a light grey terrazzo, a little darker than the speckle texture alone
    // (recalibrated once reflections showed the room, not the floor itself, and
    // again once probes stopped seeing metals lit by a bright studio fallback)
    color: '#eaeaea',
    map: t.floor.map,
    roughnessMap: t.floor.roughnessMap ?? null,
    normalMap: normalMaps ? t.floor.normalMap ?? null : null,
    // polished terrazzo: a faint ripple only, so reflections stay readable
    normalScale: new THREE.Vector2(0.04, 0.04),
    // sealed and polished: broad, blurred reflections (never wet-looking); the
    // probe's reflections are boosted since box projection softens them
    roughness: 0.15,
    metalness: 0,
    lightMap: placeholder,
    envMapIntensity: 2.4,
  })
  const ceiling = new THREE.MeshStandardMaterial({
    // near-white acoustic tiles (about 75 % reflectance; the owner's commons reference)
    color: '#d4d4d1',
    map: t.ceiling.map,
    roughness: 0.95,
    metalness: 0,
    lightMap: placeholder,
    envMapIntensity: 0.3,
  })
  // charcoal rubber cove base
  const cove = new THREE.MeshStandardMaterial({
    color: '#3d4044',
    roughness: 0.6,
    metalness: 0,
    lightMap: placeholder,
    envMapIntensity: 0.8,
  })
  patchMaterial(wall, { baked: true }, uniforms)
  patchMaterial(floor, { baked: true, boxProject: true }, uniforms)
  patchMaterial(ceiling, { baked: true }, uniforms)
  patchMaterial(cove, { baked: true, boxProject: true }, uniforms)
  const baked: Record<string, THREE.MeshStandardMaterial> = {}
  for (const [key, c] of Object.entries(casework)) {
    const m = (c.material as THREE.MeshStandardMaterial).clone()
    m.lightMap = placeholder
    patchMaterial(m, { baked: true, boxProject: c.reflective }, uniforms)
    baked[key] = m
  }
  const all = [wall, floor, ceiling, cove, ...Object.values(baked)]
  return {
    wall,
    floor,
    ceiling,
    cove,
    casework: baked,
    setLightmap(tex) {
      tex.channel = 1
      for (const m of all) m.lightMap = tex
    },
    resetLightmap() {
      const old = wall.lightMap
      for (const material of all) material.lightMap = placeholder
      if (old && old !== placeholder) old.dispose()
    },
    dispose() {
      placeholder.dispose()
      for (const m of all) {
        if (m.lightMap && m.lightMap !== placeholder) m.lightMap.dispose()
        m.dispose()
      }
    },
  }
}

/** Capture a cube probe at `pos` and prefilter it for PBR lookup. */
export function captureProbe(
  _renderer: WebGPURenderer,
  scene: THREE.Scene,
  pmrem: PMREMGenerator,
  pos: THREE.Vector3Like,
  size: number,
  far = 40,
): RenderTarget {
  return pmrem.fromScene(scene, 0, 0.05, far, { size, position: new THREE.Vector3(pos.x, pos.y, pos.z) })
}

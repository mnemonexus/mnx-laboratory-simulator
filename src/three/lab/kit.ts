// Static geometry batcher + shared material palette.
//
// Builders describe the lab with primitive calls (box, cylinder, decal…) in
// a transform stack. Everything static is merged into one mesh per material
// per room, so a fully detailed room costs ~20–30 draw calls.
import * as THREE from 'three'
import { exactIndexedGeometry } from './exactGeometry'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { DecalAtlas, DecalName } from './decals'
import type { ZoneId } from './layout'
import type { FurnitureFinishes } from './furnitureFinishes'

export type MatKey =
  | 'laminate'
  | 'worktop'
  | 'steel'
  | 'chrome'
  | 'satinSteel'
  | 'upholstery'
  | 'wovenMesh'
  | 'frame'
  | 'walnut'
  | 'plastic'
  | 'gloss'
  | 'rubber'
  | 'glass'
  | 'bottle'
  | 'liquid'
  | 'paper'
  | 'screen'
  | 'glow'
  // ceiling light panels: full radiance while room probes capture, dimmed in view
  | 'lamp'
  // soft spill of a light panel on the ceiling around it
  | 'halo'
  | 'leaf'
  | 'shadow'
  // casework lit by the room's baked lightmap (per-room material instances)
  | 'laminateBaked'
  | 'worktopBaked'
  | 'frameBaked'
  | 'glossBaked'

export type BakedKey = 'laminateBaked' | 'worktopBaked' | 'frameBaked' | 'glossBaked'
const BAKED: Partial<Record<MatKey, BakedKey>> = {
  laminate: 'laminateBaked',
  worktop: 'worktopBaked',
  frame: 'frameBaked',
  gloss: 'glossBaked',
}
const BASE: Partial<Record<MatKey, MatKey>> = {
  laminateBaked: 'laminate',
  worktopBaked: 'worktop',
  frameBaked: 'frame',
  glossBaked: 'gloss',
}

export type FaceName = '+x' | '-x' | '+y' | '-y' | '+z' | '-z'

/** A box face that gets its own lightmap island (world space). */
export interface BakeFace {
  key: string
  origin: [number, number, number]
  u: [number, number, number]
  v: [number, number, number]
  n: [number, number, number]
  wM: number
  hM: number
}
/** Metres per texture repeat for world-mapped materials. */
const UV_SCALE: Partial<Record<MatKey, number>> = {
  worktop: 1.0,
  plastic: 0.5,
  gloss: 0.5,
  frame: 1.0,
}

/** Name of the contact-shadow decal material (the post pipeline also lets it hide reflections). */
export const CONTACT_SHADOW = 'contact shadow'

/**
 * Light panels are drawn at this fraction of their radiance. It still clips to
 * white on screen but stays under the bloom threshold, so panels never haze the
 * ceiling; room probes see the full radiance (LabWorld.refreshProbe).
 */
export const LAMP_VIEW = 0.15
/** Name of the light panels' material (the post pipeline restores their radiance in reflections). */
export const LIGHT_PANEL = 'light panel'

export interface Palette {
  materials: Record<MatKey, THREE.Material>
  /** materials whose reflections should be box-projected */
  reflective: THREE.MeshStandardMaterial[]
  dispose: () => void
}

interface PaletteTextures {
  furniture?: FurnitureFinishes
  worktop: { map: THREE.Texture; roughnessMap?: THREE.Texture; normalMap?: THREE.Texture }
  walnut: THREE.Texture
  atlas: DecalAtlas
  leaf: THREE.Texture
  blob: THREE.Texture
}

export function createPalette(t: PaletteTextures, normalMaps: boolean): Palette {
  const std = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(p)
  const worktop = std({
    map: t.worktop.map,
    roughnessMap: t.worktop.roughnessMap,
    normalMap: normalMaps ? t.worktop.normalMap : null,
    normalScale: new THREE.Vector2(0.25, 0.25),
    roughness: 1,
    metalness: 0,
    vertexColors: true,
  })
  // brushed stainless: darker than paint, with clear directional highlights
  const steel = std({ color: '#c3c8cd', metalness: 1, roughness: 0.3, vertexColors: true })
  const chrome = std({ color: '#e6e9ec', metalness: 1, roughness: 0.14, vertexColors: true })
  const glass = std({
    color: '#dfe9ef',
    metalness: 0,
    roughness: 0.04,
    transparent: true,
    opacity: 0.1,
    envMapIntensity: 0.9,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const materials: Record<MatKey, THREE.Material> = {
    // flat matte white laminate: no noise, no glossy smears
    // satin white laminate: broad soft sheen, never mirror-like
    // (a touch below pure white, so lit fronts keep their falloff: look target 2026-10-27)
    laminate: std({ color: new THREE.Color(0.8, 0.8, 0.8), roughness: 0.6, metalness: 0, vertexColors: true, envMapIntensity: 0.9 }),
    worktop,
    steel,
    chrome,
    // brushed stainless (kick plates): grey with a soft sheen, not matte white
    satinSteel: std({ color:'#b4b8bb', metalness:1, roughness:.55, roughnessMap:t.furniture?.steel, vertexColors:true, envMapIntensity:1.1 }),
    upholstery: std({ roughness:.5, metalness:0, normalMap:normalMaps?t.furniture?.vinyl:null, normalScale:new THREE.Vector2(.12,.12), vertexColors:true }),
    wovenMesh: std({ color:'#292d30',map:t.furniture?.mesh,alphaTest:.45,side:THREE.DoubleSide,roughness:.65,metalness:.5,vertexColors:true }),
    frame: std({ color: '#ffffff', roughness: 0.5, metalness: 0.35, vertexColors: true }),
    // the veneer photo is warm and saturated: pull it towards a deep walnut
    // brown and give it a faint satin sheen
    walnut: std({ map: t.walnut, color: new THREE.Color(0.92, 1.12, 1.95), roughness: 0.42, metalness: 0, vertexColors: true }),
    plastic: std({ roughness: 0.5, metalness: 0, vertexColors: true }),
    // moulded instrument housings: satin, not toy-gloss
    gloss: std({ roughness: 0.34, metalness: 0, vertexColors: true }),
    // black vinyl and rubber: a soft sheen, so dark parts still show their shape
    rubber: std({ roughness: 0.62, metalness: 0, vertexColors: true }),
    glass,
    bottle: std({
      roughness: 0.12,
      metalness: 0,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      vertexColors: true,
    }),
    liquid: std({ roughness: 0.15, metalness: 0, transparent: true, opacity: 0.85, vertexColors: true }),
    paper: std({ map: t.atlas.texture, roughness: 0.82, metalness: 0, vertexColors: true }),
    screen: new THREE.MeshBasicMaterial({ map: t.atlas.texture, vertexColors: true }),
    glow: new THREE.MeshBasicMaterial({ vertexColors: true }),
    lamp: new THREE.MeshBasicMaterial({ name: LIGHT_PANEL, vertexColors: true, color: new THREE.Color(LAMP_VIEW, LAMP_VIEW, LAMP_VIEW) }),
    // a fade towards bright tile, not an additive glow: Medium blends in sRGB
    // straight to the canvas, where additive light would overshoot
    halo: new THREE.MeshBasicMaterial({ map: t.blob, vertexColors: true, transparent: true, opacity: 0.34, depthWrite: false }),
    leaf: std({ map: t.leaf, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.6, metalness: 0 }),
    // fallbacks; each room overrides these with its own lightmapped clones
    laminateBaked: null as unknown as THREE.Material,
    worktopBaked: null as unknown as THREE.Material,
    frameBaked: null as unknown as THREE.Material,
    glossBaked: null as unknown as THREE.Material,
    // The blob's falloff is in its alpha channel, so it is the map (an alphaMap
    // reads a colour channel, which is flat white: a hard-edged square).
    shadow: new THREE.MeshBasicMaterial({
      name: CONTACT_SHADOW,
      color: '#000000',
      map: t.blob,
      transparent: true,
      depthWrite: false,
      vertexColors: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  }
  materials.laminateBaked = materials.laminate
  materials.worktopBaked = materials.worktop
  materials.frameBaked = materials.frame
  materials.glossBaked = materials.gloss
  ;(materials.paper as THREE.MeshStandardMaterial).polygonOffset = true
  ;(materials.paper as THREE.MeshStandardMaterial).polygonOffsetFactor = -1
  ;(materials.paper as THREE.MeshStandardMaterial).polygonOffsetUnits = -1
  ;(materials.screen as THREE.MeshBasicMaterial).polygonOffset = true
  ;(materials.screen as THREE.MeshBasicMaterial).polygonOffsetFactor = -1
  ;(materials.screen as THREE.MeshBasicMaterial).polygonOffsetUnits = -1
  for (const m of Object.values(materials)) m.userData.shared = true
  return {
    materials,
    reflective: [worktop, steel, chrome, glass],
    dispose() {
      for (const m of new Set(Object.values(materials))) m.dispose()
    },
  }
}

export interface BoxOpts {
  color?: THREE.ColorRepresentation
  /** edge radius → rounded box */
  radius?: number
  rx?: number
  ry?: number
  rz?: number
  /** keep the geometry's own 0–1 UVs instead of world mapping */
  keepUV?: boolean
  /** faces to light from the room's baked lightmap (casework, big appliances) */
  bake?: FaceName[]
  /** with `bake` including '+y': light the top from this shared face (see sharedTop), not its own island */
  topFace?: string
}

export interface CylOpts {
  color?: THREE.ColorRepresentation
  seg?: number
  open?: boolean
  rx?: number
  ry?: number
  rz?: number
  thetaStart?: number
  thetaLength?: number
}

const tmpColor = new THREE.Color()
const tmpV = new THREE.Vector3()
const tmpN = new THREE.Vector3()
const roundedCache = new Map<string, THREE.BufferGeometry>()

function roundedBox(w: number, h: number, d: number, r: number) {
  const key = `${w.toFixed(4)}|${h.toFixed(4)}|${d.toFixed(4)}|${r.toFixed(4)}`
  let g = roundedCache.get(key)
  if (!g) {
    const procedural = new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4))
    g = exactIndexedGeometry(procedural)
    procedural.dispose()
    roundedCache.set(key, g)
  }
  return g
}

export interface ShadowSpot {
  x: number
  y: number
  z: number
  w: number
  d: number
  yaw: number
  strength: number
}

/** A merged-on-build set of primitives for one room. */
export class Batch {
  readonly zone: ZoneId
  readonly detail: 'reduced' | 'full'
  private parts = new Map<MatKey, THREE.BufferGeometry[]>()
  private stack: THREE.Matrix4[] = [new THREE.Matrix4()]
  private shadows: ShadowSpot[] = []
  private atlas: DecalAtlas
  private measurements: { inverse: THREE.Matrix4; first: THREE.Box3; bounds: THREE.Box3 }[] = []
  /** lightmap islands requested by baked boxes (a fork shares its room's list) */
  readonly bakeFaces: BakeFace[]
  /** world-space boxes (6 floats each) that shadow the room's bake: solid bodies built here */
  readonly occluders: number[] = []
  /** a fork's local frame → world, at rest; its baked faces are lit in that pose */
  private bakeWorld: THREE.Matrix4 | null
  private keyPrefix: string
  private forks = 0
  /** a moving part's fork: `bake` requests are dropped (it is lit by the room's volume) */
  private unbaked = false

  constructor(zone: ZoneId, detail: 'reduced' | 'full', atlas: DecalAtlas, bake?: { faces: BakeFace[]; world: THREE.Matrix4; prefix: string }) {
    this.zone = zone
    this.detail = detail
    this.atlas = atlas
    this.bakeFaces = bake?.faces ?? []
    this.bakeWorld = bake?.world ?? null
    this.keyPrefix = bake?.prefix ?? zone
  }

  get matrix() {
    return this.stack[this.stack.length - 1]
  }

  /**
   * Geometry for a part that moves (a drawer, a cupboard door): the room's
   * materials and atlas, but no lightmap islands. Moving parts take their light
   * from the room's irradiance volume, so it follows them as they open.
   */
  forkUnbaked() {
    const batch = new Batch(this.zone, this.detail, this.atlas)
    batch.unbaked = true
    return batch
  }

  /**
   * Independent movable geometry using this room's existing material/atlas
   * contract. Given its rest pose (`world`: local frame → world), baked boxes
   * get islands in the room's lightmap, lit as they stand at rest.
   */
  fork(world?: THREE.Matrix4) {
    const bake = world ? { faces: this.bakeFaces, world: world.clone(), prefix: `${this.keyPrefix}:m${this.forks++}` } : undefined
    return new Batch(this.zone, this.detail, this.atlas, bake)
  }

  /** Run `fn` inside a local frame translated to (x, y, z) and turned by `yaw`. */
  at(x: number, y: number, z: number, yaw: number, fn: () => void) {
    const m = new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z)
    this.stack.push(this.matrix.clone().multiply(m))
    try {
      fn()
    } finally {
      this.stack.pop()
    }
  }

  /** Like `at` with an arbitrary local matrix. */
  within(m: THREE.Matrix4, fn: () => void) {
    this.stack.push(this.matrix.clone().multiply(m))
    try {
      fn()
    } finally {
      this.stack.pop()
    }
  }

  /** Let a solid body, given as a box in the current frame, cast soft shadows in the bake. */
  occlude(box: THREE.Box3) {
    // a hair inside the body, so surfaces it rests on are not swallowed
    const w = box.clone().expandByScalar(-0.004).applyMatrix4(this.matrix)
    if (!w.isEmpty()) this.occluders.push(w.min.x, w.min.y, w.min.z, w.max.x, w.max.y, w.max.z)
  }

  measure(fn: () => void) {
    const record = { inverse:this.matrix.clone().invert(), first:new THREE.Box3(), bounds:new THREE.Box3() }
    this.measurements.push(record)
    try { fn() } finally { this.measurements.pop() }
    return { first:record.first, bounds:record.bounds }
  }

  /** Add a geometry (consumed) in the current frame. */
  add(mat: MatKey, geo: THREE.BufferGeometry, local?: THREE.Matrix4, color?: THREE.ColorRepresentation, keepUV = false, bakeKeys?: string[]) {
    const g = geo.index ? geo : withIndex(geo)
    const m = local ? this.matrix.clone().multiply(local) : this.matrix
    if (this.measurements.length && !['shadow','paper','screen','glow','lamp','halo','beyond'].includes(mat)) {
      g.computeBoundingBox()
      for (const record of this.measurements) {
        const box = g.boundingBox!.clone().applyMatrix4(record.inverse.clone().multiply(m))
        if(record.first.isEmpty()) record.first.copy(box)
        record.bounds.union(box)
      }
    }
    g.applyMatrix4(m)
    if (!g.getAttribute('normal')) g.computeVertexNormals()
    const count = g.getAttribute('position').count
    const colors = new Float32Array(count * 3)
    tmpColor.set(color ?? '#ffffff')
    for (let i = 0; i < count; i++) {
      colors[i * 3] = tmpColor.r
      colors[i * 3 + 1] = tmpColor.g
      colors[i * 3 + 2] = tmpColor.b
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const scale = UV_SCALE[BASE[mat] ?? mat]
    // clone() shares userData by reference, so always give the copy its own object
    g.userData = bakeKeys ? { bakeKeys } : {}
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2))
    if (scale && !keepUV) worldUV(g, scale)
    for (const name of Object.keys(g.attributes)) {
      if (!['position', 'normal', 'uv', 'color'].includes(name)) g.deleteAttribute(name)
    }
    g.morphAttributes = {}
    g.clearGroups()
    let list = this.parts.get(mat)
    if (!list) {
      list = []
      this.parts.set(mat, list)
    }
    list.push(g)
    return g
  }

  box(mat: MatKey, x: number, y: number, z: number, w: number, h: number, d: number, o: BoxOpts = {}) {
    if (w <= 0 || h <= 0 || d <= 0) return
    const geo = o.radius ? roundedBox(w, h, d, o.radius).clone() : new THREE.BoxGeometry(w, h, d)
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0)).setPosition(x, y, z)
    const baked = o.bake?.length && !this.unbaked ? BAKED[mat] : undefined
    if (baked) {
      const shared = o.topFace && o.bake!.includes('+y') ? o.topFace : undefined
      const keys = this.registerFaces(this.matrix.clone().multiply(m), w, h, d, shared ? o.bake!.filter((f) => f !== '+y') : o.bake!)
      if (shared) keys.push(shared)
      this.add(baked, geo, m, o.color, o.keepUV, keys)
    } else this.add(mat, geo, m, o.color, o.keepUV)
  }

  /**
   * One lightmap island for a whole worktop run's upper surface (x0..x1 × z0..z1
   * at height y, current frame). Pieces that pass it as `topFace` light from it,
   * so a top cut round a sink or split at a module reads as one continuous slab.
   */
  sharedTop(x0: number, x1: number, y: number, z0: number, z1: number) {
    const local = this.matrix.clone().multiply(new THREE.Matrix4().makeTranslation((x0 + x1) / 2, y, (z0 + z1) / 2))
    return this.registerFaces(local, x1 - x0, 0, z1 - z0, ['+y'])[0]
  }

  private faceSeq = 0

  /** World-space lightmap islands for the requested faces of a centred box. */
  private registerFaces(local: THREE.Matrix4, w: number, h: number, d: number, faces: FaceName[]) {
    const world = this.bakeWorld ? this.bakeWorld.clone().multiply(local) : local
    const defs: Record<FaceName, { o: [number, number, number]; u: [number, number, number]; v: [number, number, number]; n: [number, number, number]; size: [number, number] }> = {
      '+z': { o: [-w / 2, -h / 2, d / 2], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1], size: [w, h] },
      '-z': { o: [w / 2, -h / 2, -d / 2], u: [-1, 0, 0], v: [0, 1, 0], n: [0, 0, -1], size: [w, h] },
      '+x': { o: [w / 2, -h / 2, d / 2], u: [0, 0, -1], v: [0, 1, 0], n: [1, 0, 0], size: [d, h] },
      '-x': { o: [-w / 2, -h / 2, -d / 2], u: [0, 0, 1], v: [0, 1, 0], n: [-1, 0, 0], size: [d, h] },
      '+y': { o: [-w / 2, h / 2, d / 2], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0], size: [w, d] },
      '-y': { o: [-w / 2, -h / 2, -d / 2], u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0], size: [w, d] },
    }
    const keys: string[] = []
    for (const f of faces) {
      const def = defs[f]
      const o = new THREE.Vector3(...def.o).applyMatrix4(world)
      const u = new THREE.Vector3(...def.u).transformDirection(world)
      const v = new THREE.Vector3(...def.v).transformDirection(world)
      const n = new THREE.Vector3(...def.n).transformDirection(world)
      const key = `${this.keyPrefix}:f${this.faceSeq++}`
      this.bakeFaces.push({ key, origin: o.toArray(), u: u.toArray(), v: v.toArray(), n: n.toArray(), wM: def.size[0], hM: def.size[1] })
      keys.push(key)
    }
    return keys
  }

  /**
   * Give every baked geometry lightmap coordinates: each vertex is projected
   * onto the island of the face its normal points along most. A fork's
   * vertices are taken to world space in its rest pose first.
   */
  assignLightmapUVs(place: (key: string) => { x: number; y: number }, texel: number, W: number, H: number) {
    const faces = new Map(this.bakeFaces.map((f) => [f.key, f]))
    const p = new THREE.Vector3()
    const n = new THREE.Vector3()
    for (const [mat, list] of this.parts) {
      if (!BASE[mat]) continue
      for (const g of list) {
        const keys = g.userData.bakeKeys as string[]
        const pos = g.getAttribute('position') as THREE.BufferAttribute
        const nor = g.getAttribute('normal') as THREE.BufferAttribute
        const uv1 = new Float32Array(pos.count * 2)
        const fs = keys.map((k) => ({ f: faces.get(k)!, p: place(k) }))
        for (let i = 0; i < pos.count; i++) {
          p.fromBufferAttribute(pos, i)
          n.fromBufferAttribute(nor, i)
          if (this.bakeWorld) {
            p.applyMatrix4(this.bakeWorld)
            n.transformDirection(this.bakeWorld)
          }
          const px = p.x
          const py = p.y
          const pz = p.z
          const nx = n.x
          const ny = n.y
          const nz = n.z
          let best = fs[0]
          let bestDot = -Infinity
          for (const c of fs) {
            const dot = nx * c.f.n[0] + ny * c.f.n[1] + nz * c.f.n[2]
            if (dot > bestDot) {
              bestDot = dot
              best = c
            }
          }
          const dx = px - best.f.origin[0]
          const dy = py - best.f.origin[1]
          const dz = pz - best.f.origin[2]
          const s = Math.min(best.f.wM, Math.max(0, dx * best.f.u[0] + dy * best.f.u[1] + dz * best.f.u[2]))
          const t = Math.min(best.f.hM, Math.max(0, dx * best.f.v[0] + dy * best.f.v[1] + dz * best.f.v[2]))
          uv1[i * 2] = (best.p.x + s / texel) / W
          uv1[i * 2 + 1] = (best.p.y + t / texel) / H
        }
        g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2))
      }
    }
  }

  /** Box spanning min → max in the current frame. */
  span(mat: MatKey, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, o: BoxOpts = {}) {
    this.box(mat, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), o)
  }

  cyl(mat: MatKey, x: number, y: number, z: number, rTop: number, rBot: number, h: number, o: CylOpts = {}) {
    const seg = o.seg ?? (this.detail === 'full' ? 20 : 12)
    const geo = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, o.open ?? false, o.thetaStart ?? 0, o.thetaLength ?? Math.PI * 2)
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0)).setPosition(x, y, z)
    this.add(mat, geo, m, o.color)
  }

  /** Horizontal bar between two points (pull handles, rails, pipes). */
  rod(mat: MatKey, a: THREE.Vector3Like, b: THREE.Vector3Like, r: number, color?: THREE.ColorRepresentation, seg = 10) {
    const va = new THREE.Vector3(a.x, a.y, a.z)
    const vb = new THREE.Vector3(b.x, b.y, b.z)
    const len = va.distanceTo(vb)
    if (len < 1e-5) return
    const geo = new THREE.CylinderGeometry(r, r, len, seg, 1, false)
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize())
    const m = new THREE.Matrix4().compose(va.add(vb).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1))
    this.add(mat, geo, m, color)
  }

  sphere(mat: MatKey, x: number, y: number, z: number, r: number, color?: THREE.ColorRepresentation, sy = 1) {
    const geo = new THREE.SphereGeometry(r, this.detail === 'full' ? 16 : 10, this.detail === 'full' ? 10 : 6)
    const m = new THREE.Matrix4().makeScale(1, sy, 1).setPosition(x, y, z)
    this.add(mat, geo, m, color)
  }

  lathe(mat: MatKey, points: [number, number][], x: number, y: number, z: number, color?: THREE.ColorRepresentation, seg?: number) {
    const geo = new THREE.LatheGeometry(
      points.map(([r, h]) => new THREE.Vector2(r, h)),
      seg ?? (this.detail === 'full' ? 18 : 10),
    )
    this.add(mat, geo, new THREE.Matrix4().makeTranslation(x, y, z), color)
  }

  tube(mat: MatKey, pts: THREE.Vector3[], r: number, color?: THREE.ColorRepresentation) {
    const curve = new THREE.CatmullRomCurve3(pts)
    const geo = new THREE.TubeGeometry(curve, Math.max(8, pts.length * 6), r, 6, false)
    this.add(mat, geo, undefined, color)
  }

  /** Plane facing local +z. */
  plane(mat: MatKey, x: number, y: number, z: number, w: number, h: number, ry = 0, color?: THREE.ColorRepresentation, rx = 0) {
    const geo = new THREE.PlaneGeometry(w, h)
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, 0)).setPosition(x, y, z)
    this.add(mat, geo, m, color, true)
  }

  /** Atlas decal facing local +z: `paper` for lit print, `screen` for emissive. */
  decal(name: DecalName, x: number, y: number, z: number, w: number, h: number, ry = 0, kind: 'paper' | 'screen' = 'paper', brightness = 1, rx = 0) {
    const geo = new THREE.PlaneGeometry(w, h)
    const [u0, v0, u1, v1] = this.atlas.uv(name)
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) ? u1 : u0, uv.getY(i) ? v1 : v0)
    }
    this.placeDecal(geo, x, y, z, ry, kind, brightness, rx)
  }

  /** A round atlas decal (a clock face): an exact disc, so no square corners show past its bezel. */
  roundDecal(name: DecalName, x: number, y: number, z: number, diameter: number, kind: 'paper' | 'screen' = 'paper', brightness = 1) {
    const geo = new THREE.CircleGeometry(diameter / 2, 48)
    const [u0, v0, u1, v1] = this.atlas.uv(name)
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + (u1 - u0) * uv.getX(i), v0 + (v1 - v0) * uv.getY(i))
    this.placeDecal(geo, x, y, z, 0, kind, brightness, 0)
  }

  private placeDecal(geo: THREE.BufferGeometry, x: number, y: number, z: number, ry: number, kind: 'paper' | 'screen', brightness: number, rx: number) {
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, 0)).setPosition(x, y, z)
    const c = new THREE.Color(brightness, brightness, brightness)
    this.add(kind, geo, m, c, true)
  }

  /** Soft contact shadow on a horizontal surface, in the current frame. */
  shadow(x: number, y: number, z: number, w: number, d: number, strength = 0.55, yaw = 0) {
    const p = new THREE.Vector3(x, y, z).applyMatrix4(this.matrix)
    const e = new THREE.Euler().setFromRotationMatrix(this.matrix)
    this.shadows.push({ x: p.x, y: p.y + 0.0015, z: p.z, w: w * 1.04, d: d * 1.04, yaw: e.y + yaw, strength: Math.min(1, strength * 0.9) })
    this.shadows.push({ x: p.x, y: p.y + 0.0012, z: p.z, w: w * 1.55, d: d * 1.55, yaw: e.y + yaw, strength: strength * 0.45 })
  }

  /** Merge everything into one mesh per material. */
  build(palette: Palette, name: string, overrides: Partial<Record<MatKey, THREE.Material>> = {}) {
    const group = new THREE.Group()
    group.name = name
    const meshes: { mat: MatKey; mesh: THREE.Mesh }[] = []
    for (const [mat, list] of this.parts) {
      if (!list.length) continue
      const merged = mergeGeometries(list, false)
      list.forEach((g) => g.dispose())
      if (!merged) continue
      merged.computeBoundingSphere()
      merged.computeBoundingBox()
      const material = overrides[mat] ?? palette.materials[mat]
      const mesh = new THREE.Mesh(merged, material)
      mesh.name = `${name}:${mat}`
      mesh.matrixAutoUpdate = false
      const opaque = !material.transparent && mat !== 'glow' && mat !== 'lamp' && mat !== 'halo' && mat !== 'screen'
      mesh.castShadow = opaque
      mesh.receiveShadow = opaque
      group.add(mesh)
      meshes.push({ mat, mesh })
    }
    if (this.shadows.length) {
      const geos = this.shadows.map((s) => {
        const g = new THREE.PlaneGeometry(s.w, s.d)
        g.rotateX(-Math.PI / 2)
        g.rotateY(s.yaw)
        g.translate(s.x, s.y, s.z)
        const n = g.getAttribute('position').count
        const col = new Float32Array(n * 4)
        for (let i = 0; i < n; i++) col.set([1, 1, 1, s.strength], i * 4)
        g.setAttribute('color', new THREE.BufferAttribute(col, 4))
        return g
      })
      const merged = mergeGeometries(geos, false)
      geos.forEach((g) => g.dispose())
      if (merged) {
        const mesh = new THREE.Mesh(merged, palette.materials.shadow)
        mesh.name = `${name}:shadows`
        mesh.matrixAutoUpdate = false
        mesh.renderOrder = 1
        group.add(mesh)
      }
    }
    this.parts.clear()
    this.shadows = []
    return { group, meshes }
  }
}

function withIndex(g: THREE.BufferGeometry) {
  const n = g.getAttribute('position').count
  const idx = new Uint32Array(n)
  for (let i = 0; i < n; i++) idx[i] = i
  g.setIndex(new THREE.BufferAttribute(idx, 1))
  return g
}

/** Box-project world positions onto UVs (consistent texel density everywhere). */
function worldUV(g: THREE.BufferGeometry, scale: number) {
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  const nor = g.getAttribute('normal') as THREE.BufferAttribute
  const uv = g.getAttribute('uv') as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    tmpV.fromBufferAttribute(pos, i)
    tmpN.fromBufferAttribute(nor, i)
    const ax = Math.abs(tmpN.x)
    const ay = Math.abs(tmpN.y)
    const az = Math.abs(tmpN.z)
    if (ay >= ax && ay >= az) uv.setXY(i, tmpV.x / scale, tmpV.z / scale)
    else if (ax >= az) uv.setXY(i, tmpV.z / scale, tmpV.y / scale)
    else uv.setXY(i, tmpV.x / scale, tmpV.y / scale)
  }
  uv.needsUpdate = true
}

// Laboratory models retain their original metre-based reference proportions:
// an SBS microplate is modelled at 127.76 x 85.48 mm, a 1.5 mL tube at 39 mm
// tall, and a P200 at 240 mm long. Coordinates are stored as scene units;
// use ./units for calibrated spatial display values without resizing models.
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import type { LabState } from '../sim/model'
import { wellId } from '../sim/rng'
import { perforatedDeck, vesselGeometry, rotorSocket, shadeVesselInterior, instrumentCasingGeometry, loadingPanelGeometry, rotorCrownGeometry, beakerGeometry, wasteBodyGeometry, pipetteHousingGeometry, pipetteFingerRestGeometry, pipetteGripGeometry, pipetteButtonGeometry, pipetteTipGeometry, reagentVialGeometry } from './equipmentGeometry'
import { mergeStaticMeshes } from './lab/optimize'
import {
  benchSurface,
  brandTexture,
  brushedMetal,
  floorSurface,
  mouldedPlastic,
  reagentLabel,
  screenTexture,
  glasswareMarkings,
} from './textures'

export const MM = 0.001
export const BENCH_H = 0.9 // standard lab bench height

// ── SBS / ANSI microplate standard ───────────────────────────────────────
const PLATE_L = 127.76 * MM
const PLATE_W = 85.48 * MM
const PLATE_H = 14.35 * MM
const WELL_PITCH = 9 * MM
const WELL_TOP_D = 6.9 * MM

export interface PickPayload {
  kind: 'tube' | 'well' | 'instrument'
  id: string
}

export interface PlateHandle {
  group: THREE.Group
  cavities: THREE.InstancedMesh
  liquids: THREE.InstancedMesh
  wellIds: string[]
  wellLocalPos: THREE.Vector3[]
  refresh: (lab?: LabState) => void
}

// ── material helpers ─────────────────────────────────────────────────────
export function pbr(params: THREE.MeshPhysicalMaterialParameters) {
  // Always MeshStandardMaterial: the Physical shader is several times larger,
  // which matters most for start-up compile time (D3D/ANGLE compiles are slow).
  // A strong clear coat is approximated by a slightly glossier base layer.
  const coat = params.clearcoat ?? 0
  const {
    clearcoat: _clearcoat,
    clearcoatRoughness: _clearcoatRoughness,
    transmission: _transmission,
    thickness: _thickness,
    ior: _ior,
    attenuationColor: _attenuationColor,
    attenuationDistance: _attenuationDistance,
    sheen: _sheen,
    iridescence: _iridescence,
    ...standard
  } = params
  if (coat > 0.5 && standard.roughness !== undefined) standard.roughness *= 1 - 0.3 * coat
  if ((_transmission ?? 0) > 0 && !standard.transparent) {
    standard.transparent = true
    standard.opacity = Math.min(standard.opacity ?? 1, 1 - (_transmission ?? 0) * 0.6)
  }
  return new THREE.MeshStandardMaterial({ envMapIntensity: 1.05, ...standard })
}

export function plasticMat(tint: string, opts: THREE.MeshPhysicalMaterialParameters = {}) {
  const t = mouldedPlastic(tint)
  return pbr({
    map: t.map,
    normalMap: t.normalMap,
    normalScale: new THREE.Vector2(0.35, 0.35),
    roughness: 0.48,
    metalness: 0.02,
    clearcoat: 0.5,
    clearcoatRoughness: 0.32,
    ...opts,
  })
}

export function metalMat(color = '#c3c7cc', roughness = 0.34) {
  const t = brushedMetal()
  return pbr({
    color,
    metalness: 0.95,
    roughness,
    roughnessMap: t.roughnessMap,
    normalMap: t.normalMap,
    normalScale: new THREE.Vector2(0.28, 0.28),
  })
}

/**
 * Fast lab glass. Full screen-space transmission looks attractive in isolation,
 * but each transmissive material asks Three to render the background again.
 * Small tubes therefore use a thin, reflective dielectric shell instead: more
 * legible edges, better performance, and more realistic polypropylene haze.
 */
export function glassMat(tint = '#ffffff', thickness = 0.0016, rough = 0.06) {
  void thickness
  return new THREE.MeshStandardMaterial({
    color: tint,
    transparent: true,
    opacity: 0.32,
    roughness: Math.max(0.08, rough),
    metalness: 0.02,
    envMapIntensity: 1.6,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
}

export function liquidMat(color: string) {
  return new THREE.MeshStandardMaterial({
    color,
    transparent: true,
    opacity: 0.88,
    roughness: 0.08,
    metalness: 0,
    envMapIntensity: 1.25,
    depthWrite: true,
  })
}

/** What the simulation says a vessel's contents look like (see SampleLook). */
export interface VesselLook {
  clarity: number
  sediment?: { colour: string; fraction: number }
  bubbling: number
}

const BUBBLES = 14
// Gas bubbles: glossy and opaque, drawn before the (transparent) liquid so they show through its tint.
const bubbleMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.05, metalness: 0, envMapIntensity: 2.2 })

/**
 * Sediment and bubbles for a vessel's liquid, created when first needed. `update` follows the
 * simulation's look; `animate` lifts the bubbles and reports whether any are moving.
 */
function vesselEffects(g: THREE.Group, o: { bottomY: number; height: number; sedimentRadii: [number, number]; spread: number; bubbleRadius: number; shape?: (top: number) => THREE.BufferGeometry }) {
  let sediment: THREE.Mesh | undefined
  let sedimentTop = -1
  let bubbles: THREE.InstancedMesh | undefined
  let vigour = 0
  let surface = 0
  const m = new THREE.Matrix4()
  const update = (look: VesselLook | undefined, liquidHeight: number) => {
    surface = liquidHeight
    const sed = look?.sediment
    if (sed && sed.fraction > 0) {
      sediment ??= (() => {
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(o.sedimentRadii[0], o.sedimentRadii[1], 1, 20), new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 }))
        g.add(mesh)
        return mesh
      })()
      // A visible layer however little lies there (a ribbon, a pinch of deposit).
      const h = Math.max(1.2 * MM, Math.min(liquidHeight, sed.fraction * liquidHeight))
      if (o.shape) {
        // In the vessel's own shape (a flask's sloping wall, a tube's round bottom).
        if (Math.abs(o.bottomY + h - sedimentTop) > 0.05 * MM) {
          sediment.geometry.dispose()
          sediment.geometry = o.shape(o.bottomY + h)
          sedimentTop = o.bottomY + h
        }
      } else {
        sediment.scale.y = h
        sediment.position.y = o.bottomY + h / 2
      }
      ;(sediment.material as THREE.MeshStandardMaterial).color.set(sed.colour)
      sediment.visible = true
    } else if (sediment) sediment.visible = false
    vigour = look && liquidHeight > 1 * MM ? look.bubbling : 0
    if (vigour > 0.02) {
      bubbles ??= (() => {
        const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(o.bubbleRadius, 8, 6), bubbleMat, BUBBLES)
        mesh.frustumCulled = false
        g.add(mesh)
        return mesh
      })()
    }
    if (bubbles) bubbles.visible = vigour > 0.02
  }
  // Bubbles rise from the bottom to the surface, more of them and faster the harder it fizzes.
  const animate = (t: number) => {
    if (!bubbles || !bubbles.visible) return false
    const count = Math.max(1, Math.ceil(BUBBLES * vigour))
    bubbles.count = count
    for (let i = 0; i < count; i++) {
      const a = Math.sin(i * 12.9898) * 43758.5453
      const r1 = a - Math.floor(a)
      const r2 = (i * 0.618034) % 1
      const phase = (t * (0.6 + 0.8 * vigour) * (0.8 + 0.4 * r1) + r2) % 1
      const angle = r1 * Math.PI * 2
      const radius = o.spread * Math.sqrt(r2)
      m.makeTranslation(Math.cos(angle) * radius, o.bottomY + phase * Math.max(0, surface - o.bubbleRadius), Math.sin(angle) * radius)
      bubbles.setMatrixAt(i, m)
    }
    bubbles.instanceMatrix.needsUpdate = true
    return true
  }
  return { update, animate }
}

/**
 * The liquid's opacity: the bench's usual 0.88 where the simulation gives no look; otherwise a clear
 * liquid is see-through (more opaque the darker its colour) and a cloudy one opaque.
 */
const lumColour = new THREE.Color()
function liquidOpacity(look: VesselLook | undefined, tint: string) {
  if (!look) return 0.88
  lumColour.set(tint)
  const dark = 1 - (0.2126 * lumColour.r + 0.7152 * lumColour.g + 0.0722 * lumColour.b)
  const clear = 0.18 + 0.6 * Math.max(0, Math.min(1, dark))
  return clear + (0.97 - clear) * (1 - Math.max(0, Math.min(1, look.clarity)))
}

function labelPlane(tex: THREE.Texture, w: number, h: number) {
  return new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }),
  )
}

function shadowed(m: THREE.Object3D) {
  m.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.isMesh) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const transparent = mats.some((mat) => mat?.transparent)
      // Transparent walls and tiny liquid volumes do not produce useful shadow
      // silhouettes, but are expensive in the shadow pass.
      mesh.castShadow = !transparent
      mesh.receiveShadow = !transparent
    }
  })
  return m
}

// ── environment ──────────────────────────────────────────────────────────
export function buildRoom(scene: THREE.Scene) {
  const f = floorSurface()
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 24),
    pbr({ map: f.map, roughnessMap: f.roughnessMap, roughness: 0.42, metalness: 0.02, clearcoat: 0.55, clearcoatRoughness: 0.35 }),
  )
  floor.rotation.x = -Math.PI / 2
  floor.receiveShadow = true
  scene.add(floor)

  // Richer contrasting back wall (slate / lab cabinetry tile tone) so white instruments pop cleanly
  const wallMat = pbr({ color: '#334155', roughness: 0.68, metalness: 0.12 })
  const back = new THREE.Mesh(new THREE.PlaneGeometry(24, 3.6), wallMat)
  back.position.set(0, 1.6, -2.6)
  back.receiveShadow = true
  scene.add(back)

  // Lower splashback tile panel running right behind the bench
  const splashMat = pbr({ color: '#1e293b', roughness: 0.3, metalness: 0.2, clearcoat: 0.6 })
  const splash = new THREE.Mesh(new THREE.PlaneGeometry(24, 0.95), splashMat)
  splash.position.set(0, BENCH_H + 0.4, -2.58)
  splash.receiveShadow = true
  scene.add(splash)

  const left = new THREE.Mesh(new THREE.PlaneGeometry(6, 3.6), wallMat)
  left.rotation.y = Math.PI / 2
  left.position.set(-4.2, 1.6, 0.4)
  scene.add(left)

  // Architectural glass divider windows (frosted lab glass, not washed-out white)
  const winMat = new THREE.MeshBasicMaterial({ color: '#38bdf8', transparent: true, opacity: 0.15, toneMapped: false })
  for (let i = -2; i <= 2; i++) {
    const win = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.25), winMat)
    win.position.set(i * 1.75, 2.1, -2.57)
    scene.add(win)
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 1.35, 0.04),
      pbr({ color: '#475569', roughness: 0.35, metalness: 0.7 }),
    )
    frame.position.set(i * 1.75, 2.1, -2.59)
    scene.add(frame)
  }

  // Upper wall casework / storage units in deep modern lab grey
  const cab = pbr({ color: '#1e293b', roughness: 0.45, metalness: 0.2, clearcoat: 0.4 })
  for (let i = -1; i <= 1; i++) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.6, 0.34), cab)
    box.position.set(i * 1.25 + 1.9, 2.15, -2.4)
    shadowed(box)
    scene.add(box)
  }
}

export function buildBench(scene: THREE.Scene, width = 3.4, depth = 0.75) {
  const b = benchSurface()
  const group = new THREE.Group()

  const top = new THREE.Mesh(
    new THREE.BoxGeometry(width, 0.035, depth),
    pbr({
      map: b.map,
      normalMap: b.normalMap,
      roughnessMap: b.roughnessMap,
      normalScale: new THREE.Vector2(0.5, 0.5),
      roughness: 0.62,
      metalness: 0.04,
      clearcoat: 0.25,
      clearcoatRoughness: 0.6,
    }),
  )
  top.position.set(0, BENCH_H - 0.0175, 0)
  group.add(top)

  const cabinetMat = pbr({ color: '#f1f4f8', roughness: 0.5, metalness: 0.05, clearcoat: 0.35 })
  const carcass = new THREE.Mesh(new THREE.BoxGeometry(width - 0.1, BENCH_H - 0.13, depth - 0.08), cabinetMat)
  carcass.position.set(0, (BENCH_H - 0.13) / 2 + 0.1, -0.02)
  group.add(carcass)

  // drawer fronts + handles
  const handleMat = metalMat('#aeb6bf', 0.3)
  for (let i = -1; i <= 1; i++) {
    for (let r = 0; r < 3; r++) {
      const d = new THREE.Mesh(
        new THREE.BoxGeometry(width / 3.4, 0.2, 0.012),
        pbr({ color: '#e6ebf1', roughness: 0.45, metalness: 0.06, clearcoat: 0.5 }),
      )
      d.position.set(i * (width / 3.2), 0.28 + r * 0.22, depth / 2 - 0.045)
      group.add(d)
      const h = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, width / 5, 12), handleMat)
      h.rotation.z = Math.PI / 2
      h.position.set(i * (width / 3.2), 0.35 + r * 0.22, depth / 2 - 0.03)
      group.add(h)
    }
  }

  const kick = new THREE.Mesh(new THREE.BoxGeometry(width - 0.1, 0.1, depth - 0.14), pbr({ color: '#94a3b8', roughness: 0.7 }))
  kick.position.set(0, 0.05, -0.03)
  group.add(kick)

  shadowed(group)
  scene.add(group)
  return group
}

// ── consumables ──────────────────────────────────────────────────────────
/** 1.5 mL microcentrifuge tube: 39 mm tall, 10.8 mm body. */
export function buildMicroTube(color: string, fill01: number, capColor = '#2f6fd0') {
  const g = new THREE.Group()
  const bodyH = 20 * MM
  const coneH = 17 * MM
  const rTop = 5.4 * MM
  const rBot = 1.7 * MM

  const wall = glassMat('#f4f8ff', 0.0012, 0.05)
  const body = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rTop, bodyH, 32, 1, true), wall)
  body.position.y = coneH + bodyH / 2
  g.add(body)
  const cone = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, coneH, 32, 1, true), wall)
  cone.position.y = coneH / 2
  g.add(cone)
  const rim = new THREE.Mesh(new THREE.TorusGeometry(rTop, 0.6 * MM, 8, 32), plasticMat('#e8eefb'))
  rim.rotation.x = Math.PI / 2
  rim.position.y = coneH + bodyH
  g.add(rim)

  // A unit-height liquid mesh can be rescaled without rebuilding geometry.
  const liq = new THREE.Mesh(
    new THREE.CylinderGeometry(rTop * 0.93, rBot * 1.4, 1, 24),
    liquidMat(color),
  )
  const effects = vesselEffects(g, { bottomY: 1.5 * MM, height: (coneH + bodyH) * 0.9, sedimentRadii: [rBot * 1.35, rBot * 1.1], spread: rBot * 1.2, bubbleRadius: 0.45 * MM })
  const setFill = (v: number, tint = color, look?: VesselLook) => {
    const fh = Math.max(0.2 * MM, v * (coneH + bodyH) * 0.9)
    liq.visible = v > 0.01
    liq.scale.y = fh
    liq.position.y = fh / 2 + 1.5 * MM
    const mat = liq.material as THREE.MeshStandardMaterial
    mat.color.set(tint)
    mat.opacity = liquidOpacity(look, tint)
    effects.update(look, liq.visible ? fh : 0)
  }
  setFill(fill01)
  g.add(liq)
  g.userData.animate = effects.animate

  const cap = new THREE.Mesh(new THREE.CylinderGeometry(6.2 * MM, 6.2 * MM, 4.5 * MM, 32), plasticMat(capColor, { clearcoat: 0.8 }))
  cap.position.y = coneH + bodyH + 2.4 * MM
  g.add(cap)
  const hinge = new THREE.Mesh(new THREE.BoxGeometry(2 * MM, 3 * MM, 1.4 * MM), plasticMat(capColor))
  hinge.position.set(6 * MM, coneH + bodyH + 1 * MM, 0)
  g.add(hinge)

  g.userData.liquid = liq
  g.userData.setFill = setFill

  return shadowed(g) as THREE.Group
}

// ── glassware for a practical's own vessels ───────────────────────────────
/** Vessel shapes the Practicals bench draws for the learner's containers. */
export type GlassShape = 'beaker' | 'conical-flask' | 'round-bottom-flask' | 'volumetric-flask' | 'conical-tube' | 'test-tube' | 'boiling-tube' | 'cup' | 'cuvette'

interface GlassProfile {
  /** Inner wall, bottom centre upwards: [radius, height] in mm (a shape; scaled to the vessel's capacity). */
  inner: Array<[number, number]>
  wall: number
  material: 'glass' | 'plastic' | 'foam'
  /** Height (mm) the capacity is measured to (a volumetric flask's mark); else the brim. */
  mark?: number
  cap?: string
}

function arc(cy: number, r: number, from: number, to: number, n: number): Array<[number, number]> {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = from + ((to - from) * i) / n
    return [r * Math.cos(a), cy + r * Math.sin(a)] as [number, number]
  })
}

const GLASS_PROFILES: Record<Exclude<GlassShape, 'cuvette'>, GlassProfile> = {
  beaker: { inner: [[0, 2], [25, 2], [25, 72]], wall: 1.6, material: 'glass' },
  'conical-flask': { inner: [[0, 2], [31, 2], [31, 6], [11, 82], [11, 107]], wall: 1.4, material: 'glass' },
  'round-bottom-flask': { inner: [...arc(31, 29, -Math.PI / 2, Math.acos(9 / 29), 14), [9, 104]], wall: 1.3, material: 'glass' },
  'volumetric-flask': { inner: [[0, 2], [26, 2], [30, 14], [30, 30], [22, 50], [10, 62], [6, 70], [6, 175]], wall: 1.2, material: 'glass', mark: 140 },
  'conical-tube': { inner: [[0, 2], [2, 4], [7.5, 22], [7.5, 118]], wall: 0.9, material: 'plastic', cap: '#2f6fd0' },
  'test-tube': { inner: [...arc(9, 7, -Math.PI / 2, 0, 8), [7, 150]], wall: 1, material: 'glass' },
  'boiling-tube': { inner: [...arc(13.5, 11.5, -Math.PI / 2, 0, 8), [11.5, 150]], wall: 1.2, material: 'glass' },
  cup: { inner: [[0, 3], [27, 3], [38, 90]], wall: 3, material: 'foam' },
}

/** The profile's radius at a height (mm), linearly between its points. */
function radiusAt(inner: Array<[number, number]>, y: number) {
  if (y <= inner[0][1]) return inner[0][0]
  for (let i = 1; i < inner.length; i++) {
    const [r1, y1] = inner[i]
    const [r0, y0] = inner[i - 1]
    if (y <= y1) return y1 > y0 ? r0 + ((r1 - r0) * (y - y0)) / (y1 - y0) : r1
  }
  return inner[inner.length - 1][0]
}

/** A lathe of the inner wall from the bottom to height h, closed top and bottom (liquid, sediment). */
function filledLathe(inner: Array<[number, number]>, h: number, segments: number) {
  const pts = [new THREE.Vector2(0, inner[0][1])]
  for (const [r, y] of inner) {
    if (y >= h) break
    if (r > 0) pts.push(new THREE.Vector2(r * 0.985, y))
  }
  pts.push(new THREE.Vector2(radiusAt(inner, h) * 0.985, h), new THREE.Vector2(0, h))
  return new THREE.LatheGeometry(pts, segments)
}

/**
 * A learner's vessel in its own glassware (beaker, conical flask, tubes, a polystyrene cup, a
 * cuvette), scaled so that its volume matches the container's capacity. `setContents` draws the
 * liquid at the height its volume reaches in that shape, with the simulation's look.
 */
export function buildGlassVessel(shape: GlassShape, capacityMl: number, detail: 'full' | 'reduced' = 'full') {
  const g = new THREE.Group()
  g.name = `vessel:${shape}`
  const segments = detail === 'reduced' ? 16 : 36
  const liquidMaterial = liquidMat('#ffffff')
  const liquid = new THREE.Mesh(new THREE.BufferGeometry(), liquidMaterial)
  liquid.visible = false
  g.add(liquid)
  if (shape === 'cuvette') {
    // A square polystyrene cuvette, 12.5 mm outside, 10 mm path, filled from the bottom.
    const wall = new THREE.Mesh(new THREE.BoxGeometry(12.5 * MM, 45 * MM, 12.5 * MM), glassMat('#f4f8ff', 0.001, 0.05))
    wall.position.y = 22.5 * MM
    g.add(wall)
    liquid.geometry = new THREE.BoxGeometry(10 * MM, 1, 10 * MM)
    const effects = vesselEffects(g, { bottomY: 1.5 * MM, height: 42 * MM, sedimentRadii: [4.5 * MM, 4.5 * MM], spread: 3 * MM, bubbleRadius: 0.35 * MM })
    g.userData.setContents = (volumeMl: number, tint: string, look?: VesselLook) => {
      const h = Math.min(42 * MM, (volumeMl * 1e-6) / (0.01 * 0.01))
      liquid.visible = h > 0.3 * MM
      liquid.scale.y = Math.max(h, 1e-5)
      liquid.position.y = 1.5 * MM + h / 2
      liquidMaterial.color.set(tint)
      liquidMaterial.opacity = liquidOpacity(look, tint)
      effects.update(look, liquid.visible ? h : 0)
    }
    g.userData.animate = effects.animate
    g.userData.liquid = liquid
    return shadowed(g) as THREE.Group
  }
  const p = GLASS_PROFILES[shape]
  // Scale the shape so that the volume up to the brim (or the mark) is the container's capacity.
  const volumeTo = (inner: Array<[number, number]>, h: number) => {
    let v = 0
    for (let y = inner[0][1]; y < h; y += 0.25) v += Math.PI * radiusAt(inner, y) ** 2 * 0.25
    return v / 1000
  }
  const top = p.inner[p.inner.length - 1][1]
  const s = Math.cbrt(Math.max(0.05, capacityMl) / volumeTo(p.inner, p.mark ?? top))
  const inner = p.inner.map(([r, y]) => [r * s * MM, y * s * MM] as [number, number])
  const wall = p.wall * MM
  const outer = [[0, inner[0][1] - wall] as [number, number], ...inner.filter(([r]) => r > 0).map(([r, y]) => [r + wall, y] as [number, number])]
  const shellMat = p.material === 'foam'
    ? new THREE.MeshStandardMaterial({ color: '#f4f4f1', roughness: 0.95, metalness: 0 })
    : p.material === 'plastic' ? glassMat('#f6f8fb', 0.001, 0.12) : glassMat('#f4f8ff', 0.0015, 0.05)
  // Borosilicate glass is clearer than a tube's polypropylene haze.
  if (p.material === 'glass') (shellMat as THREE.MeshStandardMaterial).opacity = 0.16
  const shell = new THREE.Mesh(new THREE.LatheGeometry(outer.map(([r, y]) => new THREE.Vector2(r, y)), segments), shellMat)
  g.add(shell)
  const rimR = inner[inner.length - 1][0] + wall / 2
  const rim = new THREE.Mesh(new THREE.TorusGeometry(rimR, wall * 0.7, 8, segments), p.material === 'foam' ? shellMat : glassMat('#ffffff', 0.001, 0.04))
  rim.rotation.x = Math.PI / 2
  rim.position.y = inner[inner.length - 1][1]
  g.add(rim)
  if (p.mark) {
    const markY = p.mark * s * MM
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radiusAt(inner, markY) + wall * 1.05, 0.25 * MM, 6, segments), new THREE.MeshBasicMaterial({ color: '#3b4248' }))
    ring.rotation.x = Math.PI / 2
    ring.position.y = markY
    g.add(ring)
  }
  if (p.cap) {
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(rimR + 1.2 * MM, rimR + 1.2 * MM, 11 * MM, segments), plasticMat(p.cap, { clearcoat: 0.6 }))
    cap.position.y = inner[inner.length - 1][1] + 4 * MM
    g.add(cap)
  }
  // Volume to height through the shape, tabulated once.
  const bottom = inner[0][1]
  const table: Array<[number, number]> = [[0, bottom]]
  let v = 0
  const step = 0.25 * MM
  for (let y = bottom; y < inner[inner.length - 1][1]; y += step) {
    v += Math.PI * radiusAt(inner, y) ** 2 * step * 1e6
    table.push([v, y + step])
  }
  const heightOf = (ml: number) => {
    if (ml <= 0) return bottom
    for (let i = 1; i < table.length; i++) if (table[i][0] >= ml) {
      const [v0, y0] = table[i - 1]
      const [v1, y1] = table[i]
      return y0 + ((y1 - y0) * (ml - v0)) / Math.max(1e-9, v1 - v0)
    }
    return table[table.length - 1][1]
  }
  const widest = Math.max(...inner.map(([r]) => r))
  const bubbleSpread = Math.min(widest * 0.55, radiusAt(inner, bottom + 6 * MM) * 0.8)
  const effects = vesselEffects(g, { bottomY: bottom, height: inner[inner.length - 1][1] - bottom, sedimentRadii: [0, 0], spread: bubbleSpread, bubbleRadius: Math.max(0.5 * MM, Math.min(1.2 * MM, widest / 14)), shape: (h) => filledLathe(inner, h, segments) })
  let shownH = -1
  g.userData.setContents = (volumeMl: number, tint: string, look?: VesselLook) => {
    const h = heightOf(volumeMl)
    liquid.visible = h > bottom + 0.3 * MM
    if (liquid.visible && Math.abs(h - shownH) > 0.05 * MM) {
      liquid.geometry.dispose()
      liquid.geometry = filledLathe(inner, h, segments)
      shownH = h
    }
    liquidMaterial.color.set(tint)
    liquidMaterial.opacity = liquidOpacity(look, tint)
    effects.update(look, liquid.visible ? h - bottom : 0)
  }
  g.userData.animate = effects.animate
  g.userData.liquid = liquid
  return shadowed(g) as THREE.Group
}

/** Compact clear reagent vial, matched to the user-supplied prep-bench reference. */
export function buildReagentBottle(title: string, sub: string, liquid: string, fill01 = 0.72, detail: 'full' | 'reduced' = 'full') {
  const g = new THREE.Group()
  g.name = 'bottle:media'
  const r = 17.5 * MM
  const bodyH = 44 * MM
  // No screen-space transmission pass: thin shell with clear, dielectric highlights.
  const wall = new THREE.MeshPhysicalMaterial({ color:'#f2f8f5', roughness:.055, metalness:0, transparent:true,
    opacity:.12, depthWrite:false, side:THREE.FrontSide, envMapIntensity:1.35, clearcoat:1, clearcoatRoughness:.075 })
  const body = new THREE.Mesh(reagentVialGeometry(detail === 'reduced' ? 12 : 40), wall)
  body.name = 'bottle:glass'
  g.add(body)
  const liq = new THREE.Mesh(
    new THREE.CylinderGeometry(r - 1.1 * MM, r - 1.1 * MM, 1, detail === 'reduced' ? 16 : 32),
    liquidMat(liquid),
  )
  const effects = vesselEffects(g, { bottomY: 1.7 * MM, height: bodyH, sedimentRadii: [r - 1.3 * MM, r - 1.3 * MM], spread: r * 0.6, bubbleRadius: 0.8 * MM })
  const setFill = (v: number, tint = liquid, look?: VesselLook) => {
    const fh = Math.max(0.2 * MM, bodyH * Math.min(1,Math.max(0,v)))
    liq.visible = v > 0.01
    liq.scale.y = fh
    liq.position.y = fh / 2 + 1.7 * MM
    const mat = liq.material as THREE.MeshStandardMaterial
    mat.color.set(tint)
    mat.opacity = liquidOpacity(look, tint)
    effects.update(look, liq.visible ? fh : 0)
  }
  setFill(fill01)
  g.add(liq)
  g.userData.animate = effects.animate

  const capMat = plasticMat('#086eb2', { roughness: 0.37, normalScale:new THREE.Vector2(.1,.1) })
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(17.2 * MM, 17.2 * MM, 14 * MM, detail === 'reduced' ? 20 : 40), capMat)
  cap.position.y = 72 * MM
  g.add(cap)
  const seal = new THREE.Mesh(new THREE.CylinderGeometry(17.3 * MM,17.3 * MM,2 * MM,detail === 'reduced' ? 16 : 32), plasticMat('#dce7e5'))
  seal.position.y = 64 * MM
  g.add(seal)
  if (detail === 'full') {
    const ribCount = 40
    const ribs = new THREE.InstancedMesh(new THREE.BoxGeometry(0.55 * MM, 12 * MM, .7 * MM), capMat, ribCount)
    const matrix = new THREE.Matrix4()
    for (let i = 0; i < ribCount; i++) {
      const angle = i / ribCount * Math.PI * 2
      matrix.makeRotationY(-angle).setPosition(Math.cos(angle) * 17.2 * MM, 72 * MM, Math.sin(angle) * 17.2 * MM)
      ribs.setMatrixAt(i, matrix)
    }
    ribs.instanceMatrix.needsUpdate = true
    g.add(ribs)
  }
  // curved printed label
  const labelGeo = new THREE.CylinderGeometry(r + 0.35 * MM, r + 0.35 * MM, 29 * MM, detail === 'reduced' ? 24 : 48, 1, true, -Math.PI * 0.62, Math.PI * 1.24)
  const label = new THREE.Mesh(
    labelGeo,
    new THREE.MeshStandardMaterial({
      map: reagentLabel(title, sub),
      roughness: 0.72,
      metalness: 0,
      side: THREE.DoubleSide,
    }),
  )
  label.position.y = bodyH * 0.52
  g.add(label)

  g.userData.liquid = liq
  g.userData.setFill = setFill

  mergeStaticMeshes(g, [liq])
  return shadowed(g) as THREE.Group
}

/** Blue polypropylene tube rack. */
export function buildTubeRack(cols: number, tint = '#1f4fbf', detail: 'full' | 'reduced' = 'full') {
  const g = new THREE.Group()
  const pitch = 20 * MM
  const w = cols * pitch + 14 * MM
  const d = 46 * MM
  const mat = plasticMat(tint, { roughness: 0.5, clearcoat: 0.2 })
  const holes = Array.from({ length: cols * 2 }, (_, i) => ({ x: (i % cols - (cols - 1) / 2) * pitch, z: i < cols ? -11 * MM : 11 * MM, radius: 6.2 * MM }))
  const deck = new THREE.Mesh(perforatedDeck(w, d, 3 * MM, holes, 2 * MM, detail === 'reduced' ? 8 : 16), mat)
  deck.name = 'rack:perforated-deck'
  deck.position.y = 29 * MM
  g.add(deck)
  const floor = new THREE.Mesh(new THREE.BoxGeometry(w, 3 * MM, d), mat)
  floor.position.y = 1.5 * MM
  g.add(floor)
  for (const side of [-1, 1]) {
    const end = new THREE.Mesh(new RoundedBoxGeometry(4 * MM, 29 * MM, d, 1, MM), mat)
    end.position.set(side * (w / 2 - 2 * MM), 15 * MM, 0)
    g.add(end)
  }
  return shadowed(g) as THREE.Group
}

/** Full SBS 96-well microplate with instanced wells (fast + pickable). */
export function buildMicroplate(lab: LabState | undefined, pickables: THREE.Object3D[], detail: 'full' | 'reduced' = 'full'): PlateHandle {
  const group = new THREE.Group()

  // Moulded frame with clear-bottom cups. Interior shading supplies the small
  // amount of self-occlusion that reflection-only transparent plastics lack.
  const bodyMat = pbr({
    color: '#dce2e6',
    roughness: 0.32,
    metalness: 0.01,
    clearcoat: 0.9,
    clearcoatRoughness: 0.1,
    envMapIntensity: 1.45,
    depthWrite: true,
  })
  const frameMat = pbr({
    color: '#e1e6e9',
    roughness: 0.3,
    clearcoat: 0.78,
    clearcoatRoughness: 0.16,
    depthWrite: true,
  })

  // A skirt is a perimeter, not a translucent solid slab beneath the wells.
  const skirtWall = 1.4 * MM
  for (const side of [-1, 1]) {
    const long = new THREE.Mesh(new THREE.BoxGeometry(PLATE_L, PLATE_H, skirtWall), frameMat)
    long.position.set(0, PLATE_H / 2, side * (PLATE_W - skirtWall) / 2)
    const short = new THREE.Mesh(new THREE.BoxGeometry(skirtWall, PLATE_H, PLATE_W - skirtWall * 2), frameMat)
    short.position.set(side * (PLATE_L - skirtWall) / 2, PLATE_H / 2, 0)
    group.add(long, short)
  }
  const openings = Array.from({ length: 96 }, (_, i) => ({
    x: (i % 12 - 5.5) * WELL_PITCH,
    z: (Math.floor(i / 12) - 3.5) * WELL_PITCH,
    radius: WELL_TOP_D / 2 + 0.15 * MM,
  }))
  const deck = new THREE.Mesh(perforatedDeck(PLATE_L, PLATE_W, 1.1 * MM, openings, 2 * MM, detail === 'reduced' ? 8 : 16), bodyMat)
  deck.name = 'plate:perforated-deck'
  deck.position.y = PLATE_H - 1.1 * MM
  group.add(deck)

  // A1 orientation corner marker.
  const corner = new THREE.Mesh(new THREE.ConeGeometry(2.2 * MM, 1 * MM, 3), pbr({ color: '#64748b', roughness: 0.5 }))
  corner.position.set(-PLATE_L / 2 + 4.5 * MM, PLATE_H + 0.8 * MM, -PLATE_W / 2 + 4.5 * MM)
  corner.rotation.x = Math.PI
  group.add(corner)

  const count = 96
  const wellIds: string[] = []
  const wellLocalPos: THREE.Vector3[] = []

  const cavityGeo = shadeVesselInterior(vesselGeometry(WELL_TOP_D / 2 + 0.15 * MM, WELL_TOP_D / 2 - 0.6 * MM, 10.9 * MM, 0.35 * MM, detail === 'reduced' ? 10 : 20), 10.9 * MM)
  const cavities = new THREE.InstancedMesh(
    cavityGeo,
    pbr({
      color: '#b9cbd1',
      transparent: true,
      opacity: 0.72,
      roughness: 0.24,
      vertexColors: true,
      metalness: 0.01,
      clearcoat: 1,
      envMapIntensity: 0.8,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
    count,
  )
  const liquidGeo = new THREE.CylinderGeometry(WELL_TOP_D / 2 - 0.6 * MM, WELL_TOP_D / 2 - 0.95 * MM, 1, detail === 'reduced' ? 10 : 16)
  const liquidMaterial = liquidMat('#ffffff')
  const liquids = new THREE.InstancedMesh(liquidGeo, liquidMaterial, count)
  liquids.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3)

  // Crisp top lips catch the key light and make every well legible.
  const rimGeo = new THREE.TorusGeometry(WELL_TOP_D / 2, 0.42 * MM, detail === 'reduced' ? 4 : 6, detail === 'reduced' ? 10 : 16)
  const rims = new THREE.InstancedMesh(rimGeo, frameMat, count)

  const m = new THREE.Matrix4()
  let i = 0
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 12; c++) {
      const x = (c - 5.5) * WELL_PITCH
      const z = (r - 3.5) * WELL_PITCH
      wellIds.push(wellId(r, c))
      wellLocalPos.push(new THREE.Vector3(x, PLATE_H, z))
      m.makeTranslation(x, PLATE_H - 10.9 * MM, z)
      cavities.setMatrixAt(i, m)
      m.makeRotationX(Math.PI / 2)
      m.setPosition(x, PLATE_H + 0.35 * MM, z)
      rims.setMatrixAt(i, m)
      i++
    }
  }
  cavities.instanceMatrix.needsUpdate = true
  rims.instanceMatrix.needsUpdate = true
  cavities.castShadow = true
  cavities.receiveShadow = true
  cavities.userData.pick = { kind: 'well', id: '' }
  cavities.userData.wellIds = wellIds
  group.add(cavities)
  group.add(rims)
  group.add(liquids)
  pickables.push(cavities)

  const refresh = (state?: LabState) => {
    const mm = new THREE.Matrix4()
    const col = new THREE.Color()
    let k = 0
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 12; c++) {
        const w = state?.plate.wells[r]?.[c]
        const vol = w?.volume ?? 0
        const h = vol > 0 ? Math.max(1.2 * MM, Math.min(9.6 * MM, (vol / 300) * 9.6 * MM)) : 0
        mm.makeScale(1, h, 1)
        mm.setPosition(
          (c - 5.5) * WELL_PITCH,
          PLATE_H - 10.4 * MM + h / 2,
          (r - 3.5) * WELL_PITCH,
        )
        liquids.setMatrixAt(k, mm)
        col.set(w?.color ?? '#6d5bd0')
        liquids.setColorAt(k, col)
        k++
      }
    }
    liquids.instanceMatrix.needsUpdate = true
    if (liquids.instanceColor) liquids.instanceColor.needsUpdate = true
  }
  refresh(lab)

  // One transparent overlay carries all A–H / 1–12 indexing — more detailed
  // than separate labels, but still one draw call.
  const labelCanvas = document.createElement('canvas')
  labelCanvas.width = 1024
  labelCanvas.height = 680
  const ctx = labelCanvas.getContext('2d')!
  ctx.clearRect(0, 0, labelCanvas.width, labelCanvas.height)
  ctx.fillStyle = '#334155'
  ctx.font = '600 25px ui-monospace, monospace'
  ctx.textAlign = 'center'
  const xPx = (x: number) => ((x + PLATE_L / 2) / PLATE_L) * labelCanvas.width
  const zPx = (z: number) => ((z + PLATE_W / 2) / PLATE_W) * labelCanvas.height
  for (let c = 0; c < 12; c++) ctx.fillText(String(c + 1), xPx((c - 5.5) * WELL_PITCH), 30)
  for (let r = 0; r < 8; r++) ctx.fillText('ABCDEFGH'[r], 25, zPx((r - 3.5) * WELL_PITCH) + 8)
  const labelTex = new THREE.CanvasTexture(labelCanvas)
  labelTex.colorSpace = THREE.SRGBColorSpace
  labelTex.anisotropy = 4
  labelTex.userData.ephemeral = true
  const legend = new THREE.Mesh(
    new THREE.PlaneGeometry(PLATE_L, PLATE_W),
    new THREE.MeshBasicMaterial({ map: labelTex, transparent: true, depthWrite: false, toneMapped: false }),
  )
  legend.rotation.x = -Math.PI / 2
  legend.position.y = PLATE_H + 0.75 * MM
  group.add(legend)

  mergeStaticMeshes(group)
  return { group, cavities, liquids, wellIds, wellLocalPos, refresh }
}

export interface PipetteHandle {
  group: THREE.Group
  tip: THREE.Mesh
  fluid: THREE.Mesh
  plunger: THREE.Group
  digitsMesh: THREE.Mesh
  setVolumeDisplay: (vol: number) => void
  setLoaded: (loaded: boolean, fill01?: number, color?: string) => void
  setTipPresent: (present: boolean) => void
}

/** Classic mechanical P200: ivory upper housing, navy grip and yellow thumb button. */
export function buildPipette(loaded = false, tipOn = true, initialVolume = 50, detail: 'full' | 'reduced' = 'full'): PipetteHandle {
  const group = new THREE.Group()
  group.name = 'pipette:classic'
  const bodyMat = plasticMat('#e8ece8', { roughness: 0.4, normalScale: new THREE.Vector2(.08,.08) })
  const gripMat = plasticMat('#102b46', { roughness: 0.52, normalScale: new THREE.Vector2(.16,.16) })
  const darkMat = plasticMat('#303537', { roughness: 0.65 })
  const codeMat = plasticMat('#e6b72d', { roughness: 0.56 })

  const plungerGroup = new THREE.Group()
  plungerGroup.name = 'pipette:plunger'
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(3.8 * MM, 3.8 * MM, 25 * MM, 24), gripMat)
  stem.position.y = 204.5 * MM
  plungerGroup.add(stem)
  const pushButton = new THREE.Mesh(pipetteButtonGeometry(detail === 'reduced' ? 16 : 40), codeMat)
  pushButton.position.y = 219 * MM
  plungerGroup.add(pushButton)
  group.add(plungerGroup)

  const upper = new THREE.Mesh(pipetteHousingGeometry(detail === 'reduced' ? 20 : 40), bodyMat)
  group.add(upper)
  const grip = new THREE.Mesh(pipetteGripGeometry(detail === 'reduced' ? 16 : 40), gripMat)
  group.add(grip)
  const hook = new THREE.Mesh(pipetteFingerRestGeometry(detail === 'reduced' ? 4 : 8), bodyMat)
  hook.name = 'pipette:finger-rest'
  group.add(hook)
  // The moulded shoulder and ribs are part of the grip silhouette.
  const seam = new THREE.Mesh(new THREE.CylinderGeometry(10.4*MM,10.4*MM,.5*MM,24),darkMat)
  seam.position.y = 140*MM
  group.add(seam)
  const modelLabel = labelPlane(brandTexture('GILSON', '#173c64'), 15*MM, 4*MM)
  modelLabel.position.set(0, 180*MM, 9.55*MM)
  const rangeLabel = labelPlane(brandTexture('P200', '#27313c'), 8*MM, 2.5*MM)
  rangeLabel.position.set(0, 176*MM, 9.55*MM)
  // These short labels use only the inked part of the shared wide brand texture.
  for (const [label, inkWidth] of [[modelLabel, .60], [rangeLabel, .38]] as const) {
    const uv = label.geometry.getAttribute('uv')
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * inkWidth)
  }
  group.add(modelLabel, rangeLabel)

  const win = new THREE.Mesh(new RoundedBoxGeometry(7.6*MM, 21*MM, .8*MM, 2, .25*MM), darkMat)
  win.position.set(0, 157*MM, 7.9*MM)
  group.add(win)
  const digitCanvas = document.createElement('canvas')
  digitCanvas.width = 64
  digitCanvas.height = 192
  const digitCtx = digitCanvas.getContext('2d')!
  const digitTexture = new THREE.CanvasTexture(digitCanvas)
  digitTexture.colorSpace = THREE.SRGBColorSpace
  digitTexture.minFilter = THREE.LinearFilter
  digitTexture.userData.ephemeral = true
  const digitsMat = new THREE.MeshBasicMaterial({ map: digitTexture, toneMapped: false })
  const digitsMesh = new THREE.Mesh(new THREE.PlaneGeometry(6.4 * MM, 18.8 * MM), digitsMat)
  digitsMesh.position.set(0, 157 * MM, 8.35 * MM)
  group.add(digitsMesh)

  const setVolumeDisplay = (vol: number) => {
    const formatted = Math.round(vol).toString().padStart(3, '0')
    digitCtx.fillStyle = '#111719'
    digitCtx.fillRect(0, 0, digitCanvas.width, digitCanvas.height)
    digitCtx.textAlign = 'center'
    digitCtx.textBaseline = 'middle'
    digitCtx.font = '500 48px ui-monospace, monospace'
    ;[0, 1, 2].forEach((i) => {
      digitCtx.fillStyle = '#e4e9e6'
      digitCtx.fillText(formatted[i], digitCanvas.width / 2, 34 + i * 62)
      if (i < 2) {
        digitCtx.strokeStyle = 'rgba(205,218,220,0.16)'
        digitCtx.beginPath()
        digitCtx.moveTo(8, 64 + i * 62)
        digitCtx.lineTo(56, 64 + i * 62)
        digitCtx.stroke()
      }
    })
    digitTexture.needsUpdate = true
  }
  setVolumeDisplay(initialVolume)

  const ejectBtn = new THREE.Mesh(new THREE.CylinderGeometry(5.5 * MM, 5 * MM, 13 * MM, 24), gripMat)
  ejectBtn.position.set(6*MM, 199*MM, -10*MM)
  const ejectBridge = new THREE.Mesh(new RoundedBoxGeometry(12*MM,3*MM,12*MM,1,.7*MM),gripMat)
  ejectBridge.position.set(3*MM,203*MM,-6*MM)
  group.add(ejectBtn,ejectBridge)
  // The reference has a white polymer ejector sleeve, not an exposed steel nose.
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(3.5*MM, 2.6*MM, 45*MM, 24), bodyMat)
  nose.position.y = 47*MM
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(6.2*MM, 4.8*MM, 10*MM, 24), bodyMat)
  collar.position.y = 74*MM
  const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(4.8*MM, 3.5*MM, 3*MM, 24), bodyMat)
  sleeve.position.y = 67.5*MM
  group.add(nose, collar, sleeve)

  // Tip (polypropylene, transparent)
  const tipGeo = pipetteTipGeometry(detail === 'reduced' ? 12 : 32)
  const tipMat = glassMat('#ffffff', 0.0008, 0.04)
  const tip = new THREE.Mesh(tipGeo, tipMat)
  tip.position.y = 2 * MM
  tip.visible = tipOn
  group.add(tip)

  // Liquid column inside tip
  const fluidMat = liquidMat('#60a5fa')
  const fluid = new THREE.Mesh(new THREE.CylinderGeometry(1, 0.06, 1, 20), fluidMat)
  fluid.scale.set(2.4 * MM, 28 * MM, 2.4 * MM)
  fluid.position.y = -10 * MM
  fluid.visible = loaded && tipOn
  group.add(fluid)

  let hasLiquid = loaded
  const setLoaded = (isLoaded: boolean, fill01 = 0.6, col = '#60a5fa') => {
    hasLiquid = isLoaded
    fluid.visible = isLoaded && tip.visible
    if (isLoaded) {
      const h = Math.max(4 * MM, Math.min(1,Math.max(0,fill01)) * 36 * MM)
      const radius = (.16 + (h + .6 * MM) / (49.6 * MM) * 2.44) * MM - .08 * MM
      fluid.scale.set(radius, h, radius)
      fluid.position.y = -24 * MM + h / 2
      ;(fluid.material as THREE.MeshStandardMaterial).color.set(col)
    }
  }

  const setTipPresent = (present: boolean) => {
    tip.visible = present
    fluid.visible = present && hasLiquid
  }

  setLoaded(loaded)
  mergeStaticMeshes(group, [plungerGroup, tip, fluid, digitsMesh])
  shadowed(group)
  return { group, tip, fluid, plunger: plungerGroup, digitsMesh, setVolumeDisplay, setLoaded, setTipPresent }
}

export function buildTipBox(tint = '#1f6fd0', closed = false, detail: 'full' | 'reduced' = 'full') {
  const g = new THREE.Group()
  const w = 128 * MM, d = 88 * MM
  const mat = plasticMat(tint, { roughness: 0.5, clearcoat: 0.2 })
  for (const side of [-1, 1]) {
    const wall = new THREE.Mesh(new RoundedBoxGeometry(w, 42 * MM, 2 * MM, 1, 0.7 * MM), mat)
    wall.position.set(0, 21 * MM, side * (d / 2 - MM))
    const end = new THREE.Mesh(new THREE.BoxGeometry(2 * MM, 42 * MM, d - 4 * MM), mat)
    end.position.set(side * (w / 2 - MM), 21 * MM, 0)
    g.add(wall, end)
  }
  const floor = new THREE.Mesh(new THREE.BoxGeometry(w, 2 * MM, d), mat)
  floor.position.y = MM
  g.add(floor)
  const holes = Array.from({ length: 96 }, (_, i) => ({ x: (i % 12 - 5.5) * 9 * MM, z: (Math.floor(i / 12) - 3.5) * 9 * MM, radius: 3.3 * MM }))
  const deck = new THREE.Mesh(perforatedDeck(w - 4 * MM, d - 4 * MM, 2 * MM, holes, 2 * MM, detail === 'reduced' ? 8 : 16), plasticMat('#e4e8e5', { roughness: 0.55 }))
  deck.name = 'tips:perforated-deck'
  deck.position.y = 40 * MM
  g.add(deck)
  if (!closed) {
    const profile = detail === 'reduced'
      ? [[0.5, 0], [3.1, 36], [3.7, 40], [2.9, 40], [0.3, 1]]
      : [[0.5, 0], [0.9, 4], [3.1, 36], [3.7, 40], [2.9, 40], [2.7, 36], [0.3, 1]]
    const geo = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r * MM, y * MM)), detail === 'reduced' ? 8 : 12)
    shadeVesselInterior(geo, 40 * MM)
    const tips = new THREE.InstancedMesh(geo, pbr({ color: '#ccd8d2', transparent: true, opacity: 0.75, roughness: 0.28, vertexColors: true, depthWrite: false }), 96)
    tips.name = 'tips:hollow-tips'
    const m = new THREE.Matrix4()
    holes.forEach((h, i) => tips.setMatrixAt(i, m.makeTranslation(h.x, 5 * MM, h.z)))
    tips.instanceMatrix.needsUpdate = true
    g.add(tips)
  }
  const lid = new THREE.Group()
  lid.name = 'tips:lid'
  lid.position.set(0, 44 * MM, -d / 2)
  lid.rotation.x = closed ? 0 : -1.8
  const panel = new THREE.Mesh(new RoundedBoxGeometry(w, 3 * MM, d, 2, 1.4 * MM), glassMat('#b8c9d4', MM, 0.2))
  panel.position.set(0, 1.5 * MM, d / 2)
  const latch = new THREE.Mesh(new THREE.BoxGeometry(14 * MM, 5 * MM, 3 * MM), mat)
  latch.position.set(0, 0, d)
  lid.add(panel, latch)
  g.add(lid)
  return shadowed(g) as THREE.Group
}

/** Tapered benchtop waste tub with a true disposal aperture and sliding closure. */
export function buildSharpsBin() {
  const g = new THREE.Group()
  g.name = 'waste:sharps'
  const yellow = plasticMat('#dfb622', { roughness: 0.65 })
  const lidMat = plasticMat('#d2a518', { roughness: 0.62 })
  const body = new THREE.Mesh(wasteBodyGeometry(150 * MM,150 * MM,190 * MM),yellow)
  g.add(body)
  const lid = new THREE.Mesh(loadingPanelGeometry(156*MM,156*MM,6*MM,{x:-14*MM,y:0,width:78*MM,height:42*MM}),lidMat)
  lid.name = 'waste:open-lid'
  lid.rotation.x = -Math.PI/2
  lid.position.y = 190 * MM
  g.add(lid)
  // Closure parks beside the opening, guided by raised moulded rails.
  const slide = new THREE.Mesh(new THREE.BoxGeometry(53*MM,3*MM,48*MM),lidMat)
  slide.position.set(50*MM,199*MM,0)
  g.add(slide)
  for(const side of [-1,1]) {
    const rail=new THREE.Mesh(new THREE.BoxGeometry(138*MM,3*MM,2*MM),lidMat)
    rail.position.set(0,198*MM,side*25*MM);g.add(rail)
  }
  const tab=new THREE.Mesh(new THREE.BoxGeometry(3*MM,7*MM,28*MM),lidMat)
  tab.position.set(71*MM,203*MM,0);g.add(tab)
  const mark = labelPlane(brandTexture('BIOHAZARD', '#25241c', '#f3e2a1'), 96 * MM, 24 * MM)
  mark.position.set(0,110*MM,70.3*MM)
  mark.rotation.x = Math.atan(0.012/0.19)
  g.add(mark)
  mergeStaticMeshes(g)
  return shadowed(g) as THREE.Group
}

/** 150 mL low-form borosilicate beaker, including its pulled pouring spout. */
export function buildBeaker(fill01 = 0.45, color = '#cfe4ff', detail: 'full' | 'reduced' = 'full') {
  const g = new THREE.Group()
  g.name = 'beaker:150ml'
  const r = 30 * MM, h = 80 * MM
  const glass = glassMat('#f0f6f2',0.0012,0.12)
  glass.opacity = .18
  glass.side = THREE.FrontSide
  glass.envMapIntensity = 1.1
  const body = new THREE.Mesh(beakerGeometry(r,h,detail === 'reduced' ? 24 : 64),glass)
  body.name = 'beaker:glass'
  g.add(body)
  const fh = Math.max(0.1*MM, Math.min(1, Math.max(0,fill01)) * (h-8*MM))
  const liq = new THREE.Mesh(new THREE.CylinderGeometry(r-1.4*MM,r-1.4*MM,fh,48),liquidMat(color))
  liq.position.y = fh/2+2.5*MM
  liq.visible = fill01>0
  g.add(liq)
  const print = new THREE.Mesh(new THREE.CylinderGeometry(r+0.12*MM,r+0.12*MM,62*MM,40,1,true,-0.95,1.9),new THREE.MeshStandardMaterial({map:glasswareMarkings(),transparent:true,alphaTest:0.05,depthWrite:false,roughness:0.8,side:THREE.DoubleSide}))
  print.position.y=42*MM
  g.add(print)
  mergeStaticMeshes(g,[liq])
  return shadowed(g) as THREE.Group
}

// ── instruments ──────────────────────────────────────────────────────────
export interface ReaderHandle {
  group: THREE.Group
  tray: THREE.Group
  plate: PlateHandle
  setScreen: (reading: boolean, wavelength: number, temp: string) => void
  scanBar: THREE.Mesh
  trayOpenZ: number
  trayClosedZ: number
}

/** Enclosed plate reader: formed cover, real loading aperture and shallow panel seams. */
export function buildPlateReader(lab: LabState | undefined, pickables: THREE.Object3D[], detail: 'full' | 'reduced' = 'full'): ReaderHandle {
  const group = new THREE.Group()
  const W = 450 * MM, D = 510 * MM, H = 400 * MM
  const shell = plasticMat('#eaedef', { roughness: 0.58, clearcoat: 0.1 })
  const lower = plasticMat('#dfe4e6', { roughness: 0.58, clearcoat: 0.1 })
  const dark = pbr({ color: '#283138', roughness: 0.7, metalness: 0.1 })
  // Separate panels leave an actual empty instrument bay behind the loading slot.
  for (const side of [-1, 1]) {
    const wall = new THREE.Mesh(new RoundedBoxGeometry(8 * MM, H - 12 * MM, D - 4 * MM, 2, 1.5 * MM), shell)
    wall.position.set(side * (W / 2 - 4 * MM), (H + 12 * MM) / 2, 0)
    group.add(wall)
  }
  const top = new THREE.Mesh(new RoundedBoxGeometry(W - 8 * MM, 4 * MM, D - 6 * MM, 2, MM), shell)
  top.position.set(0, H - 2 * MM, 0)
  const back = new THREE.Mesh(new THREE.BoxGeometry(W - 16 * MM, H - 12 * MM, 6 * MM), shell)
  back.position.set(0, (H + 12 * MM) / 2, -D / 2 + 3 * MM)
  const upperFront = new THREE.Mesh(new RoundedBoxGeometry(W - 12 * MM, H - 210 * MM, 4 * MM, 2, MM), shell)
  upperFront.position.set(0, (H + 210 * MM) / 2, D / 2)
  const lowerFront = new THREE.Mesh(loadingPanelGeometry(W - 12 * MM, 194 * MM, 3 * MM, { x: -105 * MM, y: 21 * MM, width: 210 * MM, height: 50 * MM }), lower)
  lowerFront.name = 'reader:loading-panel'
  lowerFront.position.set(0, 111 * MM, D / 2 - 2 * MM)
  const seam = new THREE.Mesh(new THREE.BoxGeometry(W - 12 * MM, 1.5 * MM, 2 * MM), plasticMat('#47677f', { roughness: 0.55 }))
  seam.position.set(0, 209 * MM, D / 2 + 0.2 * MM)
  const base = new THREE.Mesh(new THREE.BoxGeometry(W - 8 * MM, 6 * MM, D - 8 * MM), dark)
  base.position.y = 9 * MM
  group.add(top, back, upperFront, lowerFront, seam, base)
  const bayFloor = new THREE.Mesh(new THREE.BoxGeometry(210 * MM, 2 * MM, 240 * MM), dark)
  bayFloor.position.set(-105 * MM, 106 * MM, D / 2 - 120 * MM)
  const bayBack = new THREE.Mesh(new THREE.BoxGeometry(210 * MM, 54 * MM, 2 * MM), dark)
  bayBack.position.set(-105 * MM, 132 * MM, D / 2 - 240 * MM)
  group.add(bayFloor, bayBack)
  for (const x of [-210 * MM, 0]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(2 * MM, 50 * MM, 240 * MM), dark)
    side.position.set(x, 132 * MM, D / 2 - 120 * MM)
    group.add(side)
  }
  for (const side of [-1, 1]) {
    const bank = new THREE.Mesh(new THREE.BoxGeometry(MM, 135 * MM, 148 * MM), dark)
    bank.position.set(side * (W / 2 + 0.1 * MM), 118 * MM, -115 * MM)
    group.add(bank)
    for (let i = 0; i < 15; i++) {
      const slat = new THREE.Mesh(new THREE.BoxGeometry(1.5 * MM, 4 * MM, 150 * MM), shell)
      slat.position.set(side * (W / 2 + 0.5 * MM), 53 * MM + i * 9 * MM, -115 * MM)
      group.add(slat)
    }
  }

  const badge = labelPlane(brandTexture('BMG LABTECH', '#333e43'), 95*MM, 17*MM)
  badge.position.set(-137*MM,350*MM,D/2+2.2*MM)
  group.add(badge)
  // motorised tray + plate carrier
  const tray = new THREE.Group()
  const trayPlate = new THREE.Mesh(new THREE.BoxGeometry(196 * MM, 9 * MM, 150 * MM), pbr({ color: '#20262f', roughness: 0.45, metalness: 0.45 }))
  tray.add(trayPlate)
  const carrier = new THREE.Mesh(new THREE.BoxGeometry(140 * MM, 5 * MM, 96 * MM), metalMat('#7c848f', 0.42))
  carrier.position.y = 6 * MM
  tray.add(carrier)
  const plate = buildMicroplate(lab, pickables, detail)
  plate.group.position.y = 9 * MM
  tray.add(plate.group)
  tray.position.set(-105 * MM, 128 * MM, D / 2 + 60 * MM)
  group.add(tray)

  // touchscreen
  const bezel = new THREE.Mesh(new THREE.BoxGeometry(88 * MM, 62 * MM, 2 * MM), pbr({ color: '#0f1319', roughness: 0.4 }))
  bezel.position.set(146 * MM, 132 * MM, D / 2 + 2 * MM)
  bezel.rotation.x = 0
  group.add(bezel)
  const screenMat = new THREE.MeshBasicMaterial({ toneMapped: false })
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(80 * MM, 54 * MM), screenMat)
  screen.position.set(146 * MM, 132 * MM, D / 2 + 3.2 * MM)
  screen.rotation.x = 0
  group.add(screen)

  const setScreen = (reading: boolean, wavelength: number, temp: string) => {
    screenMat.map?.dispose()
    screenMat.map = screenTexture(
      [
        { text: reading ? '● reading plate' : '✓ Plate detected', color: reading ? '#38bdf8' : '#4ade80', size: 24 },
        { text: `✓ ${wavelength} nm filter`, color: '#4ade80', size: 24 },
        { text: `✓ ${temp} stable`, color: '#4ade80', size: 24 },
      ],
      reading ? 'READING' : 'Ready',
    )
    screenMat.needsUpdate = true
  }
  setScreen(false, 562, '25 °C')

  const brand = labelPlane(brandTexture('CLARIOstar', '#3b5668'), 96 * MM, 24 * MM)
  brand.position.set(113 * MM, H - 46 * MM, D / 2 + 2.1 * MM)
  group.add(brand)
  const model = labelPlane(brandTexture('PR-960', '#4f6876'), 78 * MM, 20 * MM)
  model.position.set(146 * MM, 82 * MM, D / 2 + 2 * MM)
  group.add(model)

  const statusLed = new THREE.Mesh(
    new THREE.SphereGeometry(1.8 * MM, 12, 8),
    new THREE.MeshBasicMaterial({ color: '#4ade80', toneMapped: false }),
  )
  statusLed.position.set(205 * MM, 44 * MM, D / 2 + 2 * MM)
  group.add(statusLed)
  const powerButton = new THREE.Mesh(
    new THREE.CylinderGeometry(6.5 * MM, 6.5 * MM, 2.5 * MM, 20),
    plasticMat('#222831', { roughness: 0.5 }),
  )
  powerButton.rotation.x = Math.PI / 2
  powerButton.position.set(185 * MM, 44 * MM, D / 2 + 2.5 * MM)
  group.add(powerButton)

  // optics scan bar (visible through open bay while reading)
  const scanBar = new THREE.Mesh(
    new THREE.PlaneGeometry(120 * MM, 84 * MM),
    new THREE.MeshBasicMaterial({ color: '#22d3ee', transparent: true, opacity: 0.32, toneMapped: false }),
  )
  scanBar.rotation.x = -Math.PI / 2
  scanBar.position.set(-105 * MM, 142 * MM, D / 2 + 60 * MM)
  scanBar.visible = false
  group.add(scanBar)

  // feet
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(14 * MM, 16 * MM, 8 * MM, 16), pbr({ color: '#2c3138', roughness: 0.85 }))
      foot.position.set(sx * (W / 2 - 40 * MM), 4 * MM, sz * (D / 2 - 40 * MM))
      group.add(foot)
    }
  }

  shadowed(group)
  return { group, tray, plate, setScreen, scanBar, trayOpenZ: D / 2 + 60 * MM, trayClosedZ: D / 2 - 170 * MM }
}

export interface CentrifugeHandle {
  group: THREE.Group
  rotor: THREE.Group
  lid: THREE.Group
  setScreen: (rpm: number, temp: string, running: boolean) => void
  setLoadedPositions: (positions: boolean[]) => void
}

/** Refrigerated microcentrifuge: reference-informed 290 x 480 x 260 mm casing. */
export function buildCentrifuge(loadedPositions: boolean[] = [], detail: 'full' | 'reduced' = 'full'): CentrifugeHandle {
  const group = new THREE.Group()
  const W = 290 * MM, D = 480 * MM, H = 260 * MM
  const deckY = H - 20 * MM, chamberZ = -30 * MM
  const shell = plasticMat('#e9edef', { roughness: 0.55, clearcoat: 0.1 })
  const trim = plasticMat('#596269', { roughness: 0.62 })
  const blue = plasticMat('#22659b', { roughness: 0.55 })
  const body = new THREE.Mesh(instrumentCasingGeometry({
    width: W, depth: D, deckHeight: deckY, frontHeight: 158 * MM,
    shoulderDepth: 90 * MM, baseHeight: 30 * MM,
    holes: [{ x: 0, z: chamberZ, radius: 107 * MM }], segments: detail === 'reduced' ? 24 : 40,
  }), shell)
  body.name = 'centrifuge:chassis'
  group.add(body)
  const base = new THREE.Mesh(new RoundedBoxGeometry(W - 4 * MM, 24 * MM, D - 4 * MM, 2, 2 * MM), trim)
  base.position.y = 18 * MM
  group.add(base)
  const rear = new THREE.Mesh(new RoundedBoxGeometry(W - 4 * MM, 18 * MM, 35 * MM, 2, 1.5 * MM), shell)
  rear.position.set(0, H - 9 * MM, -D / 2 + 17.5 * MM)
  group.add(rear)

  const seal = new THREE.Mesh(new THREE.TorusGeometry(107 * MM, 3 * MM, 8, 48), pbr({ color: '#202528', roughness: 0.85 }))
  seal.rotation.x = Math.PI / 2
  seal.position.set(0, deckY + 5 * MM, chamberZ)
  group.add(seal)
  const bowl = new THREE.Mesh(vesselGeometry(106 * MM, 97 * MM, 76 * MM, 1.5 * MM, detail === 'reduced' ? 24 : 40), metalMat('#a8afb5', 0.48))
  bowl.name = 'centrifuge:chamber'
  bowl.position.set(0, deckY - 76 * MM, chamberZ)
  group.add(bowl)

  const rotor = new THREE.Group()
  rotor.name = 'centrifuge:rotor'
  rotor.position.set(0, deckY - 68 * MM, chamberZ)
  const rotorMat = pbr({ color: '#303639', roughness: 0.6, metalness: 0.45 })
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(36 * MM, 88 * MM, 22 * MM, 32), rotorMat)
  hub.position.y = 17 * MM
  const crown = new THREE.Mesh(rotorCrownGeometry(24, detail === 'reduced' ? 10 : 16), rotorMat)
  crown.name = 'centrifuge:rotor-crown'
  const nut = new THREE.Mesh(new THREE.CylinderGeometry(12 * MM, 14 * MM, 12 * MM, 20), pbr({ color: '#923b3a', metalness: 0.55, roughness: 0.45 }))
  nut.position.y = 60 * MM
  rotor.add(hub, crown, nut)
  const boreMesh = new THREE.InstancedMesh(vesselGeometry(7.6 * MM, 5.8 * MM, 40 * MM, 1.1 * MM, detail === 'reduced' ? 10 : 14), rotorMat, 24)
  boreMesh.name = 'centrifuge:sockets'
  const tubeMesh = new THREE.InstancedMesh(vesselGeometry(5.3 * MM, 1.8 * MM, 36 * MM, 0.5 * MM, detail === 'reduced' ? 10 : 14), glassMat('#e4e9e5', MM, 0.18), 24)
  tubeMesh.name = 'centrifuge:loaded-tubes'
  const capMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(6.2 * MM, 6.2 * MM, 4 * MM, 14), plasticMat('#3876ad', { roughness: 0.5 }), 24)
  capMesh.name = 'centrifuge:tube-caps'
  const instM = new THREE.Matrix4()
  for (let i = 0; i < 24; i++) boreMesh.setMatrixAt(i, rotorSocket(i))
  boreMesh.instanceMatrix.needsUpdate = true
  const setLoadedPositions = (positions: boolean[]) => {
    let n = 0
    for (let i = 0; i < 24; i++) {
      if (!positions[i]) continue
      const frame = rotorSocket(i)
      tubeMesh.setMatrixAt(n, instM.copy(frame).multiply(new THREE.Matrix4().makeTranslation(0, 6 * MM, 0)))
      capMesh.setMatrixAt(n, instM.copy(frame).multiply(new THREE.Matrix4().makeTranslation(0, 44 * MM, 0)))
      n++
    }
    tubeMesh.count = capMesh.count = n
    tubeMesh.instanceMatrix.needsUpdate = capMesh.instanceMatrix.needsUpdate = true
    tubeMesh.computeBoundingSphere(); capMesh.computeBoundingSphere()
  }
  setLoadedPositions(loadedPositions)
  rotor.add(boreMesh, tubeMesh, capMesh)
  mergeStaticMeshes(rotor)
  group.add(rotor)

  const lid = new THREE.Group()
  lid.name = 'centrifuge:lid'
  const hingeZ = -196 * MM, lidCenter = chamberZ - hingeZ
  const lidShell = new THREE.Mesh(perforatedDeck(W - 8 * MM, 338 * MM, 12 * MM, [{ x: 0, z: 0, radius: 8 * MM }], 10 * MM, 24, 0.8 * MM), shell)
  lidShell.position.z = lidCenter
  const liner = new THREE.Mesh(new THREE.RingGeometry(8 * MM, 100 * MM, 40), pbr({ color: '#bac1c4', roughness: 0.65, metalness: 0.15, side: THREE.DoubleSide }))
  liner.rotation.x = Math.PI / 2
  liner.position.set(0, -2 * MM, lidCenter)
  lid.add(lidShell, liner)
  const metal = metalMat('#8e989e', 0.5)
  for (const side of [-1, 1]) {
    const innerRail = new THREE.Mesh(new THREE.BoxGeometry(5 * MM, 3 * MM, 310 * MM), metal)
    innerRail.position.set(side * (W / 2 - 14 * MM), -MM, lidCenter)
    lid.add(innerRail)
    const hinge = new THREE.Mesh(new THREE.CylinderGeometry(5 * MM, 5 * MM, 26 * MM, 12), metal)
    hinge.rotation.z = Math.PI / 2
    hinge.position.set(side * 106 * MM, deckY + 6 * MM, hingeZ)
    group.add(hinge)
  }
  lid.position.set(0, deckY + 8 * MM, hingeZ)
  lid.rotation.x = -1.15
  mergeStaticMeshes(lid)
  group.add(lid)

  // The controls belong on the inclined shoulder, not halfway down the vertical front.
  const controls = new THREE.Group()
  controls.rotation.x = -Math.atan2(90 * MM, deckY - 158 * MM)
  controls.position.set(0, (deckY + 158 * MM) / 2, D / 2 - 45 * MM)
  const panel = new THREE.Mesh(new RoundedBoxGeometry(W - 30 * MM, 105 * MM, 2 * MM, 1, 0.5 * MM), plasticMat('#dfe5e7', { roughness: 0.6 }))
  panel.position.z = 2 * MM
  controls.add(panel)
  const scrMat = new THREE.MeshBasicMaterial({ toneMapped: false })
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(168 * MM, 24 * MM), scrMat)
  scr.position.set(0, 26 * MM, 4 * MM)
  controls.add(scr)
  const setScreen = (rpm: number, temp: string, running: boolean) => {
    scrMat.map?.dispose()
    const canvas = document.createElement('canvas')
    canvas.width = 672; canvas.height = 96
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#b7c2a3'; ctx.fillRect(0, 0, 672, 96)
    ctx.fillStyle = '#34483d'; ctx.font = '36px ui-monospace, monospace'
    ctx.fillText(`${rpm.toLocaleString()} rpm   ${temp}`, 16, 42)
    ctx.font = '23px ui-monospace, monospace'; ctx.fillText(running ? 'RUN' : 'READY', 16, 80)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace; texture.userData.ephemeral = true
    scrMat.map = texture; scrMat.needsUpdate = true
  }
  setScreen(14000, '4 \u00b0C', false)
  for (const side of [-1, 1]) {
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(13 * MM, 14 * MM, 9 * MM, 24), blue)
    knob.rotation.x = Math.PI / 2
    knob.position.set(side * 49 * MM, -16 * MM, 8 * MM)
    controls.add(knob)
    const index = new THREE.Mesh(new THREE.BoxGeometry(1.5 * MM, 7 * MM, 0.5 * MM), shell)
    index.position.set(side * 49 * MM, -11 * MM, 12.6 * MM)
    controls.add(index)
    for (let j = 0; j < 2; j++) {
      const button = new THREE.Mesh(new THREE.CylinderGeometry(5 * MM, 5 * MM, 2 * MM, 12), blue)
      button.rotation.x = Math.PI / 2
      button.position.set(side * 108 * MM, 19 * MM - j * 35 * MM, 4 * MM)
      controls.add(button)
    }
  }
  group.add(controls)
  const brand = labelPlane(brandTexture('eppendorf', '#255c8f'), 75 * MM, 16 * MM)
  brand.position.set(-78 * MM, 56 * MM, D / 2 + MM)
  group.add(brand)
  const model = labelPlane(brandTexture('5424 R', '#255c8f'), 66 * MM, 15 * MM)
  model.position.set(72 * MM, 56 * MM, D / 2 + MM)
  group.add(model)

  const ventMat = pbr({ color: '#39434a', roughness: 0.8 })
  for (const side of [-1, 1]) {
    const bank = new THREE.Mesh(new THREE.BoxGeometry(MM, 135 * MM, 215 * MM), ventMat)
    bank.position.set(side * (W / 2 + 0.2 * MM), 132 * MM, -88 * MM)
    group.add(bank)
    for (let i = 0; i < 18; i++) {
      const slat = new THREE.Mesh(new THREE.BoxGeometry(1.8 * MM, 3 * MM, 217 * MM), shell)
      slat.position.set(side * (W / 2 + 0.8 * MM), 68 * MM + i * 7.5 * MM, -88 * MM)
      group.add(slat)
    }
  }
  for (const x of [-1, 1]) for (const z of [-1, 1]) {
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(8 * MM, 8 * MM, 8 * MM, 12), trim)
    foot.position.set(x * (W / 2 - 22 * MM), 4 * MM, z * (D / 2 - 24 * MM))
    group.add(foot)
  }
  shadowed(group)
  return { group, rotor, lid, setScreen, setLoadedPositions }
}

/** Fraction collector rack with 13x100 mm glass tubes. */
export function buildFractionRack(
  values: { num: number; fill01: number; color: string; selected: boolean }[],
) {
  const group = new THREE.Group()
  const pitch = 26 * MM
  const w = values.length * pitch + 26 * MM

  const railMat = plasticMat('#e4e8ee', { roughness: 0.5 })
  const base = new THREE.Mesh(new THREE.BoxGeometry(w, 12 * MM, 62 * MM), railMat)
  base.position.y = 6 * MM
  group.add(base)
  const upper = new THREE.Mesh(new THREE.BoxGeometry(w, 8 * MM, 58 * MM), railMat)
  upper.position.y = 74 * MM
  group.add(upper)
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(10 * MM, 78 * MM, 58 * MM), railMat)
    post.position.set(sx * (w / 2 - 5 * MM), 39 * MM, 0)
    group.add(post)
  }

  // Tubes, liquids and caps are each a single instanced draw call.
  const tubeH = 100 * MM
  const tubeMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(6.5 * MM, 6.2 * MM, tubeH, 18),
    glassMat('#ffffff', 0.0012, 0.055),
    values.length,
  )
  const liquidMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(6.05 * MM, 5.85 * MM, 1, 18),
    liquidMat('#ffffff'),
    values.length,
  )
  liquidMesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(values.length * 3),
    3,
  )
  const capMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(7.4 * MM, 7.4 * MM, 9 * MM, 18),
    plasticMat('#4b93e0', { clearcoat: 0.7 }),
    values.length,
  )
  capMesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(values.length * 3),
    3,
  )
  const matrix = new THREE.Matrix4()
  const color = new THREE.Color()

  values.forEach((v, i) => {
    const x = (i - (values.length - 1) / 2) * pitch
    matrix.makeTranslation(x, 14 * MM + tubeH / 2, 0)
    tubeMesh.setMatrixAt(i, matrix)

    const fh = Math.max(4 * MM, v.fill01 * 78 * MM)
    matrix.makeScale(1, fh, 1)
    matrix.setPosition(x, 12 * MM + fh / 2, 0)
    liquidMesh.setMatrixAt(i, matrix)
    liquidMesh.setColorAt(i, color.set(v.color))

    matrix.makeTranslation(x, 14 * MM + tubeH + 3 * MM, 0)
    capMesh.setMatrixAt(i, matrix)
    capMesh.setColorAt(i, color.set(v.selected ? '#1f6fd0' : '#4b93e0'))
  })
  tubeMesh.instanceMatrix.needsUpdate = true
  liquidMesh.instanceMatrix.needsUpdate = true
  capMesh.instanceMatrix.needsUpdate = true
  if (liquidMesh.instanceColor) liquidMesh.instanceColor.needsUpdate = true
  if (capMesh.instanceColor) capMesh.instanceColor.needsUpdate = true
  capMesh.castShadow = true
  group.add(tubeMesh, liquidMesh, capMesh)

  // One printed strip replaces ten individual label textures/planes.
  const stripCanvas = document.createElement('canvas')
  stripCanvas.width = 1024
  stripCanvas.height = 96
  const stripCtx = stripCanvas.getContext('2d')!
  stripCtx.clearRect(0, 0, stripCanvas.width, stripCanvas.height)
  values.forEach((v, i) => {
    const cx = ((i + 0.5) / values.length) * stripCanvas.width
    stripCtx.fillStyle = v.selected ? '#dbeafe' : '#f8fafc'
    stripCtx.fillRect(cx - 35, 8, 70, 76)
    stripCtx.strokeStyle = v.selected ? '#2563eb' : '#94a3b8'
    stripCtx.strokeRect(cx - 35, 8, 70, 76)
    stripCtx.textAlign = 'center'
    stripCtx.textBaseline = 'middle'
    stripCtx.font = 'bold 36px ui-monospace, monospace'
    stripCtx.fillStyle = v.selected ? '#1d4ed8' : '#334155'
    stripCtx.fillText(String(v.num), cx, 48)
  })
  const stripTex = new THREE.CanvasTexture(stripCanvas)
  stripTex.colorSpace = THREE.SRGBColorSpace
  stripTex.userData.ephemeral = true
  const strip = new THREE.Mesh(
    new THREE.PlaneGeometry(values.length * pitch, 19 * MM),
    new THREE.MeshBasicMaterial({ map: stripTex, transparent: true, toneMapped: false }),
  )
  strip.position.set(0, 32 * MM, 31.5 * MM)
  group.add(strip)

  shadowed(group)
  return group
}

export function buildChromatographySkid() {
  const group = new THREE.Group()
  const shell = plasticMat('#eef1f5', { roughness: 0.45, clearcoat: 0.5 })
  const tower = new THREE.Mesh(new THREE.BoxGeometry(230 * MM, 460 * MM, 260 * MM), shell)
  tower.position.y = 230 * MM
  group.add(tower)
  const scrMat = new THREE.MeshBasicMaterial({
    toneMapped: false,
    map: screenTexture([
      { text: 'A280   214 mAU', color: '#38bdf8', size: 26 },
      { text: 'Cond   42 mS/cm', color: '#fbbf24', size: 26 },
      { text: 'Flow   1.0 mL/min', color: '#e2e8f0', size: 24 },
    ], 'ÄKTA run'),
  })
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(160 * MM, 100 * MM), scrMat)
  scr.position.set(0, 330 * MM, 131 * MM)
  group.add(scr)

  // column
  const column = new THREE.Mesh(new THREE.CylinderGeometry(16 * MM, 16 * MM, 300 * MM, 32), glassMat('#ffffff', 0.003, 0.05))
  column.position.set(170 * MM, 190 * MM, 40 * MM)
  group.add(column)
  const resin = new THREE.Mesh(new THREE.CylinderGeometry(14 * MM, 14 * MM, 250 * MM, 32), pbr({ color: '#dbe6f3', roughness: 0.65, transmission: 0.3, thickness: 0.01 }))
  resin.position.set(170 * MM, 180 * MM, 40 * MM)
  group.add(resin)
  for (const y of [40 * MM, 340 * MM]) {
    const fitting = new THREE.Mesh(new THREE.CylinderGeometry(18 * MM, 18 * MM, 22 * MM, 24), plasticMat('#38414d'))
    fitting.position.set(170 * MM, y, 40 * MM)
    group.add(fitting)
  }
  const stand = new THREE.Mesh(new THREE.CylinderGeometry(9 * MM, 9 * MM, 420 * MM, 20), metalMat('#9aa3ae', 0.35))
  stand.position.set(210 * MM, 210 * MM, 40 * MM)
  group.add(stand)

  // tubing
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(170 * MM, 350 * MM, 40 * MM),
    new THREE.Vector3(120 * MM, 420 * MM, 90 * MM),
    new THREE.Vector3(20 * MM, 400 * MM, 140 * MM),
    new THREE.Vector3(-40 * MM, 300 * MM, 150 * MM),
  ])
  const tubing = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 2.4 * MM, 10, false), plasticMat('#cdd5df', { roughness: 0.35 }))
  group.add(tubing)

  shadowed(group)
  return group
}

export { PLATE_L, PLATE_W, PLATE_H, WELL_PITCH }

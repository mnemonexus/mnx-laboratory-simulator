// A shared, non-playable campus: real silhouettes nearby, fixed photographic
// cutouts at several depths, texture-only facade detail and baked vertex light.
// No outdoor simulation, animated billboards, dynamic lights or shadow passes.
import * as THREE from 'three'
import { type Node } from 'three/webgpu'
import { Fn, If, Discard, output, positionWorld, cameraPosition, smoothstep, mix, vec3, vec4, dot, texture, uv, vec2, color as tslColor } from 'three/tsl'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { WINDOWS, ZONES, ZONE_IDS, polygonContains, wallHoles, zoneWalls, type Vec2, type WindowDef, type ZoneId } from './layout'
import type { ExteriorTextures } from './exteriorTextures'

const SKY_RADIUS = 170
// UK second floor: ground and first floors below the unchanged indoor y = 0.
export const EXTERIOR_FLOOR_PITCH = 3.15
export const EXTERIOR_GROUND_Y = -2 * EXTERIOR_FLOOR_PITCH
export const EXTERIOR_FAR = 240
export const EXTERIOR_FOG = { color: '#899394', near: 7, far: 38 } as const
export const EXTERIOR_WINDOWS = WINDOWS.filter((w) => w.kind === 'exterior')

export function windowBounds(w: WindowDef) {
  const tangent = new THREE.Vector3(-w.normal[1], 0, w.normal[0]).multiplyScalar(w.width / 2)
  const center = new THREE.Vector3(w.center[0], (w.sill + w.head) / 2, w.center[1])
  const box = new THREE.Box3()
  for (const sign of [-1, 1]) for (const y of [w.sill, w.head]) box.expandByPoint(center.clone().addScaledVector(tangent, sign).setY(y))
  return box.expandByScalar(0.025)
}

const portals = EXTERIOR_WINDOWS.map((w) => ({ w, bounds: windowBounds(w) }))

/** Reuse room/door visibility, then reject windows behind or outside the camera. */
export function exteriorVisible(visibleZones: ReadonlySet<ZoneId>, position: THREE.Vector3, frustum: THREE.Frustum) {
  return portals.some(({ w, bounds }) => visibleZones.has(w.zone)
    && (position.x - w.center[0]) * w.normal[0] + (position.z - w.center[1]) * w.normal[1] > -0.05
    && frustum.intersectsBox(bounds))
}

/** How far across the campus another wing's window still shows its room (inside the fog). */
const OUTSIDE_VIEW = 24

/**
 * With the outdoors in view, other rooms are seen through their own exterior
 * windows: add each room whose window faces the camera from outside, lies in
 * the frustum and is near enough to read, so its windows show the real room.
 */
export function addRoomsSeenFromOutside(visibleZones: Set<ZoneId>, position: THREE.Vector3, frustum: THREE.Frustum) {
  for (const { w, bounds } of portals) {
    if (visibleZones.has(w.zone)) continue
    // the camera must be on the outside of this window
    if ((position.x - w.center[0]) * w.normal[0] + (position.z - w.center[1]) * w.normal[1] > -0.05) continue
    if (Math.hypot(position.x - w.center[0], position.z - w.center[1]) > OUTSIDE_VIEW) continue
    if (frustum.intersectsBox(bounds)) visibleZones.add(w.zone)
  }
}

type Point = [number, number, number]
class GeometryBatch {
  private geometries: THREE.BufferGeometry[] = []
  add(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation) {
    const c = new THREE.Color(color)
    const count = geometry.getAttribute('position').count
    const colors = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) c.toArray(colors, i * 3)
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    this.geometries.push(geometry.index ? geometry.toNonIndexed() : geometry)
    if (geometry.index) geometry.dispose()
  }
  quad(points: Point[], color: THREE.ColorRepresentation, uv: number[] = [0, 0, 1, 0, 1, 1, 0, 1]) {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    g.setIndex([0, 1, 2, 0, 2, 3])
    g.computeVertexNormals()
    this.add(g, color)
  }
  box(x: number, y: number, z: number, width: number, height: number, depth: number, color: string, yaw = 0) {
    const g = new THREE.BoxGeometry(width, height, depth)
    // Static ambient shading: tops are sky-lit, sides retain shape without lights.
    this.add(g.rotateY(yaw).translate(x, y, z), color)
    const result = this.geometries[this.geometries.length - 1]
    const normals = result.getAttribute('normal')
    const colors = result.getAttribute('color')
    for (let i = 0; i < colors.count; i++) {
      const light = 0.62 + Math.max(0, normals.getY(i)) * 0.35 + Math.abs(normals.getX(i)) * 0.12
      colors.setXYZ(i, colors.getX(i) * light, colors.getY(i) * light, colors.getZ(i) * light)
    }
  }
  mesh(name: string, material: THREE.Material) {
    if (!this.geometries.length) return null
    const geometry = mergeGeometries(this.geometries, false)!
    this.geometries.forEach((g) => g.dispose())
    geometry.computeBoundingSphere()
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = name
    return mesh
  }
}

function clearGround(x: number, z: number, radius: number) {
  return !ZONE_IDS.some((id) => {
    const polygon = ZONES[id].floor
    return polygonContains(polygon, x, z) || polygon.some((a, i) => {
      const b = polygon[(i + 1) % polygon.length]
      const dx = b[0] - a[0], dz = b[1] - a[1]
      const t = THREE.MathUtils.clamp(((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz), 0, 1)
      return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz) < radius
    })
  })
}

export function buildExterior(textures: ExteriorTextures, reduced: boolean) {
  const root = new THREE.Group()
  root.name = 'EXTERIOR_CAMPUS'
  const materials: THREE.Material[] = []
  const basic = (p: THREE.MeshBasicMaterialParameters = {}) => {
    const m = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, ...p })
    materials.push(m)
    return m
  }
  // Analytic fog lives only on outdoor materials. World position is interpolated
  // then measured per fragment: vertex-distance fog would flatten the giant
  // ground quad into one colour. No volume, noise animation or extra pass.
  const atmospheric = (p: THREE.MeshBasicMaterialParameters = {}, groundDetail = false) => {
    const m = basic(p)
    ;(m as THREE.MeshBasicMaterial & { outputNode: Node }).outputNode = Fn(() => {
      const distance = positionWorld.distance(cameraPosition)
      If(distance.greaterThanEqual(EXTERIOR_FOG.far), () => { Discard() })
      let rgb = output.rgb
      if (groundDetail) {
        const broad = texture(textures.ground, uv().mul(0.113).add(vec2(0.27, 0.61))).rgb
        rgb = rgb.mul(dot(broad, vec3(0.333)).mul(1.7).add(0.7))
      }
      const distanceFog = smoothstep(EXTERIOR_FOG.near, EXTERIOR_FOG.far, distance)
      const groundMist = smoothstep(EXTERIOR_GROUND_Y, 3, positionWorld.y).oneMinus().mul(0.2)
      const fog = distanceFog.oneMinus().mul(groundMist.oneMinus()).oneMinus()
      const neutral = dot(rgb, vec3(0.2126, 0.7152, 0.0722))
      const graded = mix(rgb, vec3(neutral), 0.45).mul(vec3(0.88, 0.93, 0.9))
      return vec4(mix(graded, tslColor(EXTERIOR_FOG.color), fog), output.a)
    })()
    return m
  }
  const solid = new GeometryBatch()
  const paving = new GeometryBatch()
  const buildings = new GeometryBatch()
  const trees = new GeometryBatch()
  const shadows = new GeometryBatch()
  const add = (mesh: THREE.Mesh | null) => { if (mesh) root.add(mesh) }

  // A small cloud photograph on the skydome, blended into the horizon gradient.
  const skyGeometry = new THREE.SphereGeometry(SKY_RADIUS, 32, 16)
  const positions = skyGeometry.getAttribute('position')
  const skyColors = new Float32Array(positions.count * 3)
  const horizon = new THREE.Color(EXTERIOR_FOG.color), zenith = new THREE.Color('#596467'), below = horizon.clone()
  for (let i = 0; i < positions.count; i++) {
    const y = positions.getY(i) / SKY_RADIUS
    const c = y >= 0 ? horizon.clone().lerp(zenith, Math.pow(y, 0.55)) : horizon.clone().lerp(below, Math.min(1, -y * 6))
    c.toArray(skyColors, i * 3)
  }
  skyGeometry.setAttribute('color', new THREE.BufferAttribute(skyColors, 3))
  // The source is a panorama of the sky above the horizon. Keep its bottom at
  // the equator; the gradient continues underneath, where the ground hides it.
  const skyMaterial = basic({ side: THREE.BackSide, depthWrite: false })
  ;(skyMaterial as THREE.MeshBasicMaterial & { outputNode: Node }).outputNode = Fn(() => {
    const clouds = texture(textures.sky, vec2(uv().x, uv().y.sub(0.5).mul(2).clamp())).rgb
    const luma = dot(clouds, vec3(0.2126, 0.7152, 0.0722))
    const overcast = tslColor(horizon).mul(mix(0.72, 1.02, luma.mul(2).clamp()))
    return vec4(mix(output.rgb, overcast, smoothstep(0.55, 0.8, uv().y).mul(0.35)), output.a)
  })()
  const sky = new THREE.Mesh(skyGeometry, skyMaterial)
  sky.name = 'exterior:sky'
  sky.position.set(4, 0, 10)
  root.add(sky)
  const ground = new GeometryBatch()
  const groundY = EXTERIOR_GROUND_Y - 0.075
  ground.quad([[-180, groundY, -180], [-180, groundY, 180], [180, groundY, 180], [180, groundY, -180]], '#b4bab3', [0, 0, 0, 75, 75, 75, 75, 0])
  add(ground.mesh('exterior:lawn', atmospheric({ map: textures.ground }, true)))

  // Exterior faces close the backs of the existing one-sided room shells.
  // Use the same openings; trees never bleed through an adjacent building.
  for (const id of ZONE_IDS) {
    const zone = ZONES[id]
    for (const wall of zoneWalls(zone)) {
      const p = (s: number, y: number, d = 0.025): Point => [wall.a[0] + wall.t[0] * s - wall.n[0] * d, y, wall.a[1] + wall.t[1] * s - wall.n[1] * d]
      const rect = (s0: number, s1: number, y0: number, y1: number) => {
        if (s1 <= s0 || y1 <= y0) return
        // Outward face, opposite to the interior wall winding.
        solid.quad([p(s1, y0), p(s0, y0), p(s0, y1), p(s1, y1)], '#8b97a3', [s1 / 2.5, y0 / 3, s0 / 2.5, y0 / 3, s0 / 2.5, y1 / 3, s1 / 2.5, y1 / 3])
      }
      let s = 0
      for (const hole of wallHoles(wall)) {
        rect(s, hole.s0, 0, zone.ceiling)
        rect(hole.s0, hole.s1, 0, hole.y0)
        rect(hole.s0, hole.s1, hole.y1, zone.ceiling)
        s = hole.s1
      }
      rect(s, wall.length, 0, zone.ceiling)
      // Two inexpensive facade strips support the second-floor viewpoint.
      // Window recesses on these inaccessible storeys are texture detail.
      buildings.quad([p(wall.length, EXTERIOR_GROUND_Y), p(0, EXTERIOR_GROUND_Y), p(0, 0), p(wall.length, 0)], '#a8b0bb', [wall.length / 2.6, 0, 0, 0, 0, 2, wall.length / 2.6, 2])
      for (const y of [-EXTERIOR_FLOOR_PITCH, 0]) {
        const a = p(0, y), b = p(wall.length, y)
        solid.box((a[0] + b[0]) / 2, y - 0.04, (a[2] + b[2]) / 2, wall.length, 0.1, 0.08, '#7d8a98', -Math.atan2(wall.t[1], wall.t[0]))
      }
      // Coping and a pavement band. Bands under neighbouring rooms are hidden
      // below their floors, rather than changing the walkable facility.
      const out = (s: number, d: number): Point => p(s, EXTERIOR_GROUND_Y - 0.035, d)
      paving.quad([out(0, 0), out(wall.length, 0), out(wall.length, 1.65), out(0, 1.65)], '#b2b9c0', [0, 0, wall.length, 0, wall.length, 1.65, 0, 1.65])
      const a = p(0, zone.ceiling + 0.035), b = p(wall.length, zone.ceiling + 0.035)
      solid.box((a[0] + b[0]) / 2, zone.ceiling + 0.035, (a[2] + b[2]) / 2, wall.length, 0.09, 0.09, '#89949e', -Math.atan2(wall.t[1], wall.t[0]))
    }
    const outline = zone.floor.map(([x, z]) => new THREE.Vector2(x, -z))
    const roof = new THREE.ShapeGeometry(new THREE.Shape(outline))
    roof.rotateX(-Math.PI / 2).translate(0, zone.ceiling + 0.055, 0)
    solid.add(roof, '#667584')
  }

  let seed = 5301
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296 }
  const treePositions: Vec2[] = []
  const tree = (x: number, z: number, height: number, variant: number, yaw: number) => {
    if (!clearGround(x, z, height * 0.23) || treePositions.some(([a, b]) => Math.hypot(x - a, z - b) < height * 0.36)) return
    treePositions.push([x, z])
    if (Math.hypot(x - 4, z - 10) < 55) {
      const r = height * 0.22
      const y = EXTERIOR_GROUND_Y - 0.068
      shadows.quad([[x - r, y, z - r], [x - r, y, z + r], [x + r, y, z + r], [x + r, y, z - r]], '#0c1926')
    }
    const bands = [[0.002, 0.395], [0.402, 0.659], [0.664, 0.998]]
    const [u0, u1] = bands[variant % 3]
    const width = height * (u1 - u0) * 1.5
    const color = new THREE.Color('#87978f')
    // Two fixed intersecting cards, never camera-facing. Low uses the same
    // silhouettes and depth layers, with fewer distant trees.
    for (const angle of [yaw, yaw + Math.PI / 2]) {
      const dx = Math.cos(angle) * width / 2, dz = Math.sin(angle) * width / 2
      const base = EXTERIOR_GROUND_Y - height * 0.035, top = EXTERIOR_GROUND_Y + height * 0.965
      trees.quad([[x - dx, base, z - dz], [x + dx, base, z + dz], [x + dx, top, z + dz], [x - dx, top, z - dz]], color, [u0, 0, u1, 0, u1, 1, u0, 1])
    }
  }

  // Foreground furniture and trees are anchored to the facade, not the camera.
  for (const [i, w] of EXTERIOR_WINDOWS.entries()) {
    const n = w.normal, t: Vec2 = [-n[1], n[0]]
    const at = (side: number, distance: number): Vec2 => [w.center[0] + t[0] * side - n[0] * distance, w.center[1] + t[1] * side - n[1] * distance]
    const yaw = Math.atan2(t[1], t[0])
    for (const [side, distance, h] of [[-3.8, 6, 6.7], [4.2, 10, 7.6], [-7, 22, 9], [6, 35, 10]]) {
      const [x, z] = at(side, distance)
      tree(x, z, h, i + (side > 0 ? 1 : 0), yaw)
    }
    const [x, z] = at(2.4, 3.2)
    if (clearGround(x, z, 1.3)) {
      // Raised bed: geometry defines its silhouette; no individual leaf meshes.
      solid.box(x, EXTERIOR_GROUND_Y + 0.22, z, 1.8, 0.48, 0.75, '#77838d', -yaw)
      solid.box(x, EXTERIOR_GROUND_Y + 0.49, z, 1.7, 0.18, 0.65, '#364c49', -yaw)
      const y = EXTERIOR_GROUND_Y - 0.032
      shadows.quad([[x - 1.25, y, z - 0.75], [x - 1.25, y, z + 0.75], [x + 1.25, y, z + 0.75], [x + 1.25, y, z - 0.75]], '#101d29')
    }
    const [bx, bz] = at(-2.2, 3)
    if (!reduced && clearGround(bx, bz, 1.2)) {
      solid.box(bx, EXTERIOR_GROUND_Y + 0.38, bz, 1.5, 0.09, 0.45, '#707c8a', -yaw)
      for (const offset of [-0.55, 0.55]) solid.box(bx + t[0] * offset, EXTERIOR_GROUND_Y + 0.16, bz + t[1] * offset, 0.08, 0.36, 0.35, '#364454', -yaw)
    }
  }
  // Irregular middle distance and a tree belt: each ring has true world depth.
  // The dense fog replaces the former 62/105-unit belts and distant skyline.
  // Retain two closer rings so every side of the facility has depth in the mist.
  for (const [radius, count] of [[26, reduced ? 16 : 24], [42, reduced ? 18 : 28]]) {
    for (let i = 0; i < count; i++) {
      const angle = (i + random() * 0.6) / count * Math.PI * 2
      const distance = radius + random() * 7
      tree(4 + Math.cos(angle) * distance, 10 + Math.sin(angle) * distance, 7 + random() * 7, i, angle + Math.PI / 2)
    }
  }
  add(paving.mesh('exterior:paving', atmospheric({ map: textures.paving, side: THREE.DoubleSide }, true)))
  add(solid.mesh('exterior:architecture', atmospheric({ map: textures.wall })))
  add(buildings.mesh('exterior:distant-buildings', atmospheric({ map: textures.facade })))
  add(trees.mesh('exterior:tree-cards', atmospheric({ map: textures.trees, alphaTest: 0.3, side: THREE.DoubleSide })))
  // the blob's falloff is its alpha channel (see the indoor shadow material)
  add(shadows.mesh('exterior:contact-shadows', atmospheric({ map: textures.shadow, transparent: true, opacity: 0.5, depthWrite: false })))
  root.updateMatrixWorld(true)
  root.traverse((o) => { o.matrixAutoUpdate = false; o.userData.shared = true })
  return {
    root,
    treeCount: treePositions.length,
    dispose() {
      root.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose() })
      materials.forEach((m) => m.dispose())
      Object.values(textures).forEach((t) => t.dispose())
    },
  }
}

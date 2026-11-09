import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { beakerGeometry, mediaBottleGeometry, wasteBodyGeometry, instrumentCasingGeometry, loadingPanelGeometry, perforatedDeck, rotorCrownGeometry, rotorSocket, shadeVesselInterior, vesselGeometry, pipetteHousingGeometry, pipetteFingerRestGeometry, reagentVialGeometry, pipetteGripGeometry, pipetteTipGeometry } from '../equipmentGeometry'
import { Batch, createPalette } from './kit'
import { pipetteStand, sharpsBin, bottle, compoundMicroscope, microfuge, plateReader, plateStack, stereoMicroscope, thermocycler, tipBox, tubeRack, vortex } from './props'

const down = new THREE.Vector3(0, -1, 0)
const material = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide })
function rayAt(root: THREE.Object3D, x: number, z: number, y = 1) {
  root.updateMatrixWorld(true)
  return new THREE.Raycaster(new THREE.Vector3(x, y, z), down).intersectObject(root, true)
}

function fixture(detail: 'full' | 'reduced', build: (b: Batch) => void) {
  const tex = new THREE.Texture()
  const atlas = { texture: tex, uv: () => [0, 0, 1, 1] as [number, number, number, number] }
  const palette = createPalette({ worktop: { map: tex, roughnessMap: tex }, walnut: tex, atlas, leaf: tex, blob: tex }, false)
  const b = new Batch('main', detail, atlas)
  build(b)
  const result = b.build(palette, 'equipment')
  return { ...result, dispose() { result.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose()); palette.dispose(); tex.dispose() } }
}

describe('equipment geometry', () => {
  it('keeps the reference pipette counter face flat and its finger saddle open underneath', () => {
    const housing = pipetteHousingGeometry(32)
    housing.computeBoundingBox()
    expect(housing.boundingBox!.max.z).toBeLessThan(.01)
    const housingMesh = new THREE.Mesh(housing, material)
    housingMesh.updateMatrixWorld(true)
    const counterRay = (x: number) => new THREE.Raycaster(new THREE.Vector3(x,.157,.04),new THREE.Vector3(0,0,-1)).intersectObject(housingMesh)
    expect(counterRay(0)[0].point.z).toBeLessThan(0)
    expect(counterRay(.006)[0].point.z).toBeCloseTo(.0092, 5)
    const visibleWalls=new THREE.Mesh(housing,new THREE.MeshStandardMaterial())
    visibleWalls.updateMatrixWorld(true)
    const wallHit=new THREE.Raycaster(new THREE.Vector3(0,.157,.0087),new THREE.Vector3(1,0,0)).intersectObject(visibleWalls)[0]
    expect(wallHit.point.x).toBeCloseTo(.0038,5)
    visibleWalls.material.dispose()
    const rest = pipetteFingerRestGeometry()
    rest.computeBoundingBox()
    expect(rest.boundingBox!.min.x).toBeLessThan(-.03)
    const mesh = new THREE.Mesh(rest, material)
    // A horizontal ray beneath the saddle is unobstructed; the hook has negative space.
    mesh.updateMatrixWorld(true)
    expect(new THREE.Raycaster(new THREE.Vector3(-.022, .188, .02), new THREE.Vector3(0, 0, -1)).intersectObject(mesh)).toHaveLength(0)
    expect(new THREE.Raycaster(new THREE.Vector3(-.020, .199, .02), new THREE.Vector3(0, 0, -1)).intersectObject(mesh).length).toBeGreaterThan(0)
    housing.dispose(); rest.dispose()
  })

  it('models a flattened grip and a hollow shouldered tip at both detail levels', () => {
    for (const segments of [16, 40]) {
      const grip=pipetteGripGeometry(segments),tip=pipetteTipGeometry(segments)
      for(const geo of [grip,tip]) {
        geo.computeBoundingBox()
        expect([...geo.getAttribute('position').array].every(Number.isFinite)).toBe(true)
      }
      expect(grip.boundingBox!.max.z).toBeLessThan(.0091)
      expect(tip.boundingBox!.min.y).toBeCloseTo(-.027,5)
      expect(tip.boundingBox!.max.y).toBeCloseTo(.027,5)
      const tipMesh=new THREE.Mesh(tip,material)
      // Looking straight down the bore hits neither a cap nor a filled-in cone.
      expect(rayAt(tipMesh,0,0)).toHaveLength(0)
      grip.dispose();tip.dispose()
    }
  })

  it('retains the short vial heel and open neck at both detail levels', () => {
    for (const segments of [12, 40]) {
      const geo = reagentVialGeometry(segments)
      const mesh = new THREE.Mesh(geo, material)
      expect(rayAt(mesh, 0, 0)[0].point.y).toBeCloseTo(.0016, 5)
      geo.computeBoundingBox()
      expect(geo.boundingBox!.max.y).toBeCloseTo(.067, 5)
      expect(geo.boundingBox!.max.x).toBeCloseTo(.0175, 5)
      geo.dispose()
    }
  })
  it('forms a hollow beaker with a closed heel and pulled-out pouring lip', () => {
    const geo=beakerGeometry(.03,.08,64)
    const mesh=new THREE.Mesh(geo,material)
    expect(rayAt(mesh,0,0)[0].point.y).toBeCloseTo(.0025)
    geo.computeBoundingBox()
    expect(geo.boundingBox!.max.z).toBeGreaterThan(.036)
    expect(geo.boundingBox!.min.z).toBeGreaterThan(-.031)
    expect(geo.boundingBox!.max.y).toBeCloseTo(.08)
    geo.dispose()
  })
  it('keeps a media bottle neck open, with a closed heel and broad shoulders', () => {
    const geo=mediaBottleGeometry(.023,.079,32)
    const mesh=new THREE.Mesh(geo,material)
    expect(rayAt(mesh,0,0)[0].point.y).toBeCloseTo(.00276)
    expect(rayAt(mesh,.019,0)[0].point.y).toBeGreaterThan(.05)
    expect(rayAt(mesh,.019,0)[0].point.y).toBeLessThan(.07)
    geo.dispose()
  })
  it('leaves a tapered waste container hollow all the way down to its floor', () => {
    const geo=wasteBodyGeometry(.15,.15,.19)
    const mesh=new THREE.Mesh(geo,material)
    expect(rayAt(mesh,0,0)[0].point.y).toBeCloseTo(.002)
    expect(rayAt(mesh,.07,0)[0].point.y).toBeGreaterThan(.13)
    expect(rayAt(mesh,.07,0)[0].point.y).toBeLessThan(.15)
    expect(rayAt(mesh,.074,0)[0].point.y).toBeCloseTo(.19)
    expect(rayAt(mesh,.08,0)).toHaveLength(0)
    geo.dispose()
  })

  it('builds a sloping control shoulder while leaving the centrifuge chamber open', () => {
    const geo = instrumentCasingGeometry({ width: 0.29, depth: 0.48, deckHeight: 0.24, frontHeight: 0.158, shoulderDepth: 0.09, baseHeight: 0.03, holes: [{ x: 0, z: -0.03, radius: 0.107 }] })
    const mesh = new THREE.Mesh(geo, material)
    expect(rayAt(mesh, 0, -0.03)[0].point.y).toBeLessThan(0.04)
    const rearShoulder = rayAt(mesh, 0, 0.17)[0].point.y
    const frontShoulder = rayAt(mesh, 0, 0.22)[0].point.y
    expect(rearShoulder).toBeGreaterThan(frontShoulder + 0.03)
    expect(frontShoulder).toBeGreaterThan(0.158)
    geo.computeBoundingBox()
    expect(geo.boundingBox!.max.x).toBeCloseTo(0.145)
    expect(geo.boundingBox!.min.z).toBeCloseTo(-0.24)
    geo.dispose()
  })

  it('lets a reader tray pass through the loading panel', () => {
    const geo = loadingPanelGeometry(0.438, 0.194, 0.003, { x: -0.105, y: 0.021, width: 0.21, height: 0.05 })
    const mesh = new THREE.Mesh(geo, material)
    mesh.updateMatrixWorld(true)
    const forward = new THREE.Vector3(0, 0, -1)
    expect(new THREE.Raycaster(new THREE.Vector3(-0.105, 0.021, 1), forward).intersectObject(mesh)).toHaveLength(0)
    expect(new THREE.Raycaster(new THREE.Vector3(0.12, 0.021, 1), forward).intersectObject(mesh).length).toBeGreaterThan(0)
    geo.dispose()
  })

  it('retains a continuous rotor face with open bores in both rotor sizes', () => {
    for (const count of [12, 24]) {
      const geo = rotorCrownGeometry(count, 12, count === 12 ? 0.09 : 0.096)
      const mesh = new THREE.Mesh(geo, material)
      for (let i = 0; i < count; i++) {
        const mouth = new THREE.Vector3(0, 0.04, 0).applyMatrix4(rotorSocket(i, count))
        expect(rayAt(mesh, mouth.x, mouth.z)).toHaveLength(0)
      }
      expect(rayAt(mesh, 0, 0)[0].point.y).toBeCloseTo(0.053)
      geo.dispose()
    }
  })

  it('keeps the vortex fascia ahead of the cast front rather than buried in its bevel', () => {
    const model = fixture('full', vortex)
    const angle = -Math.atan2(0.035, 0.083)
    const normal = new THREE.Vector3(0, -Math.sin(angle), Math.cos(angle))
    const up = new THREE.Vector3(0, Math.cos(angle), Math.sin(angle))
    const target = new THREE.Vector3(-0.02, 0.0835, 0.0625).addScaledVector(up, 0.02)
    model.group.updateMatrixWorld(true)
    const hits = new THREE.Raycaster(target.addScaledVector(normal, 0.05), normal.negate()).intersectObject(model.group, true)
    expect(hits[0].object.name).toBe('equipment:paper')
    model.dispose()
  })
  it('cuts off-centre apertures through the full thickness of the housing', () => {
    const geo = perforatedDeck(0.3, 0.42, 0.205, [{ x: 0, z: -0.018, radius: 0.107 }], 0.018, 48)
    const mesh = new THREE.Mesh(geo, material)
    expect(rayAt(mesh, 0, -0.018)).toHaveLength(0)
    expect(rayAt(mesh, 0.08, -0.018)).toHaveLength(0)
    expect(rayAt(mesh, 0.13, -0.018)[0].point.y).toBeCloseTo(0.205)
    geo.dispose()
  })

  it('leaves the vessel mouth open and closes its floor below the rim', () => {
    const geo = vesselGeometry(0.0076, 0.0058, 0.04, 0.0011, 16)
    const hits = rayAt(new THREE.Mesh(geo, material), 0.0001, 0)
    expect(hits[0].point.y).toBeCloseTo(0.0011)
    expect(hits[0].point.y).toBeLessThan(0.04)
    geo.dispose()
  })

  it('preserves all 96 plate apertures at their existing pitch', () => {
    const holes = Array.from({ length: 96 }, (_, i) => ({ x: (i % 12 - 5.5) * 0.009, z: (Math.floor(i / 12) - 3.5) * 0.009, radius: 0.0036 }))
    const geo = perforatedDeck(0.12776, 0.08548, 0.0011, holes)
    const mesh = new THREE.Mesh(geo, material)
    for (const hole of holes) expect(rayAt(mesh, hole.x, hole.z)).toHaveLength(0)
    expect(rayAt(mesh, 0, 0)).not.toHaveLength(0)
    geo.dispose()
  })

  it('bevels the housing without expanding its footprint or filling its chamber', () => {
    const geo = perforatedDeck(0.3, 0.42, 0.205, [{ x: 0, z: -0.018, radius: 0.107 }], 0.018, 32, 0.0025)
    geo.computeBoundingBox()
    expect(geo.boundingBox!.min.y).toBeCloseTo(0)
    expect(geo.boundingBox!.max.y).toBeCloseTo(0.205)
    expect(geo.boundingBox!.max.x).toBeCloseTo(0.15)
    expect(rayAt(new THREE.Mesh(geo, material), 0.08, -0.018)).toHaveLength(0)
    geo.dispose()
  })

  it('shades recessed interiors while retaining the bright outer rim', () => {
    const geo = shadeVesselInterior(vesselGeometry(0.0036, 0.00285, 0.0109, 0.00035), 0.0109)
    const colors = geo.getAttribute('color')
    const values = [...colors.array]
    expect(values.every(Number.isFinite)).toBe(true)
    expect(Math.min(...values)).toBeGreaterThan(0)
    expect(Math.min(...values)).toBeLessThan(0.5)
    expect(Math.max(...values)).toBe(1)
    geo.dispose()
  })

  it('aligns all 24 sockets radially outward at 45 degrees', () => {
    for (let i = 0; i < 24; i++) {
      const frame = rotorSocket(i)
      const axis = new THREE.Vector3(0, 1, 0).transformDirection(frame)
      const base = new THREE.Vector3().setFromMatrixPosition(frame)
      const radial = new THREE.Vector3(base.x, 0, base.z).normalize()
      expect(axis.y).toBeCloseTo(Math.SQRT1_2)
      expect(axis.dot(radial)).toBeCloseTo(Math.SQRT1_2)
      const tubeTop = new THREE.Vector3(0, 0.042, 0).applyMatrix4(frame)
      const capBase = new THREE.Vector3(0, 0.044 - 0.002, 0).applyMatrix4(frame)
      expect(tubeTop.distanceTo(capBase)).toBeLessThan(1e-8)
    }
  })

  for (const detail of ['full', 'reduced'] as const) {
    it(`retains real rack openings on ${detail}`, () => {
      const model = fixture(detail, (b) => tubeRack(b, 0, 0, '#3973ab', 6, 2))
      // Looking down an empty socket reaches the lower shelf, not a painted top.
      const hit = rayAt(model.group, -2.5 * 0.0215, -0.5 * 0.0215, 0.06)[0]
      expect(hit.point.y).toBeCloseTo(0.006)
      model.dispose()
    })

    it(`keeps the decorative microfuge chamber clear on ${detail}`, () => {
      const model = fixture(detail, microfuge)
      const plastic = model.meshes.find((entry) => entry.mat === 'plastic')!.mesh
      const hits = rayAt(plastic, 0.09, -0.01, 0.16)
      // A casing floor is allowed beneath the bowl; no plastic may cap the opening.
      expect(hits.every(hit => hit.point.y < 0.03)).toBe(true)
      model.dispose()
    })

    it(`builds finite, bounded models in a small material batch on ${detail}`, () => {
      for (const build of [pipetteStand, sharpsBin, (b: Batch) => bottle(b,0,0,.023,.079), compoundMicroscope, stereoMicroscope, plateReader, plateStack, thermocycler, vortex, (b: Batch) => tipBox(b, 0, 0, '#3973ab')]) {
        const model = fixture(detail, build)
        expect(model.group.children.length).toBeLessThanOrEqual(8)
        model.group.traverse((o) => {
          const mesh = o as THREE.Mesh
          if (!mesh.isMesh) return
          for (const attr of Object.values(mesh.geometry.attributes)) expect([...attr.array].every(Number.isFinite)).toBe(true)
        })
        expect(new THREE.Box3().setFromObject(model.group).max.y).toBeLessThan(0.48)
        model.dispose()
      }
    })

    it(`leaves the static sharps disposal opening clear on ${detail}`, () => {
      const model=fixture(detail,sharpsBin)
      const hit=rayAt(model.group,-.02,0,.27)[0]
      expect(hit.point.y).toBeCloseTo(.002)
      expect(rayAt(model.group,.085,0,.27)[0].point.y).toBeGreaterThan(.24)
      model.dispose()
    })

    it(`keeps closed storage boxes inside their stacking pitch on ${detail}`, () => {
      const model = fixture(detail, (b) => tipBox(b, 0, 0, '#3973ab', 0, true))
      expect(new THREE.Box3().setFromObject(model.group).max.y).toBeLessThanOrEqual(0.064001)
      model.dispose()
    })
  }
})

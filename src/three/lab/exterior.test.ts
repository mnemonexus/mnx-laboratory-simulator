import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { buildExterior, EXTERIOR_FAR, EXTERIOR_FLOOR_PITCH, EXTERIOR_GROUND_Y, EXTERIOR_WINDOWS, exteriorVisible } from './exterior'
import type { ExteriorTextures } from './exteriorTextures'

function cameraAt(position: THREE.Vector3, target: THREE.Vector3) {
  const camera = new THREE.PerspectiveCamera(52, 1.5, 0.03, EXTERIOR_FAR)
  camera.position.copy(position)
  camera.lookAt(target)
  camera.updateMatrixWorld(true)
  return { camera, frustum: new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)) }
}

function fixture(reduced: boolean) {
  const textures = Object.fromEntries(['trees', 'ground', 'paving', 'facade', 'shadow', 'sky', 'wall'].map((key) => [key, new THREE.Texture()])) as unknown as ExteriorTextures
  return buildExterior(textures, reduced)
}

describe('window-only exterior', () => {
  it('shows through every exterior window orientation, only from its indoor side', () => {
    for (const w of EXTERIOR_WINDOWS) {
      const center = new THREE.Vector3(w.center[0], (w.sill + w.head) / 2, w.center[1])
      const inward = new THREE.Vector3(w.normal[0], 0, w.normal[1])
      const inside = center.clone().addScaledVector(inward, 2)
      const outside = center.clone().addScaledVector(inward, -2)
      expect(exteriorVisible(new Set([w.zone]), inside, cameraAt(inside, center).frustum), w.id).toBe(true)
      // In the three-sided hub the camera can see a different window from
      // outside this one; only single-window rooms have no other portal.
      if (EXTERIOR_WINDOWS.filter((other) => other.zone === w.zone).length === 1) {
        expect(exteriorVisible(new Set([w.zone]), outside, cameraAt(outside, center).frustum), w.id).toBe(false)
      }
    }
  })

  it('culls hidden rooms and windows behind the camera', () => {
    const position = new THREE.Vector3(2.45, 1.4, 0)
    const ahead = cameraAt(position, new THREE.Vector3(12, 1.7, 0)).frustum
    const behind = cameraAt(position, new THREE.Vector3(-10, 1.4, 0)).frustum
    expect(exteriorVisible(new Set(['main']), position, ahead)).toBe(true)
    expect(exteriorVisible(new Set(['main']), position, behind)).toBe(false)
    expect(exteriorVisible(new Set(['post']), position, ahead)).toBe(false)
    // A visible room reached through an open door must still allow its window.
    expect(exteriorVisible(new Set(['post', 'main']), position, ahead)).toBe(true)
  })

  it('keeps ground and first floors below the UK second-floor lab', () => {
    expect(EXTERIOR_GROUND_Y).toBe(-2 * EXTERIOR_FLOOR_PITCH)
    const exterior = fixture(false)
    const lawn = exterior.root.getObjectByName('exterior:lawn') as THREE.Mesh
    lawn.geometry.computeBoundingBox()
    expect(lawn.geometry.boundingBox!.max.y).toBeLessThan(EXTERIOR_GROUND_Y)
    const facade = exterior.root.getObjectByName('exterior:distant-buildings') as THREE.Mesh
    facade.geometry.computeBoundingBox()
    expect(facade.geometry.boundingBox!.min.y).toBeLessThanOrEqual(EXTERIOR_GROUND_Y + 0.001)
    exterior.dispose()
  })

  it('adds depth under a bounded static geometry/material budget on both tiers', () => {
    for (const reduced of [true, false]) {
      const exterior = fixture(reduced)
      let triangles = 0
      exterior.root.traverse((o) => {
        expect((o as THREE.Light).isLight).not.toBe(true)
        expect(o.matrixAutoUpdate).toBe(false)
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        expect(mesh.castShadow).toBe(false)
        triangles += mesh.geometry.index ? mesh.geometry.index.count / 3 : mesh.geometry.getAttribute('position').count / 3
        for (const attr of Object.values(mesh.geometry.attributes)) expect([...attr.array].every(Number.isFinite), mesh.name).toBe(true)
      })
      expect(exterior.root.children.length).toBeLessThanOrEqual(7)
      expect(triangles).toBeLessThan(14000)
      expect(exterior.treeCount).toBeGreaterThan(70)
      const trees = exterior.root.getObjectByName('exterior:tree-cards') as THREE.Mesh
      trees.geometry.computeBoundingBox()
      expect(trees.geometry.boundingBox!.max.y).toBeGreaterThan(0)
      expect(trees.geometry.boundingBox!.min.y).toBeLessThan(EXTERIOR_GROUND_Y)
      expect((trees.material as THREE.Material).transparent).toBe(false)
      exterior.dispose()
    }
  })

  it('reduces distant foliage on Low without collapsing the depth layers', () => {
    const low = fixture(true), full = fixture(false)
    expect(low.treeCount).toBeLessThan(full.treeCount)
    // Fog replaces the former far belts rather than adding cost on top of them.
    expect(full.treeCount).toBeLessThan(120)
    low.dispose()
    full.dispose()
  })
})

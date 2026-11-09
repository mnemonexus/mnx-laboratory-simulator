import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { rayBoxesDistance } from './occlusion'

describe('line of sight against occluder boxes', () => {
  const ray = new THREE.Ray(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1))
  it('reports the nearest box entered within range', () => {
    const boxes = [-0.5, 0, 2, 0.5, 2, 3, -0.5, 0, 1, 0.5, 2, 1.5]
    expect(rayBoxesDistance(ray, boxes, 10)).toBeCloseTo(1)
    expect(rayBoxesDistance(ray, boxes, 0.8)).toBe(0.8)
  })
  it('ignores boxes beside, behind and around the ray origin', () => {
    expect(rayBoxesDistance(ray, [1, 0, 1, 2, 2, 2], 10)).toBe(10)
    expect(rayBoxesDistance(ray, [-0.5, 0, -3, 0.5, 2, -1], 10)).toBe(10)
    expect(rayBoxesDistance(ray, [-0.5, 0, -1, 0.5, 2, 1], 10)).toBe(10)
  })
  it('handles axis-parallel rays', () => {
    const down = new THREE.Ray(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, -1, 0))
    expect(rayBoxesDistance(down, [-1, 0, -1, 1, 0.9, 1], 5)).toBeCloseTo(1.1)
  })
})

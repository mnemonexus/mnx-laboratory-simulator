import { describe, expect, it } from 'vitest'
import { CHAIR_SHADOW_RES as R, CHAIR_SHADOW_SIZE as S, chairShadow } from './chairShadow'
import type { BakeEmitter } from './bake'

// a small downward panel at (x, 2.7, z)
const panel = (x: number, z: number, half = 0.05): BakeEmitter => ({ kind: 'rect', c: [x, 2.7, z], a: [half, 0, 0], b: [0, 0, half], n: [0, -1, 0], L: [6, 6, 6] })
const at = (alpha: Uint8Array, x: number, z: number) => alpha[Math.floor((z / S + 0.5) * R) * R + Math.floor((x / S + 0.5) * R)] / 255
const pose = { x: 0, z: 0, yaw: 0 }
const room = (...emitters: BakeEmitter[]) => ({ emitters, occluders: [] as number[] })

describe('chair shadows from the room\'s lights', () => {
  it('falls straight under the seat from a light overhead', () => {
    const alpha = new Uint8Array(R * R)
    chairShadow(room(panel(0, 0)), pose, alpha)
    expect(at(alpha, 0, 0.05)).toBeGreaterThan(0.5)
    expect(at(alpha, 0.7, 0.7)).toBeLessThan(0.03)
  })

  it('is cast away from a light to one side', () => {
    const alpha = new Uint8Array(R * R)
    chairShadow(room(panel(2, 0)), pose, alpha)
    // the seat (0.5 up) throws its shadow towards -x, away from the light
    expect(at(alpha, -0.35, 0.05)).toBeGreaterThan(0.5)
    expect(at(alpha, 0.35, 0.05)).toBeLessThan(0.1)
  })

  it('casts one shadow per light, each as dark as that light\'s share', () => {
    const one = new Uint8Array(R * R)
    chairShadow(room(panel(2, 0)), pose, one)
    const two = new Uint8Array(R * R)
    chairShadow(room(panel(2, 0), panel(-2, 0)), pose, two)
    // two shadows of the seat, either side, each from half the light
    expect(at(two, -0.35, 0.05)).toBeGreaterThan(0.25)
    expect(at(two, 0.35, 0.05)).toBeGreaterThan(0.25)
    expect(at(two, -0.35, 0.05)).toBeLessThan(at(one, -0.35, 0.05) * 0.7)
    // darkest where both overlap, under the column
    expect(at(two, 0, 0)).toBeGreaterThan(at(two, -0.35, 0.05))
  })

  it('softens with a wider light: a thin arm only dims the floor (antumbra)', () => {
    const point = new Uint8Array(R * R)
    chairShadow(room(panel(0, 0, 0.02)), pose, point)
    const wide = new Uint8Array(R * R)
    chairShadow(room(panel(0, 0, 1.2)), pose, wide)
    // just outside the seat's footprint, under an arm: dark from a small light, faint from a wide one
    const ax = 0.27 * Math.cos(0.3), az = -0.27 * Math.sin(0.3)
    expect(at(point, ax, az)).toBeGreaterThan(at(wide, ax, az))
  })

  it('ignores a light the room hides from the chair', () => {
    // a strip behind and above a worktop the chair sits in front of
    const strip: BakeEmitter = { kind: 'spot', p: [1.2, 1.43, 0], d: [0, -1, 0], exp: 1, I: [3, 3, 3], range: 4 }
    const worktop = [0.4, 0.86, -1, 2, 0.9, 1]
    const open = new Uint8Array(R * R)
    chairShadow({ emitters: [panel(0, 0), strip], occluders: [] }, pose, open)
    const hidden = new Uint8Array(R * R)
    chairShadow({ emitters: [panel(0, 0), strip], occluders: worktop }, pose, hidden)
    // with the strip hidden the panel overhead is all the direct light, so the seat's shadow is darker
    expect(at(hidden, 0, 0.05)).toBeGreaterThan(at(open, 0, 0.05) + 0.1)
  })
})

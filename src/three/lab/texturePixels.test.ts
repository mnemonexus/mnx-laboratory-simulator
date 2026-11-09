import { expect, it } from 'vitest'
import { normalPixels } from '../texturePixels'

function reference(source: Float32Array | Uint8ClampedArray, width: number, height: number, strength: number, rgba = false) {
  const out = new Uint8ClampedArray(width * height * 4)
  const at = (x: number, y: number) => source[(((y + height) % height) * width + ((x + width) % width)) * (rgba ? 4 : 1)] / (rgba ? 255 : 1)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * strength
    const dy = (at(x, y + 1) - at(x, y - 1)) * strength
    const length = Math.hypot(dx, dy, 1), i = (y * width + x) * 4
    out[i] = rgba ? (-dx / length * 0.5 + 0.5) * 255 : -dx / length * 127.5 + 127.5
    out[i + 1] = rgba ? (-dy / length * 0.5 + 0.5) * 255 : -dy / length * 127.5 + 127.5
    out[i + 2] = 1 / length * 255; out[i + 3] = 255
  }
  return out
}

it('preserves the reference normal-map bytes, wrapping, handedness and both encoding paths', () => {
  for (const [width, height] of [[1, 1], [1, 13], [17, 1], [31, 17], [256, 256]]) for (const rgba of [false, true]) {
    let seed = 19
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
    const source = rgba ? Uint8ClampedArray.from({ length: width * height * 4 }, () => random() * 255) : Float32Array.from({ length: width * height }, random)
    for (const strength of [0, 0.35, 0.55, 0.6, 1.1, 2.2]) expect(normalPixels(source, width, height, strength, rgba)).toEqual(reference(source, width, height, strength, rgba))
  }
})

it('rejects invalid dimensions and produces a flat opaque normal for constant height', () => {
  expect(Array.from(normalPixels(new Float32Array(4).fill(0.5), 2, 2, 1))).toEqual([128, 128, 255, 255, 128, 128, 255, 255, 128, 128, 255, 255, 128, 128, 255, 255])
  expect(() => normalPixels(new Float32Array(3), 2, 2, 1)).toThrow(/height/)
  expect(() => normalPixels(new Float32Array(0), 0, 2, 1)).toThrow(/height/)
  const target = new Uint8ClampedArray(16)
  expect(normalPixels(new Float32Array(4).fill(0.5), 2, 2, 1, false, target)).toBe(target)
  expect(target).toEqual(normalPixels(new Float32Array(4).fill(0.5), 2, 2, 1))
  const aliased = new Uint8ClampedArray(16)
  expect(() => normalPixels(aliased, 2, 2, 1, true, aliased)).toThrow(/output/)
})

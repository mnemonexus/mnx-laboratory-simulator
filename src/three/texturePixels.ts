/** Tile-wrapped central-difference normal pixels. Procedural heights are bounded
 * (0..1 or byte red channels); direct neighbour indices avoid four modulo-heavy
 * sampling calls per pixel. This operates on graphics data, never lab science.
 */
export function normalPixels(source: Float32Array | Uint8ClampedArray, width: number, height: number, strength: number, rgba = false, target?: Uint8ClampedArray): Uint8ClampedArray {
  const stride = rgba ? 4 : 1
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || source.length !== width * height * stride || !Number.isFinite(strength)) throw new Error('Invalid procedural height map')
  if (target && (target.length !== width * height * 4 || target.buffer === source.buffer)) throw new Error('Invalid procedural normal output')
  const out = target ?? new Uint8ClampedArray(width * height * 4)
  const row = width * stride
  for (let y = 0; y < height; y++) {
    const current = y * row
    const above = (y === 0 ? height - 1 : y - 1) * row
    const below = (y + 1 === height ? 0 : y + 1) * row
    for (let x = 0; x < width; x++) {
      const left = (x === 0 ? width - 1 : x - 1) * stride
      const right = (x + 1 === width ? 0 : x + 1) * stride
      const column = x * stride
      const dx = (rgba ? source[current + right] / 255 - source[current + left] / 255 : source[current + right] - source[current + left]) * strength
      const dy = (rgba ? source[below + column] / 255 - source[above + column] / 255 : source[below + column] - source[above + column]) * strength
      const length = Math.sqrt(dx * dx + dy * dy + 1)
      const i = (y * width + x) * 4
      out[i] = rgba ? (-dx / length * 0.5 + 0.5) * 255 : -dx / length * 127.5 + 127.5
      out[i + 1] = rgba ? (-dy / length * 0.5 + 0.5) * 255 : -dy / length * 127.5 + 127.5
      out[i + 2] = 1 / length * 255
      out[i + 3] = 255
    }
  }
  return out
}

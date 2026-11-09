import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { normalPixels } from '../../src/three/texturePixels.ts'
import { distribution } from '../../src/three/lab/performance.ts'

function reference(source, size, strength, rgba) {
  const out = new Uint8ClampedArray(size * size * 4)
  const at = (x, y) => source[(((y + size) % size) * size + ((x + size) % size)) * (rgba ? 4 : 1)] / (rgba ? 255 : 1)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * strength, dy = (at(x, y + 1) - at(x, y - 1)) * strength
    const length = Math.hypot(dx, dy, 1), i = (y * size + x) * 4
    out[i] = rgba ? (-dx / length * 0.5 + 0.5) * 255 : -dx / length * 127.5 + 127.5
    out[i + 1] = rgba ? (-dy / length * 0.5 + 0.5) * 255 : -dy / length * 127.5 + 127.5
    out[i + 2] = (1 / length) * 255; out[i + 3] = 255
  }
  return out
}
const results = []
for (const [size, rgba] of [[256, true], [512, false], [1024, false], [2048, false]]) {
  let seed = 19
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
  const input = rgba ? Uint8ClampedArray.from({ length: size * size * 4 }, () => random() * 255) : Float32Array.from({ length: size * size }, random)
  const strength = rgba ? 0.55 : 0.6
  const expected = reference(input, size, strength, rgba), actual = normalPixels(input, size, size, strength, rgba)
  assert.ok(Buffer.from(expected.buffer).equals(Buffer.from(actual.buffer)), 'Normal pixels match the reference bytes')
  const samples = { reference: [], optimized: [] }
  for (let i = 0; i < 11; i++) for (const key of i % 2 ? ['optimized', 'reference'] : ['reference', 'optimized']) {
    const start = performance.now()
    const pixels = key === 'optimized' ? normalPixels(input, size, size, strength, rgba) : reference(input, size, strength, rgba)
    const ms = performance.now() - start
    assert.equal(pixels.length, size * size * 4)
    if (i >= 2) samples[key].push(ms)
  }
  results.push({ size, rgba, byteEquivalent: true, referenceMs: distribution(samples.reference), optimizedMs: distribution(samples.optimized), samples })
}
const source = createHash('sha256').update(readFileSync('src/three/texturePixels.ts')).digest('hex')
const report = { schema: 'lab-normal-pixel-performance/1', createdAt: new Date().toISOString(), cpu: cpus()[0]?.model, node: process.version, sourceSha256: source, warmupRuns: 2, measuredRuns: 9, results, limitations: ['Measures pixel computation and allocation only; excludes canvas readback, GPU uploads and image decoding.', 'Shared-machine numerical samples, not physical mobile or whole-startup guarantees.'] }
mkdirSync('output/performance', { recursive: true })
writeFileSync('output/performance/normal-pixels.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(results.map(r => ({ size: r.size, rgba: r.rgba, referenceMs: r.referenceMs.median, optimizedMs: r.optimizedMs.median })), null, 2))

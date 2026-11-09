import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fitFourPL, fitMichaelisMenten, inverse, predict } from '../../packages/lab-core/src/analysis/analysis.ts'
import { installScientificNumerics } from '../../packages/lab-core/src/models/numerics.ts'
import { createRustScience } from './rustScience'
import { SCIENCE_WASM_BASE64 } from './science.wasm.gen'
import { catalogue, practicals } from './content'
import { compile } from '../../packages/lab-core/src/index.ts'

beforeEach(() => installScientificNumerics(null))
afterEach(() => installScientificNumerics(null))
const close = (actual: number, expected: number, tolerance = 1e-7) => {
  if (Number.isNaN(expected)) expect(actual).toBeNaN()
  else if (!Number.isFinite(expected)) expect(actual).toBe(expected)
  else expect(Math.abs(actual - expected) / Math.max(1, Math.abs(expected))).toBeLessThan(tolerance)
}

describe('Rust/Wasm nonlinear curve fitting', () => {
  it('matches increasing/decreasing noisy 4PL curves, residuals and uncertainty over concentration scales', async () => {
    const rust = await createRustScience()
    for (const scale of [1e-6, 1, 1e6]) for (const decreasing of [false, true]) {
      const x = [0, 0.01, 0.1, 0.3, 1, 3, 10, 30, 100].map(v => v * scale)
      const a = decreasing ? 2.1 : 0.05, d = decreasing ? 0.05 : 2.1
      const y = x.map((v, i) => d + (a - d) / (1 + (v / (2 * scale)) ** 1.2) + 0.003 * Math.sin(i * 2.3))
      const reference = fitFourPL(x, y)
      const actual = rust.fitFourPL(x, y)
      for (const key of ['a', 'd', 'c', 'b', 'seA', 'seD', 'seC', 'seB', 'r2', 'sy'] as const) close(actual[key], reference[key])
      close(actual.c / scale, reference.c / scale)
      close(actual.seC / scale, reference.seC / scale)
      actual.residuals.forEach((r, i) => close(r, reference.residuals[i], 1e-9))
      expect(actual.n).toBe(x.length)
      const unknown = 1.4 * scale
      close(inverse(actual, predict(actual, unknown)), unknown, 1e-10)
    }
    const x = [0, 0.1, 0.3, 1, 3, 10, 30]
    const y = x.map(v => 2.2 + (0.05 - 2.2) / (1 + (v / 2) ** 1.3))
    const fit = rust.fitFourPL(x, y)
    ;[fit.a, fit.d, fit.c, fit.b].forEach((value, i) => close(value, [0.05, 2.2, 2, 1.3][i], 1e-7))
    // Replicates and acquisition order belong to their original observations.
    const order = [6, 1, 1, 4, 0, 5, 3, 2]
    const shuffledX = order.map(i => x[i]), shuffledY = order.map((i, k) => y[i] + 0.001 * Math.sin(k))
    const shuffledReference = fitFourPL(shuffledX, shuffledY), shuffled = rust.fitFourPL(shuffledX, shuffledY)
    shuffled.residuals.forEach((value, i) => close(value, shuffledReference.residuals[i], 1e-9))
  })

  it('matches enzyme parameters, residuals and errors, and preserves public input filtering', async () => {
    const rust = await createRustScience()
    for (const substrateScale of [1e-6, 1, 1e6]) for (const rateScale of [0.001, 1, 1e6]) {
      const x = [0.02, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6].map(v => v * substrateScale)
      const y = x.map((v, i) => rateScale * (52 * v / (0.18 * substrateScale + v) + 0.02 * Math.sin(i)))
      const expected = fitMichaelisMenten(x, y), actual = rust.fitMichaelisMenten(x, y)
      for (const key of ['vmax', 'km', 'seVmax', 'seKm', 'r2'] as const) close(actual[key], expected[key], 1e-8)
      close(actual.km / substrateScale, expected.km / substrateScale, 1e-8)
      close(actual.seKm / substrateScale, expected.seKm / substrateScale, 1e-8)
      close(actual.vmax / rateScale, expected.vmax / rateScale, 1e-8)
      close(actual.seVmax / rateScale, expected.seVmax / rateScale, 1e-8)
      actual.residuals.forEach((r, i) => close(r / rateScale, expected.residuals[i] / rateScale, 1e-8))
    }
    const x = [0, -1, NaN, 0.02, 0.1, 0.4, 1.6], y = [Infinity, 3, 5, 5.2, 18, 36, 47]
    const expected = fitMichaelisMenten(x, y)
    installScientificNumerics(rust)
    const actual = fitMichaelisMenten(x, y)
    expect(actual.n).toBe(4)
    close(actual.vmax, expected.vmax)
    close(actual.km, expected.km)
    // The public 4PL API still truncates to paired observations.
    const fx = [0, 0.1, 0.3, 1, 3, 10, 30, 100]
    const fy = fx.slice(0, 7).map(v => 2 + (0.1 - 2) / (1 + v))
    expect(fitFourPL(fx, fy).n).toBe(7)
  })

  it('preserves undefined uncertainty instead of inventing precise standard errors', async () => {
    const rust = await createRustScience()
    const x = [0, 0.1, 0.3, 1, 3, 10, 30], y = x.map(() => 1)
    const expected = fitFourPL(x, y), actual = rust.fitFourPL(x, y)
    for (const key of ['a', 'd', 'c', 'b', 'seA', 'seD', 'seC', 'seB', 'r2', 'sy'] as const) close(actual[key], expected[key])
    const zero = rust.fitMichaelisMenten([0.1, 0.2, 0.3], [0, 0, 0])
    expect(zero.vmax).toBe(0)
    expect(zero.seVmax).toBeNaN()
    expect(zero.seKm).toBeNaN()
    expect(zero.residuals).toEqual([0, 0, 0])
  })

  it('owns returned results across large allocating fits and rejects malformed ABI batches', async () => {
    const rust = await createRustScience()
    const x = [0, 0.1, 0.3, 1, 3, 10, 30], y = x.map(v => 2 + (0.1 - 2) / (1 + v))
    const earlier = rust.fitFourPL(x, y), saved = structuredClone(earlier)
    const largeX = Array.from({ length: 10000 }, (_, i) => 10 ** (-3 + 6 * i / 9999))
    const largeY = largeX.map(v => 2 + (0.1 - 2) / (1 + v))
    const large = rust.fitFourPL(largeX, largeY)
    close(large.c, 1, 1e-7)
    expect(earlier).toEqual(saved)
    expect(() => rust.fitFourPL(x, y.slice(1))).toThrow(/paired/)
    expect(() => rust.fitFourPL([0, 1, 2, 3, 4], [1, 2, NaN, 4, 5])).toThrow(/domain/)
    expect(() => rust.fitFourPL(new Array(22000).fill(1), new Array(22000).fill(1))).toThrow(/capacity/)
    const binary = Uint8Array.from(atob(SCIENCE_WASM_BASE64), character => character.charCodeAt(0))
    const { instance } = await WebAssembly.instantiate(binary)
    for (const name of ['lab_fit_four_pl', 'lab_fit_michaelis_menten']) {
      const solve = instance.exports[name] as (count: number) => number
      for (const n of [4294967295, 21844, 1, 0]) expect(solve(n)).toBe(0)
    }
    const exports = instance.exports as WebAssembly.Exports & { memory: WebAssembly.Memory; lab_scratch_ptr: () => number; lab_fit_four_pl: (n: number) => number }
    const beforeBytes = exports.memory.buffer.byteLength
    const packed = new Float64Array(exports.memory.buffer, exports.lab_scratch_ptr(), 2 * largeX.length)
    largeX.forEach((value, i) => { packed[2 * i] = value; packed[2 * i + 1] = largeY[i] })
    expect(exports.lab_fit_four_pl(largeX.length)).toBe(1)
    expect(exports.memory.buffer.byteLength).toBeGreaterThan(beforeBytes)
  })

  for (const [id, method] of [['bio14-elisa-four-parameter', 'fitFourPL'], ['bio19-michaelis-menten-from-rates', 'fitMichaelisMenten']] as const) {
    it(`preserves recorded fits and goals in ${id}`, async () => {
      const rust = await createRustScience(), input = practicals().find(p => p.id === id)!.json
      for (const seed of [1, 17, 42]) {
        installScientificNumerics(null)
        const expected = compile(input, catalogue().catalogue, { seed, rehearse: true })
        let calls = 0
        installScientificNumerics({ ...rust,
          fitFourPL: (...args) => { if (method === 'fitFourPL') calls++; return rust.fitFourPL(...args) },
          fitMichaelisMenten: (...args) => { if (method === 'fitMichaelisMenten') calls++; return rust.fitMichaelisMenten(...args) },
        })
        const actual = compile(input, catalogue().catalogue, { seed, rehearse: true })
        expect(actual.rehearsal!.ok).toBe(true)
        expect(actual.rehearsal!.goals).toEqual(expected.rehearsal!.goals)
        expect(actual.rehearsal!.events).toBe(expected.rehearsal!.events)
        expect(calls).toBeGreaterThan(0)
        const recorded = (r: typeof actual) => r.kernel!.world.notebook.filter(entry => typeof entry.value === 'number').map(entry => ({ field: entry.field, value: entry.value as number }))
        const reference = recorded(expected), obtained = recorded(actual)
        expect(obtained.map(entry => entry.field)).toEqual(reference.map(entry => entry.field))
        obtained.forEach((entry, i) => close(entry.value, reference[i].value, 1e-7))
      }
    }, 300000)
  }
})

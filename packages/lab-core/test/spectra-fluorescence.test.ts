// Absorbance scans and fluorescence: an isosbestic point, spectrum maxima, an environment-sensitive
// probe that lights up and blue-shifts when bound, the inner filter effect, and the ANS practical.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { addEquipment, addSupply, createKernel, emptyWorld, type Kernel } from '../src/kernel/index.ts'
import { boundLigand } from '../src/models/fluorescence.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

function bench(cuvettes: Record<string, Array<{ substance: string; conc: string }>>, container = 'core:cuvette-quartz-1cm'): Kernel {
  const w = emptyWorld(1)
  addEquipment(w, cat, 'uv', 'core:spectrophotometer.uv-vis')
  addEquipment(w, cat, 'fl', 'core:fluorimeter')
  for (const [id, components] of Object.entries(cuvettes)) addSupply(w, cat, { id, label: id, container, amount: '3 mL', components })
  return createKernel(cat, w, { noise: 0 })
}
type Out = Record<string, number & number[]>
const run = (k: Kernel, params: Record<string, unknown>) => {
  const r = k.execute({ op: 'core:measure', params })
  if (!r.ok) throw new Error(r.refusal.message)
  return r.outputs as unknown as Out
}
const phosphate = (pH: number) => [{ substance: 'core:potassium-dihydrogen-phosphate', conc: `${50 / (1 + 10 ** (pH - 7.2))} mM` }, { substance: 'core:disodium-hydrogen-phosphate', conc: `${50 - 50 / (1 + 10 ** (pH - 7.2))} mM` }]

describe('absorbance scans', () => {
  it('4-nitrophenol and its anion cross at 348 nm: the isosbestic absorbance does not move with pH', () => {
    const k = bench({ acid: [{ substance: 'bio:p-nitrophenol', conc: '50 uM' }, ...phosphate(5)], base: [{ substance: 'bio:p-nitrophenol', conc: '50 uM' }, ...phosphate(9)] })
    const a = run(k, { instrument: 'uv', subject: 'acid', mode: 'scan', from: '300 nm', to: '450 nm' })
    const b = run(k, { instrument: 'uv', subject: 'base', mode: 'scan', from: '300 nm', to: '450 nm' })
    const at = (o: Out, nm: number) => o.absorbance[o.wavelengths.indexOf(nm)]
    expect(Math.abs(at(a, 348) - at(b, 348))).toBeLessThan(0.01)
    expect(at(b, 400)).toBeGreaterThan(10 * at(a, 400))
  })

  it("finds ANS's two bands, near 260 and 350 nm", () => {
    const k = bench({ ans: [{ substance: 'bio:ans', conc: '50 uM' }] })
    const o = run(k, { instrument: 'uv', subject: 'ans', mode: 'scan', from: '240 nm', to: '450 nm' })
    expect(o.maxima).toHaveLength(2)
    expect(Math.abs(o.maxima[0] - 260)).toBeLessThan(6)
    expect(Math.abs(o.maxima[1] - 350)).toBeLessThan(6)
  })
})

describe('fluorescence', () => {
  it('binds by exact single-class binding', () => {
    expect(boundLigand(1e-6, 1e-3, 1e-6)).toBeCloseTo(1e-6 * (1e-3 / (1e-3 + 1e-6)), 9)
    expect(boundLigand(1e-3, 1e-6, 1e-9)).toBeCloseTo(1e-6, 9)
  })

  it('ANS is nearly dark in water and lights up, blue-shifted, on BSA', () => {
    const k = bench({ free: [{ substance: 'bio:ans', conc: '5 uM' }], bound: [{ substance: 'bio:ans', conc: '5 uM' }, { substance: 'bio:bovine-serum-albumin', conc: '20 uM' }] })
    const f = run(k, { instrument: 'fl', subject: 'free', wavelength: '350 nm', from: '380 nm', to: '650 nm' })
    const b = run(k, { instrument: 'fl', subject: 'bound', wavelength: '350 nm', from: '380 nm', to: '650 nm' })
    expect(b.intensityMax).toBeGreaterThan(30 * f.intensityMax)
    expect(f.emissionMax - b.emissionMax).toBeGreaterThan(30)
  })

  it('a strongly absorbing solution gives less light than its concentration suggests (inner filter)', () => {
    const k = bench({ low: [{ substance: 'bio:ans', conc: '10 uM' }, { substance: 'bio:bovine-serum-albumin', conc: '100 uM' }], high: [{ substance: 'bio:ans', conc: '200 uM' }, { substance: 'bio:bovine-serum-albumin', conc: '2 mM' }] })
    const lo = run(k, { instrument: 'fl', subject: 'low', wavelength: '350 nm', from: '380 nm', to: '650 nm' }).intensityMax
    const hi = run(k, { instrument: 'fl', subject: 'high', wavelength: '350 nm', from: '380 nm', to: '650 nm' }).intensityMax
    expect(hi / lo).toBeLessThan(10)
  })

  it('refuses a plastic cuvette and an emission scan that starts at the excitation', () => {
    const plastic = bench({ c: [{ substance: 'bio:ans', conc: '5 uM' }] }, 'core:cuvette-ps-1cm')
    const r = plastic.execute({ op: 'core:measure', params: { instrument: 'fl', subject: 'c', wavelength: '350 nm', from: '380 nm', to: '650 nm' } })
    expect(r.ok ? '' : r.refusal.code).toBe('NOT-QUARTZ')
    const k = bench({ c: [{ substance: 'bio:ans', conc: '5 uM' }] })
    const s = k.execute({ op: 'core:measure', params: { instrument: 'fl', subject: 'c', wavelength: '350 nm', from: '350 nm', to: '650 nm' } })
    expect(s.ok ? '' : s.refusal.code).toBe('OVERLAP')
  })
})

describe('conformance: ANS and serum albumin', () => {
  it('rehearses for several seeds', () => {
    const def = readJson(join(PACKAGES, 'pack-biochemistry', 'definitions', 'bio25-ans-albumin-fluorescence.labx.json')) as ExperimentDefinition
    for (const seed of [1, 2]) {
      const r = compile(def, cat, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
    }
  }, 300000)
})

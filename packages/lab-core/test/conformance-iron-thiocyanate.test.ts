// An equilibrium constant by colorimetry: FeSCN²⁺ calibrated in excess Fe³⁺, then measured in
// mixtures. The complexation model sets every absorbance, so the classic bias of the method (the
// standards are not quite fully complexed) appears, and shrinks as the excess grows.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { complexSystemIn, speciate } from '../src/models/complexation.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const fescn = readJson(join(PACKAGES, 'pack-chemistry', 'definitions', 'chem11-iron-thiocyanate-equilibrium.labx.json')) as ExperimentDefinition
type Result = ReturnType<typeof compile>
const meanK = (r: Result) => r.kernel!.world.notebook.find((e) => e.field === 'Kc-mean')!.value as number
const withStandardIron = (conc: string) => {
  const def = structuredClone(fescn)
  def.materials!.supplies!.find((s) => s.id === 'fe-high')!.contains![0].conc = conc
  return compile(def, catalogue, { seed: 1 })
}

describe('conformance: the iron(III) thiocyanate equilibrium constant', () => {
  it('speciation matches the quadratic for one mixture: x / ((a − x)(b − x)) = K', () => {
    const cs = complexSystemIn(catalogue, { volumeL: 0.01, species: { 'chem:iron-iii-nitrate': 1e-5, 'chem:potassium-thiocyanate': 6e-6 } })!
    const x = speciate(cs, 1).bound['chem:potassium-thiocyanate']['Fe3+'] * 6e-4
    expect(x / ((1e-3 - x) * (6e-4 - x))).toBeCloseTo(138, 0)
  })

  it('rehearses for several seeds: a constant Kc, a little above the true 138', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(fescn, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(meanK(r)).toBeGreaterThan(140)
      expect(meanK(r)).toBeLessThan(170)
    }
  }, 120000)

  it('a larger excess of iron in the standards removes most of the bias', () => {
    expect(Math.abs(meanK(withStandardIron('1.0 mol/L')) - 138) / 138).toBeLessThan(0.05)
  }, 60000)

  it('too little iron in the standards leaves much of the thiocyanate free: Kc comes out far too high', () => {
    expect(meanK(withStandardIron('0.02 mol/L'))).toBeGreaterThan(250)
  }, 60000)
})

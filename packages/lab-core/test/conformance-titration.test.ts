// Conformance experiment outside biochemistry: standardising NaOH with KHP (analytical chemistry).
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { parseValue } from '../src/units/quantity.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const def = readJson(join(PACKAGES, 'pack-chemistry', 'definitions', 'chem1-naoh-standardisation.labx.json')) as ExperimentDefinition

const reported = (r: ReturnType<typeof compile>) =>
  parseValue(String(r.kernel!.world.notebook.find((e) => e.field === 'report:conc:naoh-soln')!.value)).si / 1000
const truth = (r: ReturnType<typeof compile>) => parseValue(String(r.definition!.materials!.supplies!.find((s) => s.id === 'naoh-soln')!.contains![0].conc)).si / 1000

describe('conformance: NaOH standardisation by titration', () => {
  it('validates without findings', () => {
    const r = compile(def, catalogue, { rehearse: false })
    expect(r.validation.findings.filter((f) => f.severity !== 'info')).toEqual([])
  })

  for (const seed of [1, 2, 3, 4]) {
    it(`finds the hydroxide concentration within 0.5 % (seed ${seed})`, () => {
      const r = compile(def, catalogue, { seed })
      expect(r.rehearsal!.issues).toEqual([])
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(Math.abs(reported(r) / truth(r) - 1)).toBeLessThan(0.005)
    })
  }

  it('an undried primary standard biases the result high (it weighs more than it reacts)', () => {
    const wet = structuredClone(def)
    wet.materials!.supplies!.find((s) => s.id === 'khp-solid')!.contains![0].purity = '97 %'
    const dry = compile(def, catalogue, { seed: 2, realism: 'ideal' })
    const r = compile(wet, catalogue, { seed: 2, realism: 'ideal' })
    // 3 % of the weighed mass does not react: the titre is 3 % short, so c comes out 3 % high.
    expect(reported(r) / reported(dry)).toBeGreaterThan(1.02)
    expect(reported(r) / reported(dry)).toBeLessThan(1.04)
    expect(r.rehearsal!.goals.find((g) => g.id === 'g-conc')!.passed).toBe(false)
  })

  it('adding titrant in big steps near the end point overshoots it', () => {
    const fast = structuredClone(def)
    const titrate = fast.procedure!.steps!.find((s) => s.id === 'accurate')!.steps!.find((s) => s.id === 'titrate')!
    titrate.params!.drop = '0.6 mL'
    const careful = compile(def, catalogue, { seed: 3, realism: 'ideal' })
    const r = compile(fast, catalogue, { seed: 3, realism: 'ideal' })
    // Too much titrant: larger titres, so a lower apparent concentration.
    expect(reported(r)).toBeLessThan(reported(careful))
  })
})

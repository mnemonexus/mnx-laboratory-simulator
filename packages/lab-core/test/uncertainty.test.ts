// Uncertainty budgets: the law of propagation of uncertainty, and its use in the NaOH
// standardisation, where the burette usually limits the result and a poor balance takes over.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { propagateUncertainty } from '../src/analysis/analysis.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const naoh = readJson(join(PACKAGES, 'pack-chemistry', 'definitions', 'chem1-naoh-standardisation.labx.json')) as ExperimentDefinition
type Result = ReturnType<typeof compile>
const noted = (r: Result, field: string) => r.kernel!.world.notebook.find((e) => e.field === field)?.value

describe('propagation of uncertainty', () => {
  it('for a quotient, relative uncertainties add in quadrature', () => {
    // f = a / b with a = 10 ± 0.3 and b = 4 ± 0.08: u(f)/f = √(0.03² + 0.02²).
    const b = propagateUncertainty(([da, db]) => (10 + da) / (4 + db), [0.3, 0.08])
    expect(b.value).toBeCloseTo(2.5, 12)
    expect(b.u / b.value).toBeCloseTo(Math.hypot(0.03, 0.02), 5)
    expect(b.dominant).toBe(0)
    // A central difference of ± u differs from the derivative at second order, as GUM accepts.
    expect(b.contributions[0].share).toBeCloseTo(0.03 ** 2 / (0.03 ** 2 + 0.02 ** 2), 3)
  })

  it('an input with no uncertainty contributes nothing', () => {
    const b = propagateUncertainty(([dx, dy]) => (2 + dx) * (3 + dy), [0.1, 0])
    expect(b.u).toBeCloseTo(0.3, 9)
    expect(b.contributions[1].share).toBe(0)
  })
})

describe('the NaOH standardisation’s uncertainty budget', () => {
  it('the burette dominates, and the relative uncertainty is under 0.3 %', () => {
    for (const seed of [1, 2]) {
      const r = compile(naoh, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(noted(r, 'dominant-source')).toBe('V')
      expect(noted(r, 'relative-u') as number).toBeLessThan(0.003)
    }
  }, 120000)

  it('with a two-decimal balance (±2 mg by difference), the mass takes over', () => {
    const def = structuredClone(naoh)
    const budget = def.procedure!.steps!.find((s) => s.id === 'budget')!
    ;(budget.params!.uncertainties as Record<string, unknown>).m = '0.0024 g'
    const r = compile(def, catalogue, { seed: 1 })
    expect(noted(r, 'dominant-source')).toBe('m')
    expect(r.run!.decisions.limits).toBe('balance')
  }, 120000)
})

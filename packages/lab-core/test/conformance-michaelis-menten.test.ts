// Conformance: KM and Vmax of a high-activity alkaline phosphatase from a substrate series, by a
// double-reciprocal plot and a direct fit. Consequence: an enzyme with a higher KM gives a higher
// fitted KM (the result comes from the simulated rates, not the definition).
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())
const def = readJson(join(PACKAGES, 'pack-biochemistry', 'definitions', 'bio19-michaelis-menten-from-rates.labx.json')) as ExperimentDefinition
const recorded = (r: ReturnType<typeof compile>, field: string) => r.kernel!.world.notebook.find((e) => e.field === field)?.value as number

describe('conformance: KM and Vmax from initial rates', () => {
  it('rehearses for several seeds, both fits near the enzyme\'s KM', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(def, cat, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
      expect(recorded(r, 'km-lb')).toBeGreaterThan(0.06)
      expect(recorded(r, 'km-lb')).toBeLessThan(0.17)
    }
  }, 600000)

  it('an enzyme with four times the KM is fitted with about four times the KM', () => {
    const packs = loadAllPacks()
    for (const p of packs) for (const s of p.substances ?? []) if (s.id === 'bio:alkaline-phosphatase-high-activity' && s.enzyme) s.enzyme.km = { 'bio:pnpp': '0.4 mM' }
    const { catalogue: slower } = Catalogue.build(packs)
    const r = compile(def, slower, { seed: 1 })
    expect(recorded(r, 'km-mm')).toBeGreaterThan(0.3)
    expect(recorded(r, 'km-mm')).toBeLessThan(0.55)
  }, 300000)
})
